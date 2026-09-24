"""Live execution of approved filings (Plan 2 Task 4).

The service side of the executor: which approved intents execute, when,
how often, and what their outcome does to intent and arrival state. The
executor itself (app/executor.py) owns the file moves and BookOrbit writes.

Flow (Global "Crash-safe execution"): a cycle writes its run END record,
then `finalize` splits the offered arrivals by source -- `finalize_dry_run`
for sources not in LIVE_SOURCES (or all of them in DRY_RUN), and
`IntentBook.finalize_live` for the rest, which QUEUES each approved
attach/create_book: arrival `retryable`, `attempts=0`, `retry_at=now`,
`exec_intent=<intent id>`, intent still `approved`. `run_due` then executes
due queue entries, at most `max_exec_per_tick` per tick (the cycle's own
executions count against the same tick's budget), checking the stop flag
between executions. A queued/retryable arrival is never offered to the LLM
(`retryable` is not OFFERABLE) -- the tick re-executes it once `retry_at`
passes.

Before any execution whose file has not yet reached the library (no open
or moved journal): the intent is re-checked with `check_intent` against a
freshly refreshed index, freshly loaded KidsLists and the stored dossier
(guards 1, 4, 5, 7, 8, 10 -- guard 6 is per-run and moot here; the run's
seen-id set is gone, so the intent's own book_id stands in for it -- the
existence half of guard 1 still applies), and the intake primary is
re-hashed against `arrival.sha256`. A guard refusal -> intent `exec-failed`,
arrival `needs-decision` + auto-escalation; a missing dossier or a
missing/changed primary ->
intent `exec-failed`, arrival `failed` + escalation. After the move the
checks are skipped (our own file now sits in the book, and the primary is
gone) and `execute()` with the same intent resumes the journal.

Locking: records are read under `svc.lock`, the executor runs outside it,
and results are recorded under it again.

Outcomes: `filed` -> intent `executed`, arrival `filed` (book_id, sha256 --
the source of classify's `filed_hashes`), then the same run's approved
update_metadata via `execute_update`; `ExecResult.escalate` adds an
escalation but the filing stands. `retryable` -> attempts+1 and
`retry_at = now + retry_after * 2**(attempts-1)` capped at 24 h; at
`max_attempts` -> failed. A retryable caused by the service stopping is not
an attempt. `failed` -> intent `exec-failed`, arrival `failed` +
auto-escalation carrying the executor's detail (paths).

Final review I1: an escalation on an arrival that does not end up
`needs-decision` (filed + `ExecResult.escalate`, failed, update_metadata
failed) is surfaced by `flag_attention` -- a push (a failed filing keeps
its own failure push instead) and a Vikunja "Librarian needs a look" task
(app/escalations.py) -- and every filed/failed outcome is noted for the
tick's summary pass, which pushes a "late" summary for those no run
summary of the same tick covers.
"""
import logging
import os
import re
import time

from app import fsops, intake, metrics, states
from app.config import SOURCES
from app.executor import ExecResult
from app.logutil import log_safe
from app.policy import GuardContext, KidsLists, check_intent
from app.readalong import wanted

logger = logging.getLogger(__name__)

MAX_BACKOFF = 24 * 3600
HASH_BEAT_BYTES = 64 << 20
FILING = (states.ATTACH, states.CREATE_BOOK)
_SOURCE_RE = re.compile(r"^[a-z]+$")


# --- source gating ------------------------------------------------------------------


def is_live(settings, source) -> bool:
    return (not settings.dry_run) and source in settings.live_sources


def split_live(svc, keys) -> tuple[list, list]:
    live, other = [], []
    for k in keys:
        rec = svc.arrivals.get(k) or {}
        (live if is_live(svc.settings, rec.get("source")) else other).append(k)
    return live, other


