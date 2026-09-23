"""One librarian cycle: librarian run -> reviewer run -> end record -> finalize.

Plan 2 Task 4: the run's END record is written as soon as the reviewer is
done and BEFORE finalizing, so a crash while the executor works can never
make startup recovery treat the run's approved intents as a crashed run's
partial effects. Finalize then splits by source (app/execution.py): dry-run
finalize for non-live arrivals, queue + execute for live ones; the summary
is built afterwards so it reports live outcomes.

Split out of app/service.py to keep the loop readable. `execute_cycle(svc,
keys)` takes the `Service` (for its stores, index, settings, API port and
run open/close) and returns True when the cycle FAILED -- the caller then
holds the offered arrivals back for `retry_after` seconds.

Failure handling:
  * librarian `timeout`/`error`: the run's partial effects are discarded --
    every intent it produced is rejected and each offered arrival goes back
    to its pre-run state -- and no reviewer runs. The arrivals stay
    offerable, but only after `retry_after` (or a change), so a crashing run
    retries hourly, not every poll.
  * `containment_failed` (librarian OR reviewer): the tripwire. A run whose
    transcript shows Claude Code granted anything other than
    `mcp__librarian__*` tools -- or, for an otherwise-successful run, no
    tools at all (containment unproven) -- is logged at ERROR and the WHOLE
    cycle is discarded the same way (for a reviewer, "its effects" are
    verdicts on the librarian's intents, so the librarian's intents and any
    reviewer escalations -- all keyed under the librarian run id -- go too).
  * reviewer `timeout`/`error`: the cycle still finalizes; any proposal the
    reviewer did not rule on is rejected there ("reviewer did not rule") and
    escalated.

  * `Stopping` (SIGTERM, raised into the runner by main.py) in EITHER phase:
    the whole cycle is discarded (arrivals back to their pre-run state, run
    record outcome "stopped") and `Stopping` propagates so the loop exits.
    It is a BaseException precisely so `launch`'s `except Exception` cannot
    turn it into an "error" outcome -- which, in the reviewer phase, would
    finalize and falsely escalate every proposal as "reviewer did not rule".

Runs are opened and closed via `svc.set_run`, which holds `svc.lock` -- the
guarantee app/api.py's write handlers depend on. `run_id` is always
service-generated; run dirs, transcripts, argv and prompts never embed
arrival text. The prompt trailer carries only the arrival COUNT (controller
ruling: manual keys contain attacker-influenced filenames) -- the model
discovers the keys through `list_arrivals`.
"""
import logging
import os
import secrets
import shutil
import sys
import time

from app import execution, metrics, states
from app.mcp_shim import build_mcp_config
from app.runner import child_env, claude_argv, granted_tools
from app.states import Run
from app.logutil import log_safe as _log_safe  # noqa: F401 (kept for callers/tests)
from app.store import append_record

logger = logging.getLogger(__name__)

class Stopping(BaseException):
    """Raised (by main.py's SIGTERM handler) into an in-flight runner so
    run_claude's cleanup kills the child; the cycle is then discarded.
    Deliberately NOT an Exception subclass -- see the module docstring."""


_ENV_PASSTHROUGH = ("PATH", "CLAUDE_CODE_OAUTH_TOKEN", "TZ")
_TOOL_PREFIX = "mcp__librarian__"


def new_run_id() -> str:
    return time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(3)


def _read_prompt(svc, name: str) -> str | None:
    path = os.path.join(svc.settings.prompts_dir, name)
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        logger.error("prompt %s unreadable (%s); skipping run", path, e)
        return None


# --- one claude -p launch ------------------------------------------------------


def _granted(transcript_path: str) -> list:
    try:
        return granted_tools(transcript_path)
    except OSError:
        return []


def _outcome(result, granted: list) -> str:
    if any(not (isinstance(t, str) and t.startswith(_TOOL_PREFIX)) for t in granted):
        return "containment_failed"
    if result is None:
        return "error"
    if result.timed_out:
        return "timeout"
    if not result.ok:
        return "error"
    if not granted:
        return "containment_failed"
    return "ok"


