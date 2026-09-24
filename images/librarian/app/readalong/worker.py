"""The read-along worker: one long-lived process (the librarian release's
`readalong` Deployment, one replica, the state on its own Longhorn PVC).

Its loop, every TICK_SECONDS:
  1. the NIGHTLY run -- once per local date, starting in [NIGHTLY_AT,
     NIGHTLY_UNTIL); the window keeps its start across restarts, so a restart
     resumes it and a finished night is never run again;
  2. else an ON-DEMAND run when `<state>/run-now` exists (`kubectl exec
     deploy/librarian-readalong -- touch /state/run-now`), removed after;
  3. else a TICK (Job.tick): the in-flight book once, and at most one book the
     librarian asked for (app/readalong/wanted.py).

Every unit is a fresh Job over a freshly loaded state; nothing is carried
between units. The process holds the state lock for its whole life: it is the
only writer. SIGTERM stops the unit in progress at its next safe point.
"""
import logging
import os
import time

from app.readalong import metrics
from app.readalong.config import hhmm
from app.readalong.job import Job, check_tools, m4b_seconds, send_push
from app.readalong.state import State

logger = logging.getLogger(__name__)

TICK_SAVE_EVERY = 600            # an idle tick's success is persisted at most this often
NIGHTLY_RETRY_DELAY = 1800       # a nightly that failed before doing anything is retried once, this much later