def journal_reached_library(journal) -> bool:
    """True once the arrival's file may be in the library (or a journal is
    open): pre-execution checks no longer apply, `execute()` resumes."""
    return isinstance(journal, dict) and bool(
        journal.get("open") or journal.get("moved") or journal.get("linked"))


# --- finalize -------------------------------------------------------------------------


def finalize(svc, run_id: str, keys: list) -> None:
    """Called by the cycle AFTER the run's end record is written."""
    live, other = split_live(svc, keys)
    if not live:
        svc.intents.finalize_dry_run(run_id, index=svc.index)     # P1 behaviour, all of it
        escalate_undecided(svc, run_id, keys)
        return
    if other:
        svc.intents.finalize_dry_run(run_id, index=svc.index, only_arrivals=set(other))
    queued = svc.intents.finalize_live(run_id, index=svc.index, only_arrivals=set(live),
                                       now=svc.clock())
    escalate_undecided(svc, run_id, keys)
    if svc.executor is not None:
        run_due(svc, prefer=queued)


def escalate_undecided(svc, run_id: str, keys, *, unchanged_since=None) -> list:
    """Final review I2: an arrival the run was offered that ends it with no
    accepted intent -- still `ready` or `answered` -- is never offered
    again by itself (the debounce treats "offered and left alone" as
    settled), so it would be stuck. It becomes `needs-decision` with a
    fresh core escalation ("the librarian made no decision: <guard
    reasons>") and its human answer is cleared: the human is asked again,
    no paid re-run happens by itself. `unchanged_since` (startup repair)
    skips an arrival whose record changed after that store timestamp."""
    done = []
    with svc.lock:
        intents = svc.intents.store.all()
        for key in keys:
            rec = svc.arrivals.get(key)
            if rec is None or rec.get("state") not in states.OFFERABLE:
                continue
            if unchanged_since is not None and (rec.get("ts") or 0) > unchanged_since:
                continue
            reasons = []
            for r in intents:
                if (r.get("run_id") == run_id and r.get("arrival") == key
                        and r.get("state") == states.GUARD_REJECTED and r.get("reason")):
                    why = f"{r.get('kind')} refused: {r.get('reason')}"
                    if why not in reasons:
                        reasons.append(why)
            question = "The librarian made no decision"
            question += (": " + "; ".join(reasons)) if reasons else " (it submitted no accepted intent)."
            if rec.get("state") == states.ANSWERED:
                question += " Your earlier answer was not enough to act on; please answer again."
            svc.intents.record_escalation(run_id, key, question, reason="no decision", origin="core")
            svc.arrivals.record(key, states.NEEDS_DECISION, human_answer=None,
                                detail="the librarian made no decision")
            logger.warning("arrival %s: the librarian made no decision; escalated", log_safe(key))
            done.append(key)
    return done


# --- the queue ------------------------------------------------------------------------


def run_due(svc, prefer=()) -> int:
    """Execute due work until the tick's budget is spent. Returns the count."""
    done = 0
    prefer = set(prefer)
    while svc.exec_budget > 0 and not svc.stopping():
        job = _next_job(svc, prefer)
        if job is None:
            break
        svc.exec_budget -= 1
        done += 1
        kind, key = job
        if kind == "file":
            execute_arrival(svc, key)
        elif kind == "dup":
            remove_duplicate(svc, key)
        else:
            run_updates(svc, key)
    return done


def _may_execute(svc, rec) -> bool:
    return is_live(svc.settings, rec.get("source")) or (
        not svc.settings.dry_run and journal_reached_library(rec.get("exec")))


