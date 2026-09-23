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

Delivery: POST `{"title", "body", "format": "markdown"}` as JSON to the
Apprise stateful-key URL. Only HTTP 200 counts as delivered -- 429, 5xx, a
network error, or any other status leaves the message `pending` with
`attempts` incremented and `next_at` pushed out (`min(60 * 2**attempts,
3600)`, i.e. exponential backoff capped at an hour). After
`MAX_ATTEMPTS` (20) failed attempts the message is marked `failed` for
good, `librarian_notify_failures_total` is incremented, and it is logged
once (it naturally never happens again: `failed` is a terminal state, not
retried).

In dry-run (a Notifier-level flag, independent of the service's own
DRY_RUN -- main.py wires them together, but a caller is free not to) every
pending message is marked `sent` with `dry_run: true` and logged
("would notify: <title>") instead of making an HTTP call.
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


def sanitize(text) -> str:
    """Strip control characters except `\\n` from attacker/LLM-influenced
    text before it ever reaches a push notification."""
    return "".join(ch for ch in str(text) if ch == "\n" or ch.isprintable())


def truncate_utf8(text: str, max_bytes: int) -> str:
    """Truncate `text` to at most `max_bytes` UTF-8 bytes, appending an
    ellipsis when it was cut. Never splits a multi-byte UTF-8 sequence."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    ell_bytes = len(_ELLIPSIS.encode("utf-8"))
    budget = max(0, max_bytes - ell_bytes)
    cut = raw[:budget]
    while cut:
        try:
            return cut.decode("utf-8") + _ELLIPSIS
        except UnicodeDecodeError:
            cut = cut[:-1]
    return _ELLIPSIS


def cap(title: str, body: str, max_bytes: int = MAX_BYTES) -> tuple[str, str]:
    """Sanitize both fields, then cap title+body COMBINED at `max_bytes`
    UTF-8 bytes by truncating the body only -- callers are expected to keep
    titles short on their own (e.g. the escalation title is already capped
    at 60 characters), so the body is what actually needs a hard limit."""
    title = sanitize(title)
    body = sanitize(body)
    remaining = max(0, max_bytes - len(title.encode("utf-8")))
    if len(body.encode("utf-8")) > remaining:
        body = truncate_utf8(body, remaining)
    return title, body


class Notifier:
    def __init__(self, url: str, outbox: Store, session=None, dry_run: bool = False,
                clock=time.time):
        self.url = url
        self.outbox = outbox
        self._session = session
        self.dry_run = dry_run
        self.clock = clock

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
        `max_per_tick`. Returns (sent, failed) counts for THIS call --
        messages that stayed pending (a transient failure) count as
        neither."""
        now = self.clock()
        sent = failed = 0
        tried = 0
        for rec in self.outbox.by_state(PENDING):
            if tried >= max_per_tick:
                break
            if self.dry_run:
                self._mark_dry_sent(rec)
                sent += 1
                tried += 1
                continue
            next_at = rec.get("next_at") or 0
            if isinstance(next_at, (int, float)) and next_at > now:
                continue
            tried += 1
            if self._send(rec):
                self.outbox.record(rec["msg_id"], SENT)
                sent += 1
            elif self._record_failure(rec, now):
                failed += 1
        return sent, failed

    # --- internals -----------------------------------------------------------

    def _mark_dry_sent(self, rec: dict) -> None:
        logger.info("would notify: %s", rec.get("title"))
        self.outbox.record(rec["msg_id"], SENT, dry_run=True)

    def _send(self, rec: dict) -> bool:
        payload = {"title": rec.get("title", ""), "body": rec.get("body", ""), "format": "markdown"}
        try:
            resp = self.session.post(self.url, json=payload, timeout=10)
        except Exception as e:
            logger.warning("notify %s: request failed: %s", rec.get("msg_id"), e)
            return False
        return getattr(resp, "status_code", None) == 200

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
