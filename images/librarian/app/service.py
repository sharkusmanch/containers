"""The librarian service: poll intake, stabilise, hash, dossier, debounce, run.

`Service` implements the Global `Core` protocol consumed by app/api.py
(`current_run`, `arrivals`, `intents`, `index`, `lists`, `load_dossier`,
`lock`) and owns the one `ApiServer` the sandboxed `claude -p` runs reach.
Run orchestration (launch, containment tripwire, review, finalize, summary)
lives in app/runs.py to keep this module to the loop itself.

DRY_RUN (Plan 2 Task 4) is a real switch. With `dry_run=False` the service
needs an `executor` (an Executor, or a factory called with the service --
the Executor must share this service's arrivals Store); approved filings of
LIVE_SOURCES arrivals then execute (app/execution.py). In dry-run no
executor is ever built or used, whatever is passed. On the first live tick
the service settles arrivals a crash left `executing` (`Executor.resume`)
and re-offers each newly-live source's simulated arrivals (once per source,
`<state>/live-since-<source>`).

Debounce / "changed since last run" (brief step 3, 5): the service keeps an
in-memory per-arrival change marker (`_changed[key] = when`). A key is
marked when its store record (state, not_before, ts) differs from what the
previous tick saw, when a DEFERRED arrival's `not_before` passes, or when a
failed run's `retry_after` expires. Marks are cleared when the arrival is
offered to a run, and after a run the snapshot is re-taken WITHOUT marking,
so the run's own state changes never re-trigger it. A run starts only when
some marked, offerable key exists and the newest mark is at least
`debounce` seconds old -- a burst of arrivals becomes one run, and an
arrival the librarian looked at and left alone is not offered again until
something about it changes. The markers are in-memory, but a restart
rebuilds them from runs.jsonl (`_seed_debounce`, final review I3): an
arrival the last run offered and left alone stays unmarked, and the
arrivals of an interrupted or failed run stay held for `retry_after` -- a
restart never triggers a paid re-run by itself.
"""
import functools
import hashlib
import json
import logging
import os
import threading
import time

from app import escalations, execution, intake, metrics, notify, states
from app.api import ApiServer
from app.dossier import build_dossier, title_from_folder
from app.intents import IntentBook
from app.logutil import log_safe
from app.media import ffprobe_json
from app.policy import KidsLists, kids_signals
from app.runner import run_claude
from app.runs import Stopping, execute_cycle  # noqa: F401 (Stopping re-exported for main.py)
from app.store import Store, append_record, read_records

logger = logging.getLogger(__name__)

TRANSCRIPT_MAX_AGE = 30 * 86400
# arrival states whose APPROVED intents the executor owns (never "recovered")
_EXEC_OWNED = frozenset({states.RETRYABLE, states.EXECUTING, states.FILED})