def _next_job(svc, prefer):
    now = svc.clock()
    with svc.lock:
        due = []
        for rec in svc.arrivals.by_state(states.RETRYABLE):
            if not rec.get("exec_intent") or not _may_execute(svc, rec):
                continue
            at = rec.get("retry_at")
            at = at if isinstance(at, (int, float)) else 0
            if at > now:
                continue
            due.append((0 if rec["key"] in prefer else 1, at, rec.get("first_seen") or 0, rec["key"]))
        if due:
            return "file", min(due)[3]
        for key in _pending_update_keys(svc, now):
            return "update", key
        for rec in svc.arrivals.by_state(states.DUPLICATE):
            if (rec.get("dup_removed") or rec.get("dup_failed")
                    or not (is_live(svc.settings, rec.get("source")) or _dup_staged(svc, rec))):
                continue
            at = rec.get("dup_retry_at")
            if isinstance(at, (int, float)) and at > now:
                continue
            return "dup", rec["key"]
    return None


def _dup_staged(svc, rec) -> bool:
    """Pre-merge fix 3: a duplicate removal interrupted mid-way (its intake
    copy staged under `.executing/`, journaled as `dup`) is finished by the
    executor even after its source stopped being live -- like a filing whose
    journal reached the library. Needs an executor, i.e. DRY_RUN=false."""
    j = rec.get("dup")
    return (not svc.settings.dry_run and isinstance(j, dict)
            and os.path.lexists(fsops.staging_dir(svc.settings.intake_root, rec["key"])))


def _dup_copy_gone(svc, rec) -> bool:
    """Pre-merge fix 1: the intake copy no longer exists (e.g. a duplicate
    recorded during the dry run and cleared by hand since) and nothing of it
    is staged -- there is nothing left to remove."""
    path = rec.get("path")
    if not isinstance(path, str) or not path:
        return False                       # unknown: let the executor decide (fails closed)
    return (not os.path.lexists(path)
            and not os.path.lexists(fsops.staging_dir(svc.settings.intake_root, rec["key"])))


def remove_duplicate(svc, key: str) -> None:
    """Final review M3: a live duplicate's intake copy is removed by the
    executor once the identical file is proven in the library; the tick's
    late summary lists it ("♻️ duplicate removed"). Retryable -> backoff
    like a filing; failed (or out of attempts) -> the copy stays and the
    human gets an attention push + task."""
    with svc.lock:
        rec = svc.arrivals.get(key)
        if rec is None or rec.get("state") != states.DUPLICATE:
            return
        if _dup_copy_gone(svc, rec):
            # quietly handled: no escalation, push, task or late summary
            svc.arrivals.record(key, states.DUPLICATE, dup_removed="gone", dup_retry_at=None,
                                detail="duplicate intake copy already gone")
            logger.info("arrival %s: duplicate intake copy already gone; nothing to remove",
                        log_safe(key))
            return
    try:
        res = svc.executor.remove_duplicate(rec)
    except Exception as e:
        logger.exception("remove_duplicate raised for arrival %s", log_safe(key))
        res = ExecResult(False, "retryable", rec.get("book_id"), f"{type(e).__name__}: {log_safe(e)}")
    with svc.lock:
        cur = svc.arrivals.get(key) or rec
        if res.state == "removed":
            svc.arrivals.record(key, states.DUPLICATE, dup_removed=True, dup_retry_at=None,
                                detail=res.detail)
            note_outcome(svc, key)
            logger.info("arrival %s: duplicate intake copy removed", log_safe(key))
            return
        detail = res.detail
        if res.state == "retryable":
            if svc.stopping():
                svc.arrivals.record(key, states.DUPLICATE, dup_retry_at=svc.clock(), detail=detail)
                return
            attempts = int(cur.get("dup_attempts") or 0) + 1
            if attempts < svc.settings.max_attempts:
                svc.arrivals.record(key, states.DUPLICATE, dup_attempts=attempts,
                                    dup_retry_at=svc.clock() + _backoff(svc, attempts), detail=detail)
                return
            detail = f"gave up after {attempts} attempts; last: {detail}"
        svc.arrivals.record(key, states.DUPLICATE, dup_failed=detail, dup_retry_at=None, detail=detail)
        text = f"Duplicate of book {cur.get('book_id')}, but its intake copy was not removed: {detail}"
        esc_id = svc.intents.record_escalation("executor", key, text, reason="duplicate removal failed")
        flag_attention(svc, key, "duplicate", esc_id, text)
        logger.error("arrival %s: %s", log_safe(key), log_safe(text))


