# Regression tests from the code review of the long-lived worker (2026-09-23).
"""Adversarial review (rv7) of 389811d -- the worker loop. A FAIL is a finding."""
import logging
import os
import subprocess
import sys

from app.readalong.state import State
from tests.test_readalong_worker import NIGHT, T0, has_readalong, state_of, wenv  # noqa: F401
from tests.test_readalong_tick import ask, asked  # noqa: F401


# --- W1: after SIGTERM every wait inside a unit is a no-op -> hot loops ------------------------
def test_sigterm_mid_publish_does_not_hot_loop_bookorbit(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    st.polls_until_done = 1
    w = make()
    ask(tmp, 111, clock.t - 400)
    assert w.run_unit("tick", None) == 0                    # started
    clock.t += 60
    calls = []

    def scan_running(library_id):                           # someone else's scan is running ...
        calls.append(clock.t)
        if len(calls) > 3000:
            raise RuntimeError("hot loop")
        return w.stopping                                   # ... from the moment the rollout's SIGTERM lands
    lib.scan_running = scan_running
    lib.hook_before_scan = lambda fake: w.on_sigterm()      # SIGTERM during the publish's scan
    w.run_unit("tick", None)
    print(f"scan-history GETs after SIGTERM: {len(calls)}, fake time elapsed: {max(calls) - min(calls)} s")
    assert len(calls) < 100                                 # sleep(10) against a 600 s deadline: ~60 at most


def test_sigterm_during_a_nightly_poll_does_not_hot_loop(wenv):
    """SIGTERM between next_unit() and run_unit() (or during Job construction):
    worker.stopping is set but the new Job never hears it, and worker.sleep is a no-op."""
    lib, st, clock, pushes, make, tmp, beats = wenv
    st.polls_until_done = 10 ** 6
    clock.t = NIGHT
    w = make()
    kind, window = w.next_unit()
    w.on_sigterm()                                          # lands before run_unit builds its Job
    polls = []
    real = st.book

    def book(uuid):
        polls.append(clock.t)
        if len(polls) > 3000:
            raise KeyboardInterrupt("hot loop")
        return real(uuid)
    st.book = book
    try:
        w.run_unit(kind, window)
    except KeyboardInterrupt:
        pass
    print(f"ran a {kind} after SIGTERM; Storyteller polls: {len(polls)} over {clock.t - NIGHT} fake s")
    assert len(polls) < 10


# --- W2: DRY_RUN re-runs an open night every minute ---------------------------------------------
def test_dry_run_does_not_rerun_an_open_night_every_loop(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    (tmp / "state").mkdir(exist_ok=True)
    s = State.load(str(tmp / "state" / "readalong.json"))
    s.last_nightly = {"date": "2027-01-15", "started": NIGHT, "done": False}   # a real night cut by the rollout
    s.save()
    clock.t = NIGHT + 600
    w = make(DRY_RUN="true")
    kinds = []
    for _ in range(10):
        kind, window = w.next_unit()
        kinds.append(kind)
        w.run_unit(kind, window)
        clock.t += 60
    logins = sum(1 for c in st.calls if c == ("login",))
    print("units:", kinds, "storyteller logins:", logins)
    assert kinds.count("nightly") <= 1


# --- W3: the Stale alert assumes the first start is recorded as a success ---------------------
def test_first_start_publishes_a_nightly_last_success(tmp_path):
    """prometheus-rule.yaml (private, uncommitted): 'The worker records its first start as a
    success, so a worker that never succeeds shows too.' Fresh registry in a subprocess."""
    code = r"""
import os, sys, time
sys.path.insert(0, "/config/home-ops/docker-images-readalong/images/librarian")
from prometheus_client import REGISTRY
from app.readalong.config import Settings
from app.readalong.worker import Worker
from app.readalong.state import State
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
State(os.path.join(d, "readalong.json"), {"in_flight": None}).save()   # the CronJob-era state: no last_success
env = {"BOOKORBIT_URL": "b", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p", "STORYTELLER_URL": "s",
       "STORYTELLER_USER": "u", "STORYTELLER_PASS": "p", "APPRISE_URL": "a", "STATE_DIR": d,
       "WANTED_DIR": os.path.join(d, "w"), "STATE_REQUIRED": "true"}
w = Worker(Settings.from_env(env), bo=None, st=None, localtime=time.gmtime, clock=lambda: 1_800_000_000.0,
           beat=lambda: None)
w._sleep = lambda s: w.on_sigterm()
w.serve()
print(REGISTRY.get_sample_value("librarian_readalong_last_success_timestamp_seconds", {"kind": "nightly"}))
"""
    out = subprocess.run([sys.executable, "-c", code, str(tmp_path / "state")], capture_output=True, text=True)
    print(out.stdout, out.stderr[-500:])
    assert out.stdout.strip().splitlines()[-1] != "None"


# --- W4: a missed night is skipped silently (the plan: "skipped and logged") -------------------
def test_a_missed_night_is_logged(wenv, caplog):
    lib, st, clock, pushes, make, tmp, beats = wenv
    clock.t = T0 - 3 * 3600 - 50 * 60                       # 04:10, the pod was down across 00:30
    caplog.set_level(logging.INFO)
    assert make().next_unit() == ("tick", None)
    print([r.getMessage() for r in caplog.records])
    assert any("skip" in r.getMessage() for r in caplog.records)


# --- DST sanity (expected to PASS): once per local date, resume across the repeated hour --------
def test_dst_days_in_los_angeles(wenv):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    la = ZoneInfo("America/Los_Angeles")
    lib, st, clock, pushes, make, tmp, beats = wenv

    def at(y, mo, d, h, mi, fold=0):
        return datetime(y, mo, d, h, mi, fold=fold, tzinfo=la).timestamp()
    loc = lambda t: datetime.fromtimestamp(t, la).timetuple()          # noqa: E731
    # fall back 2027-11-07: started 00:30 PDT, SIGTERM at 01:45 PDT, back at 01:10 PST (clock went back)
    clock.t = at(2027, 11, 7, 0, 30)
    w = make()
    w.localtime = loc
    kind, window = w.next_unit()
    assert kind == "nightly"
    s = State.load(str(tmp / "state" / "readalong.json"))
    s.last_nightly = {"date": "2027-11-07", "started": window[1], "done": False}
    s.save()
    clock.t = at(2027, 11, 7, 1, 10, fold=1)
    w2 = make()
    w2.localtime = loc
    assert w2.next_unit() == ("nightly", ("night-2027-11-07", window[1]))
    s.last_nightly["done"] = True
    s.save()
    clock.t = at(2027, 11, 7, 1, 35, fold=1)
    assert w2.next_unit() == ("tick", None)
    # spring forward 2027-03-14: down across 02:00, up at 03:05 PDT -> still inside [00:30, 04:00)
    clock.t = at(2027, 3, 14, 3, 5)
    assert w2.next_unit()[0] == "nightly"


# --- W5: a SIGTERM that lands after the nightly finished (during its push) repeats the night -----
def test_a_finished_night_cut_during_its_push_is_not_repeated(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    clock.t = NIGHT
    w = make()

    def push(url, title, body):                           # the rollout lands while the summary is sent
        w.on_sigterm()
        pushes.append((title, body))
        return True
    w.push = push
    kind, window = w.next_unit()
    assert w.run_unit(kind, window) == 0 and has_readalong(lib, 111)
    ln = state_of(tmp)["last_nightly"]
    clock.t += 300
    again = make().next_unit()
    print("last_nightly:", ln, "| next pod:", again)
    assert again == ("tick", None)                        # all of tonight's work was done