def dossier_name(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".json"


def _short_title(text, limit: int = 60) -> str:
    """A push notification title fragment: sanitized and character-capped
    at `limit` (titles are short by construction, so a character cap --
    unlike the body's UTF-8 byte cap -- is plenty)."""
    text = notify.sanitize(str(text or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


class Service:
    def __init__(self, settings, *, index, api_factory=ApiServer, runner=run_claude,
                 prober=ffprobe_json, clock=time.time, executor=None, notifier=None, vikunja=None):
        if not settings.dry_run and executor is None:
            raise ValueError("DRY_RUN=false needs an executor")
        self.settings = settings
        self.index = index
        self.runner = runner
        self.prober = prober
        self.clock = clock
        self.lock = threading.Lock()

        sd = settings.state_dir
        self.dossier_dir = os.path.join(sd, "dossiers")
        self.transcript_dir = os.path.join(sd, "transcripts")
        self.runs_path = os.path.join(sd, "runs.jsonl")
        for d in (sd, self.dossier_dir, self.transcript_dir):
            os.makedirs(d, exist_ok=True)

        self.arrivals = Store(os.path.join(sd, "arrivals.jsonl"), "key", states.ARRIVAL_STATES)
        intent_store = Store(os.path.join(sd, "intents.jsonl"), "intent_id", states.INTENT_STATES)
        self.intents = IntentBook(intent_store, self.arrivals, self.lock, clock)
        self.lists = KidsLists.load(settings.lists_dir)
        self.stability = intake.Stability(settings.quiet_period)

        self._run = None
        self._hashed: dict[tuple, tuple] = {}     # (source, source_id) -> (signature, sha)
        self._seen: dict[str, tuple] = {}         # key -> last observed record signature
        self._changed: dict[str, float] = {}      # key -> when it last changed (unoffered)
        self._retry_at: dict[str, float] = {}     # key -> re-offer time after a failed run
        self.last_run_started: float | None = None
        self._stop = threading.Event()
        self._in_runner = False
        self._lists_error: str | None = None
        self.notifier = notifier            # Plan 2 Task 5
        if self.notifier is not None:
            # fix round 1: the service is the one true source of `stopping`
            # and the liveness heartbeat, whichever code constructed the
            # Notifier (main.py builds it before the Service exists).
            self.notifier.stopping = self.stopping
            self.notifier.beat = metrics.beat
        self.vikunja = vikunja              # Plan 2 Task 6
        self.exec_budget = 0                # executions left this tick (max_exec_per_tick)
        self._live_started = False
        self._go_live_pending = False
        self._go_live_errors: set = set()   # (key, error) already logged by go_live
        self.executor = None
        if not settings.dry_run:
            self.executor = executor if hasattr(executor, "execute") else executor(self)

        runs = read_records(self.runs_path)   # StoreCorrupt halts, like the stores
        self._complete_finalize(runs)
        held = self._recover_interrupted(runs)
        self._seed_debounce(runs, held)

        self.api = api_factory(self, port=settings.api_port)
        self.api_port = self.api.start()

    # --- Core protocol ---------------------------------------------------------

    def current_run(self):
        return self._run

    def load_dossier(self, key):
        try:
            with open(os.path.join(self.dossier_dir, dossier_name(key)), encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    # --- lifecycle ---------------------------------------------------------------

    def stopping(self) -> bool:
        return self._stop.is_set()

    def stop(self) -> None:
        self._stop.set()
        self.api.stop()

    def request_stop(self) -> bool:
        """Ask the loop to exit; True if a claude child is running right now
        (the caller -- a signal handler -- should then raise `Stopping`)."""
        self._stop.set()
        return self._in_runner

    def serve_forever(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Stopping:
                break
            except Exception:
                logger.exception("tick failed")
            self._stop.wait(self.settings.poll_interval)

    def _complete_finalize(self, runs: list[dict]) -> None:
        """Plan 2: a cycle writes its end record BEFORE finalizing (so a
        crash during execution never makes recovery reject its intents). A
        crash between the two -- or inside finalize, between two of its
        records -- leaves a finished run with arrivals still `proposed`.
        For every such arrival whose LAST run (runs.jsonl order) ended
        successfully and holds any intent for it, finalize is re-run for it
        (idempotent: keyed on current state; live arrivals are only queued
        here, the first tick executes them) and then
        `IntentBook.repair_proposed` finishes a half-written escalation.
        An arrival whose last run never ended is recovery's job."""
        last: dict[str, dict] = {}
        for r in runs:
            for k in r.get("keys") or []:
                if isinstance(k, str):
                    last[k] = r
        pending: dict[str, set] = {}
        intents = self.intents.store.all()
        for rec in self.arrivals.by_state(states.PROPOSED):
            key = rec["key"]
            r = last.get(key)
            if r is None or "outcome" not in r or r.get("failed", r.get("outcome") != "ok"):
                continue
            run_id = r.get("run_id")
            if any(i.get("run_id") == run_id and i.get("arrival") == key for i in intents):
                pending.setdefault(run_id, set()).add(key)
        for run_id, keys in sorted(pending.items()):
            logger.warning("run %s ended but was not fully finalized; finalizing %d arrival(s) now",
                           log_safe(run_id), len(keys))
            live, other = execution.split_live(self, sorted(keys))
            if other:
                self.intents.finalize_dry_run(run_id, index=self.index, only_arrivals=set(other))
            if live:
                self.intents.finalize_live(run_id, index=self.index, only_arrivals=set(live),
                                           now=self.clock())
            self.intents.repair_proposed(run_id, sorted(keys), index=self.index)

    def _recover_interrupted(self, runs: list[dict]) -> set:
        """Discard the partial effects of a run the process died in the middle
        of (OOM, SIGKILL, node loss) -- the same treatment a failed run gets.
        Returns the arrival keys that run was offered or that recovery reset,
        which `_seed_debounce` then holds for `retry_after`.

        Every cycle writes a start record to runs.jsonl before launching and
        an end record (with `outcome`) when it ends -- ok, failed, discarded
        or stopped. A finalized run leaves only TERMINAL intents behind
        (app/intents.py, final review I2), so any intent still
        proposed/approved whose run has no end record is a crashed run's
        partial effect: it is rejected, and the arrivals it moved (PROPOSED /
        NEEDS_DECISION / DEFERRED) go back to READY. A lost or torn end record
        therefore can no longer undo a completed run's escalations. Any
        PROPOSED arrival is also reset -- nothing ever offers that state
        again.

        Plan 2: an APPROVED intent whose arrival is queued, executing or
        filed (`retryable`/`executing`/`filed`) belongs to the executor --
        the run's end record was written before it was queued, so it is
        never a crashed run's partial effect even if that record was torn
        -- and is left alone, as are those arrivals."""
        done = {r.get("run_id") for r in runs if "outcome" in r}
        held = set()
        interrupted = []
        for r in runs:
            if r.get("event") == "start" and r.get("run_id") not in done:
                keys = [k for k in (r.get("keys") or []) if isinstance(k, str)]
                held.update(keys)
                interrupted.append((r, keys))
        reason = "service restarted mid-run"
        with self.lock:
            touched = set()
            for rec in self.intents.store.all():
                if rec.get("run_id") in done:
                    continue
                if rec.get("state") not in (states.PROPOSED_I, states.APPROVED):
                    continue
                if rec.get("state") == states.APPROVED and (
                        (self.arrivals.get(rec.get("arrival")) or {}).get("state") in _EXEC_OWNED):
                    continue
                self.intents.store.record(rec["intent_id"], states.REJECTED,
                                          review={"verdict": "reject", "argument": reason})
                if isinstance(rec.get("arrival"), str):
                    touched.add(rec["arrival"])
            held |= touched
            for key in sorted(touched):
                cur = self.arrivals.get(key)
                if cur and cur.get("state") in (states.PROPOSED, states.NEEDS_DECISION, states.DEFERRED):
                    self.arrivals.record(key, states.READY, not_before=None,
                                         detail="recovered after interrupted run")
            for rec in self.arrivals.by_state(states.PROPOSED):
                held.add(rec["key"])
                self.arrivals.record(rec["key"], states.READY, detail="recovered after interrupted run")
        # Close each interrupted run with a synthetic end record, AFTER the
        # resets above, so it is recovered exactly once: later restarts see
        # an ordinary failed run and `_seed_debounce` applies the failed-run
        # rule (hold until its end + retry_after, or nothing once a later run
        # has offered the key). Without it the start record stays open
        # forever and every restart re-holds -- then re-offers, a paid run --
        # its keys (Task 14a P1).
        for r, keys in interrupted:
            rec = {"event": "end", "run_id": r.get("run_id"), "started": r.get("started"),
                   "started_ts": r.get("started_ts"), "keys": keys,
                   "librarian": None, "reviewer": None,
                   "outcome": "interrupted", "failed": True,
                   "ended": self.clock(), "ended_ts": time.time(),
                   "counts": {"offered": len(keys)}}
            append_record(self.runs_path, rec)
            runs.append(rec)
            metrics.RUNS.labels(mode="librarian", outcome="interrupted").inc()
            logger.warning("librarian run %s was interrupted by a restart; its %d arrival(s) "
                           "are held for retry_after", log_safe(r.get("run_id")), len(keys))
        return held

    def _seed_debounce(self, runs: list[dict], held: set) -> None:
        """Rebuild the in-memory debounce state from runs.jsonl (final review
        I3), so a restart does not re-offer -- and pay for -- every
        offerable arrival at once:

          * an arrival the most recent run that offered it left alone (its
            record unchanged since that run STARTED) is not "changed";
          * an arrival of an interrupted run (start record, no end record),
            or one recovery reset, is held until now + `retry_after`;
          * an arrival of a FAILED run is held until that run's end +
            `retry_after`, exactly as the live service would have held it,
            unless the arrival changed after the run ended.

        Anything else (never offered, answered or deferral expired since)
        is marked changed by the first `_observe_changes`, as before.
        Timestamps compared against arrival records use the store's own
        wall clock (`started_ts`/`ended_ts`); hold deadlines use the
        service clock, like `_retry_at` itself."""
        now = self.clock()
        last: dict[str, dict] = {}
        for r in runs:                     # file order: a run's end record overrides its start
            for k in r.get("keys") or []:
                if isinstance(k, str):
                    last[k] = r
        retry = self.settings.retry_after
        for rec in self.arrivals.all():
            key = rec["key"]
            ts = rec.get("ts") or 0
            r = last.get(key)
            if key in held:
                hold_until = now + retry
            elif r is None or r.get("event") == "start":
                continue
            elif r.get("failed", r.get("outcome") != "ok"):
                if ts > (r.get("ended_ts") or 0):
                    continue
                ended = r.get("ended")
                hold_until = (ended if isinstance(ended, (int, float)) else now) + retry
            else:
                if ts > (r.get("started_ts") or 0):
                    continue
                self._seen[key] = self._signature(rec, now)
                continue
            self._seen[key] = self._signature(rec, now)
            self._retry_at[key] = hold_until

    # --- tick ----------------------------------------------------------------

    def tick(self) -> None:
        metrics.beat()
        self.exec_budget = self.settings.max_exec_per_tick
        now = self.clock()
        try:
            self.index.refresh(now)
        except Exception:
            logger.exception("library index refresh failed; using cached index")
        metrics.INDEX_BOOKS.set(len(self.index.books()))
        self.lists = KidsLists.load(self.settings.lists_dir)
        err = None if self.lists.valid else self.lists.error
        if err and err != self._lists_error:
            logger.error("kids lists invalid (kids filings refused): %s", err)
        elif self._lists_error and not err:
            logger.info("kids lists valid again")
        self._lists_error = err

        if not self._live_started:
            self._start_live()           # raises -> retried next tick
            self._live_started = True
        if self._go_live_pending and not self._stop.is_set():
            # never raises per arrival: a bad arrival only delays its source
            self._go_live_pending = not execution.go_live(self)
        if self._stop.is_set():
            return
        self._intake(now)
        if self._stop.is_set():
            return
        self._observe_changes(now)
        keys = self._due(now)
        if keys:
            self._run_cycle(keys)
        if self.executor is not None and not self._stop.is_set():
            execution.run_due(self)     # queued + retryable filings, within the tick budget
        if not self._stop.is_set():
            # Plan 2 Task 6: Vikunja tasks/replies/closes (or, without
            # Vikunja, the escalation pushes). HTTP outside svc.lock; a
            # failure here must not cost the tick its flush/metrics.
            try:
                escalations.sync(self)
            except Exception:
                logger.exception("escalation sync failed")
        if self.notifier is not None and not self._stop.is_set():
            # Outside svc.lock (Plan 2 Task 5): the outbox is its own Store
            # with its own lock, and an HTTP call must never hold svc.lock.
            # Gated on the stop flag like execution.run_due (fix round 1).
            self.notifier.flush()
        metrics.rebuild_arrivals(self.arrivals)
        self._prune_transcripts()
        self._prune_outbox()

    def _start_live(self) -> None:
        execution.clear_stale_markers(self)
        if self.executor is None:
            waiting = (len(self.arrivals.by_state(states.EXECUTING))
                       + len([r for r in self.arrivals.by_state(states.RETRYABLE) if r.get("exec_intent")]))
            if waiting:
                logger.warning("DRY_RUN: %d queued/executing filing(s) are left untouched until "
                               "DRY_RUN=false", waiting)
            return
        stranded = [r for r in self.arrivals.by_state(states.RETRYABLE)
                    if r.get("exec_intent") and not execution.is_live(self.settings, r.get("source"))
                    and not execution.journal_reached_library(r.get("exec"))]
        if stranded:
            logger.warning("%d queued filing(s) of sources not in LIVE_SOURCES are left untouched",
                           len(stranded))
        execution.resume_executing(self)
        self._go_live_pending = True     # tick() runs go_live until it completes

    # --- intake --------------------------------------------------------------

    def _only_match(self, source: str, source_id: str, key: str | None = None) -> bool:
        """ONLY restricts the service to one source_id or one full arrival
        key. Without a key (pre-hash) a full-key ONLY matches by its
        `source:source_id:` prefix; with a key it must match exactly."""
        only = self.settings.only
        if not only or source_id == only:
            return True
        if key is not None:
            return key == only
        return only.startswith(f"{source}:{source_id}:")

    def _intake(self, now: float) -> None:
        try:
            candidates = intake.scan(self.settings.intake_root)
        except Exception:
            logger.exception("intake scan failed")
            return
        for c in candidates:
            # hashing a large m4b can take a while: keep liveness fresh and
            # let a SIGTERM stop intake between candidates
            metrics.beat()
            if self._stop.is_set():
                return
            if not self._only_match(c.source, c.source_id):
                continue
            try:
                self._intake_one(c, now)
            except Exception:
                # e.g. a BookOrbit error inside build_dossier: leave the
                # candidate unrecorded so the next tick retries it.
                logger.exception("intake of %s:%s failed; will retry", c.source, log_safe(c.source_id))

    def _intake_one(self, c, now: float) -> None:
        if not self.stability.observe(c, now):
            return
        cid = (c.source, c.source_id)
        sig = intake.signature(c)
        cached = self._hashed.get(cid)
        if cached is not None and cached[0] == sig:
            sha = cached[1]
        else:
            sha = intake.sha256_file(intake.primary_file(c))
            self._hashed[cid] = (sig, sha)
        key = intake.arrival_key(c, sha)
        if not self._only_match(c.source, c.source_id, key):
            return
        if self.arrivals.get(key) is not None:
            return

        primary = intake.primary_file(c)
        base = {"source": c.source, "source_id": c.source_id, "path": c.path,
                "primary": primary, "sha256": sha, "title_hint": title_from_folder(c)}

        err = intake.verify_sidecar(c, sha)
        if err:
            logger.error("arrival %s failed: %s", log_safe(key), log_safe(err))
            self.arrivals.record(key, states.FAILED, error=err, **base)
            return

        filed = {r["sha256"]: r.get("book_id") for r in self.arrivals.by_state(states.FILED)
                 if r.get("sha256")}
        verdict, info = intake.classify(key, c, sha, self.arrivals, filed)
        if verdict == "skip":
            return
        if verdict == "duplicate":
            book_id = info["book_id"]
            logger.info("arrival %s duplicates book %s", log_safe(key), log_safe(book_id))
            self.arrivals.record(key, states.DUPLICATE, book_id=book_id,
                                 would_do=[f"remove intake copy (identical to book {book_id})"], **base)
            return

        self.make_dossier(key, c, sha, info.get("previously_filed"))
        self.arrivals.record(key, states.READY, **base)
        logger.info("arrival %s ready", log_safe(key))

    def make_dossier(self, key: str, c, sha: str, previously_filed) -> None:
        """Build and persist the arrival's dossier (intake, and the
        dry-run -> live re-offer in app/execution.py)."""
        dossier = build_dossier(
            key, c, sha, self.index, prober=self.prober,
            kids=functools.partial(kids_signals, self.lists),
            previously_filed=previously_filed,
        )
        self._write_dossier(key, dossier)

    def _write_dossier(self, key: str, dossier: dict) -> None:
        path = os.path.join(self.dossier_dir, dossier_name(key))
        tmp = f"{path}.tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dossier, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    # --- debounce ------------------------------------------------------------

    def _offerable(self, rec: dict, now: float) -> bool:
        st = rec.get("state")
        if st in states.OFFERABLE:
            return True
        if st == states.DEFERRED:
            nb = rec.get("not_before")
            return isinstance(nb, (int, float)) and nb <= now
        return False

    def _signature(self, rec: dict, now: float) -> tuple:
        return (rec.get("state"), rec.get("not_before"), rec.get("ts"), self._offerable(rec, now))

    def _observe_changes(self, now: float) -> None:
        for rec in self.arrivals.all():
            key = rec["key"]
            sig = self._signature(rec, now)
            if self._seen.get(key) != sig:
                self._seen[key] = sig
                self._changed[key] = now
                self._retry_at.pop(key, None)
        for key, at in list(self._retry_at.items()):
            if now >= at:
                del self._retry_at[key]
                self._changed[key] = at

    def snapshot_seen(self, now: float) -> None:
        """Absorb the current store state without marking anything changed --
        called after a run so its own state changes never re-trigger it."""
        for rec in self.arrivals.all():
            self._seen[rec["key"]] = self._signature(rec, now)

    def _due(self, now: float) -> list[str]:
        pending = []
        stale = []
        for key, at in self._changed.items():
            rec = self.arrivals.get(key)
            if rec is None or not self._offerable(rec, now):
                stale.append(key)   # a later flip to offerable re-marks it
                continue
            if not self._only_match(rec.get("source", ""), rec.get("source_id", ""), key):
                continue
            pending.append((rec.get("first_seen", 0), key, at))
        for key in stale:
            del self._changed[key]
        if not pending:
            return []
        if now - max(at for _, _, at in pending) < self.settings.debounce:
            return []
        pending.sort()
        return [key for _, key, _ in pending[: self.settings.max_arrivals_per_run]]

    # --- runs ------------------------------------------------------------------

    def _run_cycle(self, keys: list[str]) -> None:
        now = self.clock()
        self.last_run_started = now
        for k in keys:
            self._changed.pop(k, None)
        failed = True
        try:
            failed = execute_cycle(self, keys)
        except Exception:
            # e.g. finalize/summary/run-record/discard raising: the run's own
            # writes must still be absorbed and the keys held back, or they
            # look like changes and a paid re-run starts after `debounce`.
            logger.exception("librarian cycle crashed; holding its arrivals for retry_after")
        finally:
            # also on Stopping (BaseException), which then propagates
            after = self.clock()
            self.snapshot_seen(after)
            if failed:
                for k in keys:
                    self._retry_at[k] = after + self.settings.retry_after

    def set_run(self, run) -> None:
        """Open or close (run=None) the current run -- always under
        self.lock, which app/api.py's write handlers rely on."""
        with self.lock:
            self._run = run

    def call_runner(self, argv, **kw):
        self._in_runner = True
        try:
            if self._stop.is_set():
                raise Stopping()
            return self.runner(argv, on_tick=metrics.beat, **kw)
        finally:
            self._in_runner = False

    # --- notifications (Plan 2 Task 5) ----------------------------------------

    def notify_failure(self, arrival_rec: dict, intent: dict | None, detail: str) -> None:
        """Enqueue one push for a filing execution.py gave up on
        (arrival state FAILED). Idempotent on (arrival, intent), so a
        caller holding svc.lock -- every call site does -- may call this
        unconditionally without risking a duplicate push."""
        if self.notifier is None:
            return
        key = (arrival_rec or {}).get("key") or ""
        intent_id = (intent or {}).get("intent_id") or (arrival_rec or {}).get("exec_intent") or "unknown"
        hint = (arrival_rec or {}).get("title_hint") or key
        title = f"Filing failed: {_short_title(hint)}"
        body = notify.sanitize(str(detail or ""))
        self.notifier.enqueue("failure", f"failure:{key}:{intent_id}", title, body)

    def notify_escalation(self, arrival_rec: dict, intent: dict, *, suffix: str = "",
                          tail: str | None = None) -> None:
        """Enqueue one push for an escalation (a human decision is
        needed). `intent` is the ESCALATE intent record. The body carries
        the (untrusted, LLM-authored) question and `tail`: by default the
        arrival's Vikunja task URL (`arrival_rec["vikunja_url"]`, Task 6),
        else a note that Vikunja is disabled. msg_id is
        `escalation:<key>:<intent>` + `suffix` -- app/escalations.py uses a
        suffix for the follow-up push that carries a task link after a
        link-less one, or after a task was re-created."""
        if self.notifier is None:
            return
        key = (arrival_rec or {}).get("key") or ""
        intent_id = (intent or {}).get("intent_id") or "unknown"
        hint = (arrival_rec or {}).get("title_hint") or key
        title = f"Needs a decision: {_short_title(hint)}"
        payload = (intent or {}).get("payload") or {}
        question = payload.get("question") or (intent or {}).get("reason") or ""
        question = notify.truncate_utf8(notify.sanitize(str(question)), 600)
        if tail is None:
            vikunja_url = (arrival_rec or {}).get("vikunja_url")
            if vikunja_url:
                tail = vikunja_url
            elif self.vikunja is None:
                tail = "Vikunja is disabled \u2014 answer via the librarian's state"
            else:
                tail = "Vikunja task not created yet"
        body = f"{question}\n\n{notify.sanitize(tail)}"
        self.notifier.enqueue("escalation", f"escalation:{key}:{intent_id}{suffix}", title, body)

    # --- housekeeping --------------------------------------------------------

    def _prune_transcripts(self) -> None:
        cutoff = time.time() - TRANSCRIPT_MAX_AGE
        try:
            entries = list(os.scandir(self.transcript_dir))
        except FileNotFoundError:
            return
        for e in entries:
            try:
                if e.is_file(follow_symlinks=False) and e.stat(follow_symlinks=False).st_mtime < cutoff:
                    os.unlink(e.path)
            except OSError:
                logger.warning("could not prune transcript %s", e.path)

    def _prune_outbox(self) -> None:
        """Fix round 1: same cadence as `_prune_transcripts` (every tick) --
        drops sent/failed notification outbox records older than
        `notify.OUTBOX_MAX_AGE`; pending ones are never touched, however
        old. `Store.compact` already no-ops (no rewrite) when nothing is
        removed, so this is cheap on the common no-op tick."""
        if self.notifier is None:
            return
        try:
            self.notifier.prune()
        except OSError:
            logger.warning("could not prune notification outbox")