def _pending_update_keys(svc, now) -> list:
    """Arrivals with an approved update_metadata whose same-run attach has
    executed (a crash, stop or retryable left it behind)."""
    executed = {(r.get("run_id"), r.get("arrival")) for r in svc.intents.store.all()
                if r.get("kind") == states.ATTACH and r.get("state") == states.EXECUTED}
    keys = []
    for m in svc.intents.store.all():
        if m.get("kind") != states.UPDATE_METADATA or m.get("state") != states.APPROVED:
            continue
        at = m.get("retry_at")
        if isinstance(at, (int, float)) and at > now:
            continue
        if (m.get("run_id"), m.get("arrival")) not in executed:
            continue
        arr = svc.arrivals.get(m.get("arrival")) or {}
        if arr.get("state") == states.FILED and m["arrival"] not in keys:
            keys.append(m["arrival"])
    return keys


# --- one execution --------------------------------------------------------------------


def execute_arrival(svc, key: str) -> None:
    with svc.lock:
        rec = svc.arrivals.get(key)
        if rec is None or rec.get("state") != states.RETRYABLE:
            return
        intent = svc.intents.store.get(rec.get("exec_intent") or "")
    if (intent is None or intent.get("state") != states.APPROVED
            or intent.get("kind") not in FILING or intent.get("arrival") != key):
        with svc.lock:
            _failed(svc, rec, intent, f"no approved filing intent {rec.get('exec_intent')!r} to execute")
        return
    dossier = svc.load_dossier(key)            # file IO: outside the lock

    reached = journal_reached_library(rec.get("exec"))
    if not reached:
        problem = _precheck(svc, intent, rec, dossier)
        if problem is not None:
            what, why = problem
            with svc.lock:
                cur = svc.arrivals.get(key) or rec
                if what == "guard":
                    _guard_refused(svc, cur, intent, why)
                elif what == "failed":
                    _failed(svc, cur, intent, why)
                else:
                    _retry(svc, cur, intent, why)
            return
    if svc.stopping():
        return                                   # still queued; due again after restart

    with svc.lock:
        fields = {} if reached else {"exec": None}   # never replay a stale closed journal
        svc.arrivals.record(key, states.EXECUTING, detail=f"executing intent {intent['intent_id']}",
                            **fields)
        cur = svc.arrivals.get(key)
    logger.info("executing %s for arrival %s", intent["intent_id"], log_safe(key))
    try:
        res = svc.executor.execute(intent, cur, dossier)
    except Exception as e:
        logger.exception("executor raised for arrival %s", log_safe(key))
        res = ExecResult(False, "retryable", None, f"executor error: {type(e).__name__}: {log_safe(e)}")
    record_result(svc, key, intent, res)


def _precheck(svc, intent, rec, dossier):
    if dossier is None:
        return "failed", "the arrival's dossier is missing"
    try:
        svc.index.refresh(now=svc.clock(), force=True)
    except Exception as e:
        return "retry", f"library index refresh failed: {type(e).__name__}: {log_safe(e)}"
    payload = intent.get("payload") or {}
    ctx = GuardContext(
        dossier=dossier, index=svc.index,
        seen_ids={payload.get("book_id")} if payload.get("kind") == states.ATTACH else set(),
        run_claims={}, lists=KidsLists.load(svc.settings.lists_dir),
        human_answer=rec.get("human_answer"),
    )
    try:
        ok, why = check_intent(payload, ctx)
    except Exception as e:
        ok, why = False, f"guard error: {type(e).__name__}: {log_safe(e)}"
    if not ok:
        return "guard", why
    primary = rec.get("primary")
    try:
        sha = fsops.hash_file(primary, metrics.beat, HASH_BEAT_BYTES) if isinstance(primary, str) else None
    except OSError:
        sha = None
    if not sha or sha != rec.get("sha256"):
        return "failed", f"intake copy changed or gone: {primary}"
    return None


