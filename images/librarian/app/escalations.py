"""Escalations to a human, and their answers (Plan 2 Task 6).

Called once per service tick (`sync(svc)`), after the run and the executor
and before the notifier flush. Every arrival that needs a decision
(`needs-decision`, with a finalized escalation -- `IntentBook.latest_escalation`)
becomes one Vikunja task; the human answers by commenting on it; the reply
moves the arrival to `answered` so the next librarian run acts on it; and
the task is closed with the outcome once the arrival is terminal.

  1. needs-decision, no open task -> create the task (question, numbered
     options with the concrete action each one would take, recommendation,
     arrival key, BookOrbit links), record `vikunja_task_id`,
     `vikunja_url`, `vikunja_last_seen=None` and `vikunja_intent` (the
     escalation the task is asking) on the arrival, then enqueue the
     escalation push (`svc.notify_escalation`, which carries the task URL).
     A task that was already closed is never reused: a new one is created.
  2. needs-decision with an open task asking an OLDER escalation (the next
     run, or the executor, escalated again) -> post the new question as a
     comment; replies are then only read after that comment.
  3. needs-decision with an open task -> the FIRST reply newer than
     `vikunja_last_seen` makes the arrival `answered` with `human_answer`
     in the Global shape `{text, option, option_intent, choice,
     comment_id}` (see `parse_answer`), and is acknowledged with a comment.
     An `answered` arrival is not polled, so further replies before the run
     change nothing; the LLM run sees `human_answer` (untrusted) through
     `GET /arrivals/{key}`, and guards 7/10 honour it only for the exact
     option intent selected (app/policy.py `human_answer_matches`).
  4. filed / failed / duplicate / simulated with an open task -> comment
     the outcome and mark the task done, once (`vikunja_closed=True`).

A "reply" is any comment the librarian did not post itself (app/vikunja.py):
that includes comments posted through vikunja-mcp by Claude sessions, which
act as the same user -- a Claude session asked to answer an escalation
answers it exactly as if it had been typed in the Vikunja UI.

HTTP never runs under `svc.lock`; each result is recorded under it, after
re-reading the arrival (nothing else changes these fields, but a record
must never be built from a stale snapshot). At most `MAX_WRITES_PER_TICK`
Vikunja writes (task, comment, close = comment + update) per tick; the
rest wait for the next tick. A failed call is logged once per (arrival,
error) and retried next tick. At-least-once edges: a crash between creating
a task and recording its id creates a second task on restart; a crash
between the closing comment and marking done repeats that comment.

With no Vikunja client (VIKUNJA_ENABLED false, or incompletely configured)
the escalation push is sent right away instead, once per escalation
(`escalation_notified` on the arrival).
"""
import logging
import re

from app import states
from app.logutil import log_safe
from app.policy import _LIBRARY_NAMES  # adult/kids -> BookOrbit library name
from app.vikunja import VikunjaError

logger = logging.getLogger(__name__)

MAX_WRITES_PER_TICK = 10
TITLE_MAX = 80
MAX_LINKS = 10
TERMINAL = frozenset({states.FILED, states.FAILED, states.DUPLICATE, states.SIMULATED})

_OPTION_RE = re.compile(r"^\s*(\d{1,3})(?!\d)")
_WS = re.compile(r"\s+")


# --- pure helpers ------------------------------------------------------------------------