def launch(svc, run: Run, prompt_text: str, model: str) -> tuple[str, object]:
    """Open `run`, run claude for it, close it. Returns (outcome, RunResult|None)."""
    s = svc.settings
    run_dir = os.path.join(s.runs_root, run.run_id)
    cwd = os.path.join(run_dir, "cwd")
    os.makedirs(os.path.join(run_dir, "claude-config"), exist_ok=True)
    os.makedirs(cwd, exist_ok=True)
    transcript = os.path.join(svc.transcript_dir, f"{run.run_id}-{run.mode}.jsonl")
    mcp = build_mcp_config(sys.executable, f"http://127.0.0.1:{svc.api_port}", run.token, run.mode)
    base_env = {k: os.environ[k] for k in _ENV_PASSTHROUGH if k in os.environ}

    result = None
    svc.set_run(run)
    try:
        argv = claude_argv(s, prompt_text, mcp, model)
        env = child_env(s, base_env, run_dir)
        result = svc.call_runner(argv, cwd=cwd, env=env, timeout=s.run_timeout,
                                 transcript_path=transcript)
    except Stopping:
        metrics.RUNS.labels(mode=run.mode, outcome="stopped").inc()
        raise
    except Exception:
        logger.exception("%s run %s failed to run", run.mode, run.run_id)
    finally:
        svc.set_run(None)
        shutil.rmtree(run_dir, ignore_errors=True)

    granted = _granted(transcript)
    outcome = _outcome(result, granted)
    if outcome == "containment_failed":
        logger.error("containment check failed for %s run %s: granted tools %r -- discarding its effects",
                     run.mode, run.run_id, granted)
    else:
        logger.info("%s run %s finished: %s", run.mode, run.run_id, outcome)
    metrics.RUNS.labels(mode=run.mode, outcome=outcome).inc()
    if result is not None and isinstance(result.cost_usd, (int, float)) and result.cost_usd > 0:
        metrics.RUN_COST.inc(result.cost_usd)
    return outcome, result


def _result_record(run: Run, outcome: str, result) -> dict:
    return {
        "run_id": run.run_id,
        "outcome": outcome,
        "ok": bool(result is not None and result.ok),
        "cost_usd": getattr(result, "cost_usd", None),
        "num_turns": getattr(result, "num_turns", None),
        "error_reason": getattr(result, "error_reason", None),
    }


# --- discard / summary -----------------------------------------------------------


def discard(svc, run_id: str, pre: dict, reason: str) -> None:
    """Undo a cycle: reject every live intent recorded under `run_id` and put
    each offered arrival back to its pre-run state."""
    with svc.lock:
        for rec in svc.intents.store.all():
            if rec.get("run_id") != run_id:
                continue
            if rec.get("state") in (states.REJECTED, states.GUARD_REJECTED):
                continue
            svc.intents.store.record(rec["intent_id"], states.REJECTED,
                                     review={"verdict": "reject", "argument": reason})
        for key, prev in pre.items():
            cur = svc.arrivals.get(key)
            if prev is None or cur is None:
                continue
            if (cur.get("state"), cur.get("not_before")) == (prev.get("state"), prev.get("not_before")):
                continue
            svc.arrivals.record(key, prev["state"], not_before=prev.get("not_before"),
                                detail=f"run {run_id} discarded: {reason}")


def summary(svc, run_id: str, keys: list[str]) -> tuple[str, int, int]:
    """The text Task 5 will push: header + one line per offered arrival.
    Live-source arrivals report what actually happened; dry-run ones (all
    of them under DRY_RUN) what would have."""
    filings = {}
    for rec in svc.intents.store.all():
        if (rec.get("run_id") == run_id and rec.get("kind") in (states.ATTACH, states.CREATE_BOOK)
                and rec.get("state") in (states.SIMULATED_I, states.EXECUTED, states.APPROVED,
                                         states.EXEC_FAILED)):
            filings[rec.get("arrival")] = rec
    n_sim = n_filed = n_esc = n_failed = 0
    lines = []
    for key in keys:
        rec = svc.arrivals.get(key) or {}
        fmt = "🎧" if str(rec.get("primary", "")).lower().endswith(".m4b") else "📖"
        icon = fmt
        hint = _log_safe(str(rec.get("title_hint") or key))
        st = rec.get("state")
        live = execution.is_live(svc.settings, rec.get("source"))
        intent = filings.get(key) or {}
        if st == states.SIMULATED:
            n_sim += 1
            if intent.get("kind") == states.ATTACH:
                book = svc.index.book((intent.get("payload") or {}).get("book_id")) or {}
                what = f'would add to "{book.get("title", "?")}"'
            else:
                what = "would create new book"
        elif st == states.FILED:
            n_filed += 1
            if intent.get("kind") == states.ATTACH:
                book = svc.index.book(rec.get("book_id")) or {}
                what = f'added to "{book.get("title", "?")}"'
            elif intent.get("kind") == states.CREATE_BOOK:
                what = "new book"
            else:
                what = "filed"
        elif st == states.NEEDS_DECISION:
            n_esc += 1
            if live:
                icon, what = "❓", "needs a decision"
            else:
                what = "would escalate"
        elif st == states.FAILED:
            n_failed += 1
            icon, what = "⚠️", "failed, see task"
        elif st in (states.RETRYABLE, states.EXECUTING):
            icon, what = "⏳", "filing pending, will retry"
        elif st == states.DEFERRED:
            what = "deferred" if live else "would defer"
        else:
            what = "no decision"
        lines.append(f"{icon} {hint} — {what}")
    if svc.settings.dry_run:
        header = f"Librarian (dry-run): {n_sim} would file · {n_esc} would escalate"
    else:
        header = f"Librarian: {n_filed} filed · {n_esc} need a decision · {n_failed} failed"
        if n_sim:
            header += f" · {n_sim} would file (dry-run sources)"
    text = "\n".join([header, *lines])
    return text, n_filed + n_sim, n_esc