# --- recording outcomes (callers hold svc.lock unless noted) --------------------------


def record_result(svc, key: str, intent: dict | None, res: ExecResult) -> None:
    """Record an execute()/resume() outcome (takes svc.lock itself)."""
    with svc.lock:
        rec = svc.arrivals.get(key) or {"key": key}
        if res.state == "filed":
            if intent is not None:
                svc.intents.store.record(intent["intent_id"], states.EXECUTED, book_id=res.book_id,
                                         exec_detail=res.detail)
            svc.arrivals.record(key, states.FILED, book_id=res.book_id, sha256=rec.get("sha256"),
                                detail=res.detail, retry_at=None,
                                moves=[list(m) for m in res.moves])
            logger.info("arrival %s filed into book %s", log_safe(key), res.book_id)
            metrics.count_outcome(metrics.FILED, rec.get("source"))
            note_outcome(svc, key)
            if res.escalate:
                text = f"Filed into book {res.book_id}, but needs a look: {res.escalate}"
                esc_id = svc.intents.record_escalation(_run_id(intent, rec), key, text,
                                                       reason="executor escalation")
                flag_attention(svc, key, _intent_id(intent, rec), esc_id, text)
        elif res.state == "retryable":
            _retry(svc, rec, intent, res.detail)
        else:
            _failed(svc, rec, intent, res.detail or f"executor returned {res.state!r}")
    if res.state == "filed" and intent is not None:
        run_updates(svc, key, run_id=intent.get("run_id"), book_id=res.book_id)
    if res.state == "filed":
        readalong_wanted(svc, key, res.book_id)


def readalong_wanted(svc, key: str, book_id) -> None:
    """P4 trigger: ask the read-along worker to look at `book_id` now. The
    worker decides whether the book holds an EPUB + m4b pair (and everything
    else), so this makes no BookOrbit call. Best effort, outside svc.lock: a
    marker that cannot be written only means the book waits for the nightly
    run, never a failed filing."""
    s = svc.settings
    if not s.readalong_trigger or book_id is None:
        return
    try:
        wanted.write(s.readalong_wanted_dir, book_id, now=time.time(), arrival=key)
        logger.info("asked the read-along worker to look at book %s", book_id)
    except Exception as e:
        logger.warning("read-along marker for book %s not written: %s", book_id, log_safe(e))


def _intent_id(intent, rec) -> str:
    return (intent or {}).get("intent_id") or rec.get("exec_intent") or "unknown"


def note_outcome(svc, key: str) -> None:
    """Remember that `key` reached a terminal filing outcome this tick; the
    tick's summary pass (app/runs.py `flush_summaries`) reports every such
    arrival its own run summary does not cover as a "late" summary (final
    review I1: retries, budget spill and startup resume file outside a
    cycle)."""
    svc.__dict__.setdefault("tick_outcomes", set()).add(key)


def flag_attention(svc, key: str, intent_id: str, esc_id: str, text: str, *, push: bool = True) -> None:
    """Final review I1: an executor escalation on an arrival that does NOT
    end up needing a decision (filed-but-look, failed, metadata correction
    failed) is surfaced to the human -- an `attention` entry on the arrival
    (app/escalations.py turns each into a Vikunja task "Librarian needs a
    look: <title>", left open for the human to close) and, unless `push` is
    False (a failed filing already has its failure push), one push
    `attention:<arrival>:<intent>`. Caller holds svc.lock."""
    rec = svc.arrivals.get(key) or {"key": key}
    items = [dict(a) for a in (rec.get("attention") or []) if isinstance(a, dict)]
    if not any(a.get("id") == esc_id for a in items):
        items.append({"id": esc_id, "intent": intent_id, "text": str(text), "task_id": None,
                      "url": None, "pushed": bool(push and svc.notifier is not None)})
        rec = svc.arrivals.record(key, rec.get("state") or states.FAILED, attention=items)
    if push:
        svc.notify_attention(rec, intent_id, text)