class Worker:
    def __init__(self, settings, *, bo, st, push=send_push, clock=time.time, sleep=time.sleep,
                 monotonic=time.monotonic, duration=m4b_seconds, tools=check_tools, localtime=time.localtime,
                 beat=metrics.beat):
        self.s, self.bo, self.st, self.push = settings, bo, st, push
        self.clock, self._sleep, self.monotonic = clock, sleep, monotonic
        self.duration, self.tools, self.localtime, self.beat = duration, tools, localtime, beat
        self.stopping = False
        self.job = None
        self.dry_nights = set()                  # DRY_RUN writes nothing: its nights are remembered here
        self.missed = set()                      # nights already logged as missed
        self.state_path = os.path.join(settings.state_dir, "readalong.json")
        self.run_now_path = os.path.join(settings.state_dir, "run-now")

    # signals and sleeping -----------------------------------------------------------------------
    def on_sigterm(self, *_):
        logger.warning("SIGTERM: stopping at the next safe point")
        self.stopping = True
        if self.job is not None:
            self.job.on_sigterm()

    def sleep(self, seconds):
        """A wait inside a unit of work: it really waits (a wait that returned
        at once after SIGTERM would turn every poll into a hot loop), beating
        the heartbeat (a wedged call does not)."""
        self._wait(seconds, interruptible=False)

    def _wait(self, seconds, *, interruptible):
        end = self.monotonic() + seconds
        while True:
            self.beat()
            left = end - self.monotonic()
            if left <= 0 or (interruptible and self.stopping):
                return
            self._sleep(min(left, 30))

    # scheduling -----------------------------------------------------------------------------------
    def _load(self):
        return State.load(self.state_path, required=self.s.state_required)

    def _night(self, now):
        lt = self.localtime(now)
        return time.strftime("%Y-%m-%d", lt), (lt.tm_hour, lt.tm_min)

    def next_unit(self):
        """(kind, window) for the next unit of work: ("nightly", (id, start)),
        ("now", (id, start)) or ("tick", None)."""
        now = self.clock()
        state = self._load()
        night, hm = self._night(now)
        ln = state.last_nightly
        if night in self.dry_nights:
            pass                                 # DRY_RUN: one look per night, whatever the state says
        elif ln.get("date") == night:
            if not ln.get("done") and now >= ln.get("retry_at", 0) \
                    and now - ln.get("started", now) < self.s.run_hours * 3600:
                return "nightly", (f"night-{night}", ln["started"])        # resumed, or its one retry
        elif hhmm(self.s.nightly_at) <= hm < hhmm(self.s.nightly_until):
            return "nightly", (f"night-{night}", now)
        elif hm >= hhmm(self.s.nightly_until) and night not in self.missed:
            self.missed.add(night)
            logger.warning("the nightly run of %s was missed and is skipped (the worker was not running %s-%s)",
                           night, self.s.nightly_at, self.s.nightly_until)
        if os.path.exists(self.run_now_path):
            return "now", (f"now-{int(now)}", now)
        return "tick", None

    # one unit of work -----------------------------------------------------------------------------
    def run_unit(self, kind, window):
        job = Job(self.s, bo=self.bo, st=self.st, push=self.push, clock=self.clock, sleep=self.sleep,
                  monotonic=self.monotonic, duration=self.duration, tools=self.tools, window=window)
        self.job = job
        if self.stopping:                        # SIGTERM arrived while the unit was being set up
            job.on_sigterm()
        night = self._night(window[1])[0] if kind == "nightly" else None
        if kind == "nightly":
            if self.s.dry_run:
                self.dry_nights.add(night)
            elif job.state.last_nightly.get("date") != night:
                job.state.last_nightly = {"date": night, "started": window[1], "done": False}
                job.state.save()
        if kind == "now":
            try:
                os.unlink(self.run_now_path)     # taken: a request made during the run is a new one
            except FileNotFoundError:
                pass
        nothing_ran = False
        try:
            rc = job.tick() if kind == "tick" else job.run()
        except Exception as e:                   # the listing, a login: nothing ran
            logger.exception("read-along %s failed", kind)
            rc, nothing_ran = 1, True
            if kind == "tick":
                job._tick_failed(e)
            elif not self.s.dry_run:
                self._run_failed(job, window, e)
        finally:
            self.job = None
        self._record(job, kind, rc, night, nothing_ran)
        return rc

    def _run_failed(self, job, window, e):
        """Told once per window, like a failure inside Job.run()."""
        if job.state.run.get("id") != window[0]:
            job.state.run = {"id": window[0], "started": window[1]}
        if not job.state.run.get("failure_told"):
            job.state.run["failure_told"] = True
            job._tell(f"⚠️ run failed: {type(e).__name__}: {str(e)[:150]}")
        job.report()

    def _record(self, job, kind, rc, night, nothing_ran=False):
        now = self.clock()
        outcome = "ok" if rc == 0 else "failed"
        metrics.RUNS.labels(kind=kind, outcome=outcome).inc()
        if self.s.dry_run:
            if rc == 0:
                metrics.LAST_SUCCESS.labels(kind=kind).set(now)
            return
        dirty = False
        ln = job.state.last_nightly
        if kind == "nightly" and ln.get("date") == night and (job.completed or not self.stopping):
            # A run that reached its end is done, even if SIGTERM came during its push.
            # Stopped earlier (a rollout): left open, the next pod resumes it. Failed before
            # doing anything (BookOrbit or Storyteller unreachable): one retry. Else done.
            if nothing_ran and rc != 0 and not ln.get("attempts"):
                ln.update(attempts=1, retry_at=now + NIGHTLY_RETRY_DELAY)
            else:
                ln["done"] = True
            dirty = True
        if rc == 0:
            metrics.LAST_SUCCESS.labels(kind=kind).set(now)
            if kind != "tick" or now - job.state.last_success.get("tick", 0) >= TICK_SAVE_EVERY:
                job.state.last_success[kind] = now
                dirty = True
        if dirty:
            job.state.save()

    # the loop -------------------------------------------------------------------------------------
    def serve(self):
        state = self._load()                     # fails fast on a missing or torn state
        if "nightly" not in state.last_success and not self.s.dry_run:
            # First start: count it as the last nightly success, so "no nightly success
            # for two nights" can fire for a worker that never succeeds (the alert rule).
            state.last_success["nightly"] = self.clock()
            state.save()
        for k, ts in state.last_success.items():
            if k in metrics.KINDS and isinstance(ts, (int, float)):
                metrics.LAST_SUCCESS.labels(kind=k).set(ts)
        logger.info("read-along worker up: nightly %s-%s, ticks every %d s%s", self.s.nightly_at,
                    self.s.nightly_until, self.s.tick_seconds, " (DRY RUN)" if self.s.dry_run else "")
        while not self.stopping:
            self.beat()
            kind, window = self.next_unit()
            if self.stopping:
                break
            if kind != "tick":
                logger.info("%s run %s", kind, window[0])
            self.run_unit(kind, window)
            self._wait(self.s.tick_seconds, interruptible=True)
        return 0