def _append_run_record(svc, record: dict) -> None:
    # Store-style append (final review I2): a torn tail left by a crash is
    # truncated first, so this record is never glued onto a partial one.
    append_record(svc.runs_path, record)


# --- the cycle ---------------------------------------------------------------------


def execute_cycle(svc, keys: list[str]) -> bool:
    lib_prompt = _read_prompt(svc, "librarian.md")
    rev_prompt = _read_prompt(svc, "reviewer.md")
    if lib_prompt is None or rev_prompt is None:
        return True

    started = svc.clock()
    pre = {k: svc.arrivals.get(k) for k in keys}
    lib_run = Run(run_id=new_run_id(), token=secrets.token_urlsafe(32), mode="librarian",
                  arrival_keys=list(keys))
    started_ts = time.time()
    # The start record is what lets a restart know which arrivals a run that
    # never finished was offered (final review I3) -- and hold them.
    _append_run_record(svc, {"event": "start", "run_id": lib_run.run_id, "started": started,
                             "started_ts": started_ts, "keys": list(keys)})
    record = {"event": "end", "run_id": lib_run.run_id, "started": started, "started_ts": started_ts,
              "keys": list(keys), "librarian": None, "reviewer": None}
    try:
        return _cycle(svc, keys, pre, lib_run, lib_prompt, rev_prompt, record)
    except Stopping:
        logger.warning("librarian cycle %s interrupted by shutdown; discarding it", lib_run.run_id)
        discard(svc, lib_run.run_id, pre, "service stopping")
        record.update(outcome="stopped", failed=True, ended=svc.clock(), ended_ts=time.time(),
                      counts={"offered": len(keys)})
        _append_run_record(svc, record)
        raise


def _cycle(svc, keys, pre, lib_run, lib_prompt, rev_prompt, record) -> bool:
    s = svc.settings
    trailer = (f"\n\n## This run\n\n{len(keys)} arrival(s) are offered to you in this run; "
               "call list_arrivals to see them.\n")
    lib_outcome, lib_result = launch(svc, lib_run, lib_prompt + trailer, s.model)
    record["librarian"] = _result_record(lib_run, lib_outcome, lib_result)
    outcome = lib_outcome
    failed = lib_outcome != "ok"

    if failed:
        reason = ("containment check failed" if lib_outcome == "containment_failed"
                  else f"librarian run {lib_outcome}")
        discard(svc, lib_run.run_id, pre, reason)
    else:
        # proposals() is filings only (attach/create_book) -- escalations and
        # deferrals are never put before the reviewer (final review I1).
        proposals = svc.intents.proposals(lib_run.run_id)
        if proposals:
            rev_keys = []
            for p in proposals:
                if p.get("arrival") not in rev_keys:
                    rev_keys.append(p.get("arrival"))
            rev_run = Run(run_id=new_run_id(), token=secrets.token_urlsafe(32), mode="reviewer",
                          arrival_keys=rev_keys, review_of=lib_run.run_id)
            rev_trailer = (f"\n\n## This run\n\n{len(proposals)} proposal(s) from librarian run "
                           f"{lib_run.run_id} await your review.\n")
            rev_outcome, rev_result = launch(svc, rev_run, rev_prompt + rev_trailer, s.reviewer_model)
            record["reviewer"] = _result_record(rev_run, rev_outcome, rev_result)
            if rev_outcome != "ok":
                outcome = rev_outcome
            if rev_outcome == "containment_failed":
                failed = True
                discard(svc, lib_run.run_id, pre, "containment check failed")

    # End record FIRST (Global "Crash-safe execution"), then finalize.
    record.update(outcome=outcome, failed=failed, ended=svc.clock(), ended_ts=time.time(),
                  counts={"offered": len(keys)})
    _append_run_record(svc, record)
    if not failed:
        execution.finalize(svc, lib_run.run_id, keys)

    for rec in svc.intents.store.all():
        if rec.get("run_id") == lib_run.run_id:
            kind = rec.get("kind")
            kind = kind if kind in states.INTENT_KINDS else "invalid"   # model-controlled label
            metrics.INTENTS.labels(kind=kind, status=str(rec.get("state"))).inc()

    if failed:
        logger.warning("librarian cycle %s failed (%s); offered arrivals retry after %ss",
                       lib_run.run_id, outcome, s.retry_after)
    else:
        text, _n_file, _n_esc = summary(svc, lib_run.run_id, keys)
        logger.info("%s", text)
    return failed