def _run_id(intent, rec) -> str:
    if intent and intent.get("run_id"):
        return intent["run_id"]
    return str(rec.get("exec_intent") or "executor").split(":")[0]


def _backoff(svc, attempts: int) -> float:
    return min(svc.settings.retry_after * 2 ** (attempts - 1), MAX_BACKOFF)


def _retry(svc, rec, intent, detail) -> None:
    key = rec["key"]
    now = svc.clock()
    if svc.stopping():
        # a shutdown is not an attempt: due again right after restart
        svc.arrivals.record(key, states.RETRYABLE, retry_at=now, detail=f"interrupted by shutdown: {detail}")
        return
    attempts = int(rec.get("attempts") or 0) + 1
    if attempts >= svc.settings.max_attempts:
        _failed(svc, rec, intent, f"gave up after {attempts} attempts; last: {detail}")
        return
    at = now + _backoff(svc, attempts)
    svc.arrivals.record(key, states.RETRYABLE, attempts=attempts, retry_at=at, detail=detail)
    logger.warning("arrival %s retryable (attempt %d/%d): %s", log_safe(key), attempts,
                   svc.settings.max_attempts, log_safe(detail))


def _failed(svc, rec, intent, detail) -> None:
    key = rec["key"]
    if intent is not None and intent.get("kind") in FILING:
        svc.intents.store.record(intent["intent_id"], states.EXEC_FAILED, exec_detail=detail)
        svc.intents.reject_paired_metadata(intent, "paired filing did not execute")
    svc.arrivals.record(key, states.FAILED, error=detail, retry_at=None)
    esc_id = svc.intents.record_escalation(_run_id(intent, rec), key, f"Filing failed: {detail}",
                                           reason="execution failed")
    svc.notify_failure(rec, intent, detail)   # Plan 2 Task 5: one push per failed filing
    # final review I1: + a Vikunja task (the failure push above is the push)
    flag_attention(svc, key, _intent_id(intent, rec), esc_id, f"Filing failed: {detail}", push=False)
    metrics.count_outcome(metrics.EXEC_FAILED, rec.get("source"))
    note_outcome(svc, key)
    logger.error("arrival %s failed: %s", log_safe(key), log_safe(detail))


def _guard_refused(svc, rec, intent, why) -> None:
    key = rec["key"]
    detail = f"guard at execution: {why}"
    svc.intents.store.record(intent["intent_id"], states.EXEC_FAILED, exec_detail=detail)
    svc.intents.reject_paired_metadata(intent, "paired filing refused at execution")
    svc.arrivals.record(key, states.NEEDS_DECISION, retry_at=None, detail=detail)
    options = [{"label": f"Proceed: {svc.intents.describe(intent)}", "intent": intent.get("payload")},
               {"label": "Leave it for me"}]
    svc.intents.record_escalation(_run_id(intent, rec), key,
                                  f"A re-check before filing refused it: {why}",
                                  reason=detail, options=options)
    logger.warning("arrival %s: %s", log_safe(key), log_safe(detail))


# --- update_metadata after a filing -----------------------------------------------------


