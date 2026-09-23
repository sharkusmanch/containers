"""The librarian service: poll intake, stabilise, hash, dossier, debounce, run.

`Service` implements the Global `Core` protocol consumed by app/api.py
(`current_run`, `arrivals`, `intents`, `index`, `lists`, `load_dossier`,
`lock`) and owns the one `ApiServer` the sandboxed `claude -p` runs reach.
Run orchestration (launch, containment tripwire, review, finalize, summary)
lives in app/runs.py to keep this module to the loop itself.

DRY_RUN is hard-wired for this plan: `__init__` refuses `dry_run=False`
(tests and evals build `Settings` directly, bypassing `from_env`'s guard).

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
something about it changes. Being in-memory, a restart re-offers every
offerable arrival once, which is the intended "retry after restart".
"""
import functools
import hashlib
import json
import logging
import os
import threading
import time

from app import intake, metrics, states
from app.api import ApiServer
from app.dossier import _title_from_folder, build_dossier
from app.intents import IntentBook
from app.media import ffprobe_json
from app.policy import KidsLists, kids_signals
from app.runner import run_claude
from app.runs import execute_cycle
from app.store import Store

logger = logging.getLogger(__name__)

TRANSCRIPT_MAX_AGE = 30 * 86400


class Stopping(Exception):
    """Raised (by main.py's SIGTERM handler) into an in-flight runner so
    run_claude's cleanup kills the child and the cycle is discarded."""


def dossier_name(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".json"


class Service:
    def __init__(self, settings, *, index, api_factory=ApiServer, runner=run_claude,
                 prober=ffprobe_json, clock=time.time):
        if not settings.dry_run:
            raise SystemExit("live mode ships in plan P2")
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

        self._recover_interrupted()

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

    def _recover_interrupted(self) -> None:
        """A crash/SIGKILL mid-run leaves filing intents PROPOSED/APPROVED and
        their arrivals PROPOSED -- a state nothing ever offers again. A
        finished run never leaves a filing intent in either state (finalize
        simulates or rejects every one), so any found here are orphans."""
        with self.lock:
            for rec in self.intents.store.all():
                if rec.get("kind") in (states.ATTACH, states.CREATE_BOOK) and \
                        rec.get("state") in (states.PROPOSED_I, states.APPROVED):
                    self.intents.store.record(
                        rec["intent_id"], states.REJECTED,
                        review={"verdict": "reject", "argument": "service restarted mid-run"})
            for rec in self.arrivals.by_state(states.PROPOSED):
                self.arrivals.record(rec["key"], states.READY, detail="recovered after interrupted run")

    # --- tick ----------------------------------------------------------------

    def tick(self) -> None:
        metrics.beat()
        now = self.clock()
        try:
            self.index.refresh(now)
        except Exception:
            logger.exception("library index refresh failed; using cached index")
        metrics.INDEX_BOOKS.set(len(self.index.books()))
        self.lists = KidsLists.load(self.settings.lists_dir)
        if not self.lists.valid:
            logger.error("kids lists invalid (kids filings refused): %s", self.lists.error)

        self._intake(now)
        self._observe_changes(now)
        keys = self._due(now)
        if keys:
            self._run_cycle(keys)
        metrics.rebuild_arrivals(self.arrivals)
        self._prune_transcripts()

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
            if not self._only_match(c.source, c.source_id):
                continue
            try:
                self._intake_one(c, now)
            except Exception:
                # e.g. a BookOrbit error inside build_dossier: leave the
                # candidate unrecorded so the next tick retries it.
                logger.exception("intake of %s:%s failed; will retry", c.source, c.source_id)

    def _intake_one(self, c, now: float) -> None:
        if not self.stability.observe(c, now):
            return
        cid = (c.source, c.source_id)
        sig = intake._signature(c)
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
                "primary": primary, "sha256": sha, "title_hint": _title_from_folder(c)}

        err = intake.verify_sidecar(c, sha)
        if err:
            logger.error("arrival %s failed: %s", key, err)
            self.arrivals.record(key, states.FAILED, error=err, **base)
            return

        filed = {r["sha256"]: r.get("book_id") for r in self.arrivals.by_state(states.FILED)
                 if r.get("sha256")}
        verdict, info = intake.classify(key, c, sha, self.arrivals, filed)
        if verdict == "skip":
            return
        if verdict == "duplicate":
            book_id = info["book_id"]
            logger.info("arrival %s duplicates book %s", key, book_id)
            self.arrivals.record(key, states.DUPLICATE, book_id=book_id,
                                 would_do=[f"remove intake copy (identical to book {book_id})"], **base)
            return

        dossier = build_dossier(
            key, c, sha, self.index, prober=self.prober,
            kids=functools.partial(kids_signals, self.lists),
            previously_filed=info.get("previously_filed"),
        )
        self._write_dossier(key, dossier)
        self.arrivals.record(key, states.READY, **base)
        logger.info("arrival %s ready", key)

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
        for key, at in self._changed.items():
            rec = self.arrivals.get(key)
            if rec is None or not self._offerable(rec, now):
                continue
            if not self._only_match(rec.get("source", ""), rec.get("source_id", ""), key):
                continue
            pending.append((rec.get("first_seen", 0), key, at))
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
        failed = execute_cycle(self, keys)
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
