"""Apprise notifier: durable outbox, retried until HTTP 200 (Plan 2 Task 5).

The core (never the LLM) pushes three kinds of message: one `summary` per
run that did anything, one `escalation` per human decision needed, and one
`failure` per filing the executor gave up on. Every push is first appended
to a durable outbox (`app/store.py`'s `Store`, keyed `msg_id`) -- a crash
between enqueue and a successful HTTP 200 just leaves the message `pending`,
and the next `flush()` (any process, after a restart too) retries it. A
message is never re-queued once its `msg_id` already exists in the outbox
(`enqueue` is idempotent), so a caller may call it every tick for the same
logical event without duplicating the push.

At-least-once, not exactly-once (fix round 1): a crash between the Apprise
server returning HTTP 200 and this process recording the outbox entry as
`sent` (a real window -- the record only happens after `_send` returns)
replays that one message on the next `flush()`, so the human can see one
push twice. There is no way to make this exactly-once without a
transactional handshake Apprise doesn't offer; duplicating a push is far
cheaper than losing one, so the outbox is written AFTER delivery succeeds,
never before.

Delivery: POST `{"title", "body", "format": "text"}` as JSON to the Apprise
stateful-key URL -- plain text, not markdown, so an untrusted title or
question (LLM- or filename-derived) can never render as a clickable link.
Only HTTP 200 counts as delivered -- 429, 5xx, a network error, or any
other status leaves the message `pending` with `attempts` incremented and
`next_at` pushed out (`min(60 * 2**attempts, 3600)`, i.e. exponential
backoff capped at an hour). After `MAX_ATTEMPTS` (20) failed attempts the
message is marked `failed` for good, `librarian_notify_failures_total` is
incremented, and it is logged once (it naturally never happens again:
`failed` is a terminal state, not retried). A network-error log line never
includes the exception's own message (fix round 1: it can embed the
Apprise URL, which carries a secret stateful key) -- only the exception's
type name, and the HTTP status code when there is one (never secret).

`dry_run` is tied to the SERVICE's own DRY_RUN, not an independent knob
(fix round 1, controller ruling): a dry-run escalation isn't actionable
(nothing was really filed, and Task 6's Vikunja integration is itself
disabled by default in dry-run), so there is nothing a live push would let
a human do differently. main.py wires `Notifier(dry_run=settings.dry_run)`
accordingly. In dry-run every pending message is marked `sent` with
`dry_run: true` and logged ("would notify: <title>") instead of making an
HTTP call.

`flush()` also takes `stopping` (a no-arg callable, default never-stopping)
and `beat` (a no-arg callable, default no-op) -- `Service` overwrites both
after construction with its own `stopping`/`metrics.beat` (fix round 1),
so a flush spanning many messages checks the stop flag between each one
(never starts a new send while the service is shutting down, matching
`execution.run_due`'s pattern) and keeps the liveness heartbeat fresh
across a slow run of sends, the same way a long `claude -p` run does.
"""
import logging
import time

from app import metrics
from app.store import Store

logger = logging.getLogger(__name__)

PENDING = "pending"
SENT = "sent"
FAILED = "failed"
OUTBOX_STATES = frozenset({PENDING, SENT, FAILED})

MAX_BYTES = 1800           # title+body combined cap (controller ruling)
MAX_ATTEMPTS = 20
_BACKOFF_BASE = 60
_BACKOFF_CAP = 3600
_ELLIPSIS = "…"

# Fix round 1: sent/failed outbox records are pruned once older than this,
# on the same cadence (every tick) as app/service.py's transcript pruning.
OUTBOX_MAX_AGE = 30 * 86400


def sanitize(text) -> str:
    """Strip control characters except `\\n` from attacker/LLM-influenced
    text before it ever reaches a push notification."""
    return "".join(ch for ch in str(text) if ch == "\n" or ch.isprintable())


def _valid_utf8_prefix(raw: bytes, max_bytes: int) -> str:
    """The longest validly-decodable UTF-8 string within the first
    `max_bytes` bytes of `raw`. Never splits a multi-byte sequence."""
    cut = raw[: max(0, max_bytes)]
    while cut:
        try:
            return cut.decode("utf-8")
        except UnicodeDecodeError:
            cut = cut[:-1]
    return ""