def run_updates(svc, key: str, run_id=None, book_id=None) -> None:
    """Run approved update_metadata intents for `key` (the filing's own run
    when `run_id` is given). The filing stands whatever happens here."""
    now = svc.clock()
    with svc.lock:
        arr = svc.arrivals.get(key) or {}
        if book_id is None:
            book_id = arr.get("book_id")
        metas = [m for m in svc.intents.store.all()
                 if m.get("kind") == states.UPDATE_METADATA and m.get("state") == states.APPROVED
                 and m.get("arrival") == key and (run_id is None or m.get("run_id") == run_id)
                 and not (isinstance(m.get("retry_at"), (int, float)) and m["retry_at"] > now)]
    for m in metas:
        if svc.stopping():
            return
        try:
            res = svc.executor.execute_update(m, svc.arrivals.get(key) or arr, book_id)
        except Exception as e:
            logger.exception("execute_update raised for %s", m["intent_id"])
            res = ExecResult(False, "retryable", book_id, f"{type(e).__name__}: {log_safe(e)}")
        with svc.lock:
            _record_update(svc, m, key, book_id, res)


def _record_update(svc, m, key, book_id, res) -> None:
    mid = m["intent_id"]
    if res.state == "updated":
        svc.intents.store.record(mid, states.EXECUTED, exec_detail=res.detail)
        if res.escalate:
            # Task 9c: the correction landed, but BookOrbit's rename did not
            # put the book where guard 8 rendered it -- a human should look
            text = (f"The metadata correction on book {book_id} was applied, but needs a look: "
                    f"{res.escalate}")
            esc_id = svc.intents.record_escalation(m.get("run_id") or "executor", key, text,
                                                   reason="update_metadata needs a look")
            flag_attention(svc, key, mid, esc_id, text)
        return
    if res.state == "retryable":
        now = svc.clock()
        if svc.stopping():
            svc.intents.store.record(mid, states.APPROVED, retry_at=now, exec_detail=res.detail)
            return
        attempts = int(m.get("attempts") or 0) + 1
        if attempts < svc.settings.max_attempts:
            svc.intents.store.record(mid, states.APPROVED, attempts=attempts,
                                     retry_at=now + _backoff(svc, attempts), exec_detail=res.detail)
            return
        detail = f"gave up after {attempts} attempts; last: {res.detail}"
    else:
        detail = res.detail
    svc.intents.store.record(mid, states.EXEC_FAILED, exec_detail=detail)
    text = f"The file was filed into book {book_id}, but its metadata correction failed: {detail}"
    esc_id = svc.intents.record_escalation(m.get("run_id") or "executor", key, text,
                                           reason="update_metadata failed")
    flag_attention(svc, key, mid, esc_id, text)
    logger.error("update_metadata %s for book %s failed: %s", mid, book_id, log_safe(detail))


# --- startup ---------------------------------------------------------------------------


def resume_executing(svc) -> None:
    """Startup (live): settle every arrival left `executing` by a crash."""
    for rec in svc.arrivals.by_state(states.EXECUTING):
        if svc.stopping():
            return
        key = rec["key"]
        j = rec.get("exec")
        iid = rec.get("exec_intent") or (j or {}).get("intent_id")
        intent = svc.intents.store.get(iid) if iid else None
        if not isinstance(j, dict):
            # died before the executor journaled anything: nothing moved
            with svc.lock:
                svc.arrivals.record(key, states.RETRYABLE, retry_at=svc.clock(),
                                    detail="interrupted before execution started")
            continue
        logger.warning("resuming interrupted execution of arrival %s", log_safe(key))
        try:
            res = svc.executor.resume(rec)
        except Exception as e:
            logger.exception("resume raised for arrival %s", log_safe(key))
            res = ExecResult(False, "retryable", None, f"resume error: {type(e).__name__}: {log_safe(e)}")
        record_result(svc, key, intent, res)


def _marker(svc, source) -> str:
    return os.path.join(svc.settings.state_dir, f"live-since-{source}")


def live_since(svc, source):
    """The time `source` went live (its `live-since-<source>` marker), or None."""
    if source not in SOURCES:
        return None
    try:
        with open(_marker(svc, source), encoding="utf-8") as f:
            return float(f.read().strip())
    except (OSError, ValueError):
        return None