def _flat(value, limit: int) -> str:
    """Untrusted text on ONE line (so it can never forge an option line of
    its own), capped. HTML escaping happens in app/vikunja.py."""
    text = _WS.sub(" ", str(value if value is not None else "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def describe_action(intent, index=None) -> str:
    """What selecting an option would actually do, in words -- built from
    the option's intent, never from its (LLM-authored) label."""
    if intent is None:
        return "no automatic action: the librarian leaves it for you"
    if not isinstance(intent, dict):
        return "unrecognised action (does not unlock anything)"
    kind = intent.get("kind")
    if kind in (states.ATTACH, states.UPDATE_METADATA):
        book_id = _int(intent.get("book_id"))
        book = index.book(book_id) if (index is not None and book_id is not None) else None
        what = ""
        if book:
            authors = ", ".join(str(a.get("name") or "") if isinstance(a, dict) else str(a)
                                for a in (book.get("authors") or []))
            what = f" (\"{_flat(book.get('title'), 120)}\"{' by ' + _flat(authors, 80) if authors else ''}" \
                   f", {_flat(book.get('libraryName'), 40)})"
        verb = "attach this arrival to" if kind == states.ATTACH else "update the metadata of"
        return f"{verb} BookOrbit book {book_id}{what}"
    if kind == states.CREATE_BOOK:
        md = intent.get("metadata") if isinstance(intent.get("metadata"), dict) else {}
        authors = md.get("authors") if isinstance(md.get("authors"), list) else []
        library = _LIBRARY_NAMES.get(intent.get("library"), f"unknown library {intent.get('library')!r}")
        series = ""
        if md.get("series"):
            series = f", series \"{_flat(md.get('series'), 80)}\""
            if md.get("seriesIndex") is not None:
                series += f" #{_flat(md.get('seriesIndex'), 10)}"
        return (f"create a new book \"{_flat(md.get('title'), 120)}\" by "
                f"{_flat(', '.join(str(a) for a in authors), 80)}{series} in {library}")
    if kind == states.DEFER:
        return f"wait {_flat(intent.get('not_before_hours'), 10)}h, then look again"
    return f"{_flat(kind, 40)} (not a filing)"


def _book_ids(payload: dict, dossier) -> list:
    ids = []
    for opt in payload.get("options") or []:
        intent = opt.get("intent") if isinstance(opt, dict) else None
        if isinstance(intent, dict) and _int(intent.get("book_id")) is not None:
            ids.append(intent["book_id"])
    for c in (dossier or {}).get("candidates") or []:
        bid = _int(((c or {}).get("book") or {}).get("id")) if isinstance(c, dict) else None
        if bid is not None:
            ids.append(bid)
    out = []
    for b in ids:
        if b not in out:
            out.append(b)
    return out[:MAX_LINKS]


def question_text(payload: dict, key: str, *, dossier=None, index=None, bookorbit_url="") -> str:
    """The plain-text body of an escalation (task description, or the
    comment for a follow-up escalation on the same task)."""
    lines = [_flat(payload.get("question"), 1500) or "(no question given)", "", "Options:"]
    for n, opt in enumerate(payload.get("options") or [], 1):
        opt = opt if isinstance(opt, dict) else {}
        lines.append(f"{n}. {_flat(opt.get('label'), 200)} -- {describe_action(opt.get('intent'), index)}")
    lines += ["", f"Recommendation: {_flat(payload.get('recommendation'), 300)}",
              f"Arrival: {_flat(key, 300)}"]
    ids = _book_ids(payload, dossier) if bookorbit_url else []
    if ids:
        lines.append("BookOrbit:")
        base = bookorbit_url.rstrip("/")
        lines += [f"book {b}: {base}/books/{b}" for b in ids]
    lines += ["", "Reply with the option number or a short instruction."]
    return "\n".join(lines)


def task_title(rec: dict) -> str:
    hint = _flat(rec.get("title_hint") or rec.get("key") or "arrival", 200)
    title = f"Librarian: {hint}"
    return title if len(title) <= TITLE_MAX else title[: TITLE_MAX - 1].rstrip() + "…"


def parse_answer(reply: dict, options) -> dict:
    """A reply comment -> `human_answer` (Global "Human answer shape").
    `option` is the 1-based number the reply starts with, if it indexes an
    option; `option_intent` is that option's intent (None for an option
    without one, e.g. "Leave it for me", and for free text); `choice` is
    "kids" for a kids create_book, "option" for any other option intent,
    else None."""
    text = str(reply.get("text") or "")[:2000]
    options = options if isinstance(options, list) else []
    option = option_intent = None
    m = _OPTION_RE.match(text)
    if m:
        n = int(m.group(1))
        if 1 <= n <= len(options):
            option = n
            opt = options[n - 1] if isinstance(options[n - 1], dict) else {}
            option_intent = opt.get("intent") if isinstance(opt.get("intent"), dict) else None
    if option_intent is None:
        choice = None
    elif option_intent.get("kind") == states.CREATE_BOOK and option_intent.get("library") == "kids":
        choice = "kids"
    else:
        choice = "option"
    return {"text": text, "option": option, "option_intent": option_intent, "choice": choice,
            "comment_id": reply.get("id")}


def outcome_text(rec: dict, bookorbit_url: str = "") -> str:
    st = rec.get("state")
    book_id = _int(rec.get("book_id"))
    link = f": {bookorbit_url.rstrip('/')}/books/{book_id}" if (bookorbit_url and book_id is not None) else ""
    if st == states.FILED:
        return f"Filed into BookOrbit book {book_id}{link}. Closing."
    if st == states.DUPLICATE:
        return f"Duplicate: this file is already in book {book_id}{link}. Nothing filed. Closing."
    if st == states.FAILED:
        return f"Filing failed: {_flat(rec.get('error') or rec.get('detail') or 'unknown error', 600)}. Closing."
    if st == states.SIMULATED:
        wd = "; ".join(_flat(x, 200) for x in (rec.get("would_do") or []))
        return f"Dry run -- nothing was changed. Would do: {wd or 'nothing'}. Closing."
    return f"Finished ({_flat(st, 40)}). Closing."


# --- the tick --------------------------------------------------------------------------


class _Budget:
    def __init__(self, n):
        self.left = n

    def take(self, n=1) -> bool:
        if self.left < n:
            return False
        self.left -= n
        return True


def _log_once(svc, key, msg) -> None:
    seen = svc.__dict__.setdefault("_vikunja_errors", set())
    if (key, msg) not in seen:
        seen.add((key, msg))
        logger.warning("Vikunja: arrival %s: %s (retried next tick)", log_safe(key), log_safe(msg))


def _annotate(svc, key, **fields):
    """Add fields to the arrival, keeping its CURRENT state (re-read under
    the lock). Returns the new record."""
    with svc.lock:
        cur = svc.arrivals.get(key)
        if cur is None:
            return None
        return svc.arrivals.record(key, cur["state"], **fields)


def sync(svc) -> None:
    if svc.vikunja is None:
        _push_only(svc)
        return
    budget = _Budget(MAX_WRITES_PER_TICK)
    for rec in svc.arrivals.by_state(states.NEEDS_DECISION):
        if svc.stopping():
            return
        _open(svc, rec, budget)
    for rec in svc.arrivals.all():
        if svc.stopping():
            return
        if (rec.get("vikunja_task_id") and not rec.get("vikunja_closed")
                and rec.get("state") in TERMINAL):
            if not budget.take(2):
                return
            _close(svc, rec)


def _push_only(svc) -> None:
    if svc.notifier is None:
        return
    for rec in svc.arrivals.by_state(states.NEEDS_DECISION):
        esc = svc.intents.latest_escalation(rec["key"])
        if esc is None or rec.get("escalation_notified") == esc["intent_id"]:
            continue
        svc.notify_escalation(rec, esc)
        _annotate(svc, rec["key"], escalation_notified=esc["intent_id"])


def _content(svc, rec, esc) -> str:
    return question_text(esc["payload"], rec["key"], dossier=svc.load_dossier(rec["key"]),
                         index=svc.index, bookorbit_url=svc.settings.bookorbit_public_url)


def _open(svc, rec, budget) -> None:
    key = rec["key"]
    esc = svc.intents.latest_escalation(key)
    if esc is None:
        return
    tid = rec.get("vikunja_task_id")
    if not tid or rec.get("vikunja_closed"):
        if not budget.take():
            return
        try:
            tid, url = svc.vikunja.create_task(task_title(rec), _content(svc, rec, esc))
        except VikunjaError as e:
            _log_once(svc, key, f"creating the task failed: {e}")
            return
        new = _annotate(svc, key, vikunja_task_id=tid, vikunja_url=url, vikunja_last_seen=None,
                        vikunja_intent=esc["intent_id"], vikunja_closed=False)
        logger.info("arrival %s: Vikunja task %s created", log_safe(key), tid)
        svc.notify_escalation(new or rec, esc)
        return
    if rec.get("vikunja_intent") != esc["intent_id"]:
        if not budget.take():
            return
        try:
            cid = svc.vikunja.comment(tid, "New question:\n" + _content(svc, rec, esc))
        except VikunjaError as e:
            _log_once(svc, key, f"posting the new question failed: {e}")
            return
        new = _annotate(svc, key, vikunja_intent=esc["intent_id"], vikunja_last_seen=cid)
        svc.notify_escalation(new or rec, esc)
        return
    try:
        replies = svc.vikunja.replies(tid, rec.get("vikunja_last_seen"))
    except VikunjaError as e:
        _log_once(svc, key, f"reading replies failed: {e}")
        return
    if not replies:
        return
    reply = replies[0]
    answer = parse_answer(reply, esc["payload"].get("options"))
    with svc.lock:
        cur = svc.arrivals.get(key) or {}
        if (cur.get("state") != states.NEEDS_DECISION or cur.get("vikunja_task_id") != tid
                or cur.get("vikunja_intent") != esc["intent_id"]):
            return
        svc.arrivals.record(key, states.ANSWERED, human_answer=answer, vikunja_last_seen=reply["id"],
                            detail=f"answered in Vikunja (comment {reply['id']})")
    logger.info("arrival %s answered in Vikunja (option %s)", log_safe(key), answer["option"])
    if budget.take():
        if answer["option"] is not None:
            opt = esc["payload"]["options"][answer["option"] - 1]
            label = _flat(opt.get("label") if isinstance(opt, dict) else "", 200)
            ack = f"Got it: option {answer['option']} ({label}). The librarian acts on it at its next run."
        else:
            ack = "Got it. The librarian reads your instruction at its next run."
        try:
            svc.vikunja.comment(tid, ack)
        except VikunjaError as e:
            _log_once(svc, key, f"acknowledging the reply failed: {e}")


def _close(svc, rec) -> None:
    key = rec["key"]
    try:
        svc.vikunja.close(rec["vikunja_task_id"], outcome_text(rec, svc.settings.bookorbit_public_url))
    except VikunjaError as e:
        _log_once(svc, key, f"closing the task failed: {e}")
        return
    _annotate(svc, key, vikunja_closed=True)
    logger.info("arrival %s: Vikunja task %s closed (%s)", log_safe(key), rec["vikunja_task_id"],
                rec.get("state"))