def truncate_utf8(text: str, max_bytes: int) -> str:
    """Truncate `text` to AT MOST `max_bytes` UTF-8 bytes, appending an
    ellipsis when it was cut -- unless `max_bytes` is too small to hold the
    ellipsis itself (fix round 1: the old version returned the 3-byte
    ellipsis alone even for a 1- or 2-byte budget, silently exceeding it),
    in which case this hard-cuts with no ellipsis at all. Never splits a
    multi-byte UTF-8 sequence; the result is always <= max_bytes bytes."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    if max_bytes <= 0:
        return ""
    ell_bytes = len(_ELLIPSIS.encode("utf-8"))
    if max_bytes < ell_bytes:
        return _valid_utf8_prefix(raw, max_bytes)
    return _valid_utf8_prefix(raw, max_bytes - ell_bytes) + _ELLIPSIS


def cap(title: str, body: str, max_bytes: int = MAX_BYTES) -> tuple[str, str]:
    """Sanitize both fields, then cap title+body COMBINED at `max_bytes`
    UTF-8 bytes. The body is truncated first to make room (callers keep
    titles short by construction -- e.g. the escalation title is already
    capped at 60 characters -- so in practice only the body ever needs
    it), but a title that is ITSELF over budget is truncated too (fix
    round 1: previously an oversized title alone could exceed max_bytes,
    since only the body was ever touched) -- the combined result is always
    <= max_bytes bytes."""
    title = sanitize(title)
    body = sanitize(body)
    if len(title.encode("utf-8")) > max_bytes:
        title = truncate_utf8(title, max_bytes)
    remaining = max(0, max_bytes - len(title.encode("utf-8")))
    if len(body.encode("utf-8")) > remaining:
        body = truncate_utf8(body, remaining)
    return title, body


class Notifier:
    def __init__(self, url: str, outbox: Store, session=None, dry_run: bool = False,
                clock=time.time, stopping=lambda: False, beat=lambda: None):
        self.url = url
        self.outbox = outbox
        self._session = session
        self.dry_run = dry_run
        self.clock = clock
        self.stopping = stopping
        self.beat = beat

    @property
    def session(self):
        if self._session is None:
            import requests  # local import: not needed at all in dry-run-only tests
            self._session = requests
        return self._session

    def enqueue(self, kind: str, msg_id: str, title: str, body: str) -> None:
        """Queue a push, durably. Idempotent on `msg_id` -- a message that
        was already enqueued (pending, sent, or failed) is left untouched,
        so a caller may enqueue the same logical event every tick."""
        if self.outbox.get(msg_id) is not None:
            return
        title, body = cap(title, body)
        self.outbox.record(msg_id, PENDING, kind=kind, title=title, body=body, attempts=0, next_at=0.0)

    def flush(self, max_per_tick: int = 10) -> tuple[int, int]:
        """Send due pending messages, in enqueue order, up to
        `max_per_tick`. Checks `self.stopping()` between messages (never
        starts a new one once the service is shutting down) and calls
        `self.beat()` after each one (keeps liveness fresh across a slow
        run of sends). Returns (sent, failed) counts for THIS call --
        messages that stayed pending (a transient failure) count as
        neither."""
        now = self.clock()
        sent = failed = 0
        tried = 0
        for rec in self.outbox.by_state(PENDING):
            if tried >= max_per_tick or self.stopping():
                break
            if self.dry_run:
                self._mark_dry_sent(rec)
                sent += 1
                tried += 1
                self.beat()
                continue
            next_at = rec.get("next_at") or 0
            if isinstance(next_at, (int, float)) and next_at > now:
                continue
            tried += 1
            ok = self._send(rec)
            self.beat()
            if ok:
                self.outbox.record(rec["msg_id"], SENT)
                sent += 1
            elif self._record_failure(rec, now):
                failed += 1
        return sent, failed

    def prune(self, now: float | None = None, max_age: float = OUTBOX_MAX_AGE) -> int:
        """Compact away terminal (sent/failed) records older than
        `max_age` -- `pending` records are always kept, however old.

        Ages against real wall-clock time (`time.time()`), not
        `self.clock` -- `Store.record` always stamps `ts` with the real
        clock regardless of any clock injected into this Notifier (e.g. in
        tests), so comparing against anything else could drift from what
        `ts` actually means."""
        cutoff = (time.time() if now is None else now) - max_age

        def keep(rec: dict) -> bool:
            return rec.get("state") == PENDING or (rec.get("ts") or 0) >= cutoff

        return self.outbox.compact(keep)

    # --- internals -----------------------------------------------------------

    def _mark_dry_sent(self, rec: dict) -> None:
        logger.info("would notify: %s", rec.get("title"))
        self.outbox.record(rec["msg_id"], SENT, dry_run=True)

    def _send(self, rec: dict) -> bool:
        payload = {"title": rec.get("title", ""), "body": rec.get("body", ""), "format": "text"}
        try:
            resp = self.session.post(self.url, json=payload, timeout=10)
        except Exception as e:
            # Fix round 1: never log str(e) -- a connection/timeout error's
            # own message commonly embeds the request URL, which here
            # carries the Apprise stateful key (a secret). The exception's
            # type name is all that's safe.
            logger.warning("notify %s: request failed: %s", rec.get("msg_id"), type(e).__name__)
            return False
        status = getattr(resp, "status_code", None)
        if status != 200:
            logger.warning("notify %s: unexpected status %s", rec.get("msg_id"), status)
        return status == 200

    def _record_failure(self, rec: dict, now: float) -> bool:
        """Bump attempts; terminal `failed` at MAX_ATTEMPTS. Returns True
        iff this call is what made it terminal (for the caller's `failed`
        count -- and so the metric/log fire exactly once)."""
        msg_id = rec["msg_id"]
        attempts = int(rec.get("attempts") or 0) + 1
        if attempts >= MAX_ATTEMPTS:
            self.outbox.record(msg_id, FAILED, attempts=attempts)
            metrics.NOTIFY_FAILURES.inc()
            logger.error("notify %s: giving up after %d attempts", msg_id, attempts)
            return True
        next_at = now + min(_BACKOFF_BASE * 2 ** attempts, _BACKOFF_CAP)
        self.outbox.record(msg_id, PENDING, attempts=attempts, next_at=next_at)
        return False