def clear_stale_markers(svc) -> None:
    """Every start: a source that is not live right now (all of them under
    DRY_RUN) loses its `live-since-<source>` marker, so the arrivals it
    simulates meanwhile are re-offered when it goes live again (a DRY_RUN
    rollback, or a source dropped from LIVE_SOURCES, never strands them)."""
    for source in sorted(SOURCES):
        if is_live(svc.settings, source):
            continue
        try:
            os.unlink(_marker(svc, source))
            logger.info("source %s is not live: cleared its live-since marker", source)
        except FileNotFoundError:
            pass


def _find_in_intake(svc, rec, candidates):
    """The intake candidate that is still exactly this arrival, with its sha."""
    for c in candidates:
        if c.source != rec.get("source") or c.source_id != rec.get("source_id"):
            continue
        try:
            sha = fsops.hash_file(intake.primary_file(c), metrics.beat, HASH_BEAT_BYTES)
        except (OSError, ValueError):
            continue
        if intake.arrival_key(c, sha) == rec["key"] and sha == rec.get("sha256"):
            return c, sha
    return None


def _log_once(svc, key, msg) -> None:
    """Log a go_live error once per distinct (arrival, error) -- the source
    is retried every tick until it completes."""
    seen = svc.__dict__.setdefault("_go_live_errors", set())
    if (key, msg) not in seen:
        seen.add((key, msg))
        logger.error("go-live re-offer of %s failed (left simulated, retried next tick): %s",
                     log_safe(key), log_safe(msg))


def go_live(svc) -> bool:
    """Dry-run -> live, once per source (`<state>/live-since-<source>`):
    each simulated arrival of that source that is still in the intake
    unchanged (same candidate, same key and sha) gets a freshly rebuilt
    dossier -- exactly as intake builds one -- and goes back to `ready`
    (re-offered for live); the rest become `failed` "intake copy gone" (no
    push). Then the marker is written.

    Never raises for one arrival (fix round 2): an error building one
    arrival's dossier is logged once, leaves THAT arrival simulated and
    withholds only its source's marker; an intake scan error withholds
    every pending marker. Returns True once every live source is done --
    the service calls it again on later ticks until then, while intake,
    runs and execution carry on."""
    complete = True
    candidates = None
    for source in sorted(svc.settings.live_sources):
        if not _SOURCE_RE.match(source):
            continue
        marker = _marker(svc, source)
        if os.path.exists(marker):
            continue
        source_ok = True
        for rec in svc.arrivals.by_state(states.SIMULATED):
            if rec.get("source") != source:
                continue
            if svc.stopping():
                return False                # marker not written: finishes later
            if candidates is None:
                try:
                    candidates = intake.scan(svc.settings.intake_root)
                except Exception as e:
                    _log_once(svc, "<intake scan>", f"{type(e).__name__}: {e}")
                    return False
            try:
                found = _find_in_intake(svc, rec, candidates)
                if found is not None:
                    c, sha = found
                    svc.make_dossier(rec["key"], c, sha,
                                     intake.previously_filed(rec["key"], c, svc.arrivals))
            except Exception as e:
                _log_once(svc, rec["key"], f"{type(e).__name__}: {e}")
                source_ok = False
                continue
            with svc.lock:
                if found is not None:
                    history = list(rec.get("history") or [])
                    history.append({"ts": time.time(), "note": "re-offered for live (was simulated)"})
                    # Task 6 fix round 1: an answer given during the dry
                    # run never carries into live filing (it could unlock
                    # guards 7/10 for a decision made about a simulation)
                    svc.arrivals.record(rec["key"], states.READY, detail="re-offered for live",
                                        history=history, would_do=None, human_answer=None)
                else:
                    svc.arrivals.record(rec["key"], states.FAILED, error="intake copy gone")
        if not source_ok:
            complete = False
            continue
        tmp = f"{marker}.tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(f"{time.time()}\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, marker)
        logger.info("source %s is live from now on", source)
    return complete
