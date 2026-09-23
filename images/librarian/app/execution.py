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
arrival `needs-decision` + auto-escalation; a missing/changed primary ->
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
"""
import logging
import os
import re
import time

from app import fsops, metrics, states
from app.executor import ExecResult
from app.logutil import log_safe
from app.policy import GuardContext, KidsLists, check_intent

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
        return
    if other:
        svc.intents.finalize_dry_run(run_id, index=svc.index, only_arrivals=set(other))
    queued = svc.intents.finalize_live(run_id, index=svc.index, only_arrivals=set(live),
                                       now=svc.clock())
    if svc.executor is not None:
        run_due(svc, prefer=queued)


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
    return None


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
        dossier = svc.load_dossier(key)
    if (intent is None or intent.get("state") != states.APPROVED
            or intent.get("kind") not in FILING or intent.get("arrival") != key):
        with svc.lock:
            _failed(svc, rec, intent, f"no approved filing intent {rec.get('exec_intent')!r} to execute")
        return

    if not journal_reached_library(rec.get("exec")):
        problem = _precheck(svc, intent, rec, dossier)
        if problem is not None:
            what, why = problem
            with svc.lock:
                cur = svc.arrivals.get(key) or rec
                if what == "guard":
                    _guard_refused(svc, cur, intent, why)
                elif what == "gone":
                    _failed(svc, cur, intent, why)
                else:
                    _retry(svc, cur, intent, why)
            return

    with svc.lock:
        svc.arrivals.record(key, states.EXECUTING, detail=f"executing intent {intent['intent_id']}")
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
        return "guard", "the arrival's dossier is missing"
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
        return "gone", f"intake copy changed or gone: {primary}"
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
            if res.escalate:
                svc.intents.record_escalation(
                    _run_id(intent, rec), key,
                    f"Filed into book {res.book_id}, but needs a look: {res.escalate}",
                    reason="executor escalation")
        elif res.state == "retryable":
            _retry(svc, rec, intent, res.detail)
        else:
            _failed(svc, rec, intent, res.detail or f"executor returned {res.state!r}")
    if res.state == "filed" and intent is not None:
        run_updates(svc, key, run_id=intent.get("run_id"), book_id=res.book_id)


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
    svc.intents.record_escalation(_run_id(intent, rec), key, f"Filing failed: {detail}",
                                  reason="execution failed")
    logger.error("arrival %s failed: %s", log_safe(key), log_safe(detail))


def _guard_refused(svc, rec, intent, why) -> None:
    key = rec["key"]
    detail = f"guard at execution: {why}"
    svc.intents.store.record(intent["intent_id"], states.EXEC_FAILED, exec_detail=detail)
    svc.intents.reject_paired_metadata(intent, "paired filing refused at execution")
    options = [{"label": f"Proceed: {svc.intents._summary(intent)}", "intent": intent.get("payload")},
               {"label": "Leave it for me"}]
    svc.intents.record_escalation(_run_id(intent, rec), key,
                                  f"A re-check before filing refused it: {why}",
                                  reason=detail, options=options)
    svc.arrivals.record(key, states.NEEDS_DECISION, retry_at=None, detail=detail)
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
    svc.intents.record_escalation(
        m.get("run_id") or "executor", key,
        f"The file was filed into book {book_id}, but its metadata correction failed: {detail}",
        reason="update_metadata failed")
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


def go_live(svc) -> None:
    """Dry-run -> live, once per source (`<state>/live-since-<source>`):
    simulated arrivals of that source whose primary still hashes to their
    sha go back to `ready` (re-offered for live), the rest become `failed`
    "intake copy gone" (no push). Then the marker is written."""
    for source in sorted(svc.settings.live_sources):
        if not _SOURCE_RE.match(source):
            continue
        marker = os.path.join(svc.settings.state_dir, f"live-since-{source}")
        if os.path.exists(marker):
            continue
        for rec in svc.arrivals.by_state(states.SIMULATED):
            if rec.get("source") != source:
                continue
            if svc.stopping():
                return                      # marker not written: finishes next start
            primary = rec.get("primary")
            try:
                sha = (fsops.hash_file(primary, metrics.beat, HASH_BEAT_BYTES)
                       if isinstance(primary, str) and os.path.isfile(primary) else None)
            except OSError:
                sha = None
            with svc.lock:
                if sha and sha == rec.get("sha256"):
                    history = list(rec.get("history") or [])
                    history.append({"ts": time.time(), "note": "re-offered for live (was simulated)"})
                    svc.arrivals.record(rec["key"], states.READY, detail="re-offered for live",
                                        history=history, would_do=None)
                else:
                    svc.arrivals.record(rec["key"], states.FAILED, error="intake copy gone")
        tmp = f"{marker}.tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(f"{time.time()}\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, marker)
        logger.info("source %s is live from now on", source)
