"""Read-along worker: the long-lived loop -- the nightly run once per local
date (resumed, never repeated), on-demand runs, ticks, metrics, SIGTERM."""
import json
import os
import time

import pytest
from prometheus_client import REGISTRY

from app.readalong.config import Settings
from app.readalong.state import State
from app.readalong.worker import Worker
from tests.readalong_fakes import FakeLibrary
from tests.test_readalong_job import ENV, Clock, FakeStoryteller

T0 = 1_800_000_000.0                                   # 2027-01-15 08:00 UTC (the tests' local time is UTC)
NIGHT = T0 - (7 * 3600 + 25 * 60)                      # 2027-01-15 00:35


def sample(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0.0


@pytest.fixture
def wenv(tmp_path):
    books = tmp_path / "books"
    lib = FakeLibrary(books)
    lib.add_book(111, "Joe Abercrombie/The Age of Madness/01. A Little Hatred",
                 [(11, "01. A Little Hatred.epub", b"PLAIN"), (12, "01. A Little Hatred.m4b", b"AUDIO" * 20)],
                 title="A Little Hatred", updatedAt="2026-09-20T10:00:00.000Z",
                 customMetadata=[{"fieldId": 2, "value": False}])
    clock = Clock()
    st = FakeStoryteller(clock, library_root=books)
    pushes, beats = [], []

    def make(**extra):
        s = Settings.from_env({**ENV, "STATE_DIR": str(tmp_path / "state"), "MEDIA_BOOKS": str(books),
                               "STAGING_DIR": str(tmp_path / "staging"), "WANTED_DIR": str(tmp_path / "wanted"),
                               "STATE_REQUIRED": "false", **extra})
        os.makedirs(s.state_dir, exist_ok=True)
        return Worker(s, bo=lib, st=st, push=lambda url, t, b: pushes.append((t, b)) or True, clock=clock,
                      sleep=clock.sleep, monotonic=clock, duration=lambda path: 40.0, tools=lambda: None,
                      localtime=time.gmtime, beat=lambda: beats.append(clock.t))
    return lib, st, clock, pushes, make, tmp_path, beats


def state_of(tmp):
    return json.load(open(tmp / "state" / "readalong.json"))


def has_readalong(lib, bid):
    return any(f["mediaOverlay"]["available"] for f in lib.detail(bid)["files"])


def test_the_nightly_runs_once_per_local_date(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    clock.t = NIGHT
    w = make()
    kind, window = w.next_unit()
    assert (kind, window) == ("nightly", ("night-2027-01-15", NIGHT))
    assert w.run_unit(kind, window) == 0 and has_readalong(lib, 111)
    ln = state_of(tmp)["last_nightly"]
    assert ln == {"date": "2027-01-15", "started": NIGHT, "done": True}
    clock.t += 600
    assert w.next_unit() == ("tick", None)             # done: never a second nightly that date
    clock.t = NIGHT + 24 * 3600
    assert w.next_unit()[0] == "nightly"               # the next night is new


def test_a_restart_resumes_an_unfinished_nightly_with_its_start(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    s = State.load(str(tmp / "state" / "readalong.json"))
    s.last_nightly = {"date": "2027-01-15", "started": NIGHT, "done": False}
    os.makedirs(tmp / "state", exist_ok=True)
    s.save()
    clock.t = NIGHT + 3600
    assert make().next_unit() == ("nightly", ("night-2027-01-15", NIGHT))
    clock.t = NIGHT + 6 * 3600                         # past RUN_HOURS: over, not resumed
    assert make().next_unit() == ("tick", None)


@pytest.mark.parametrize("when", [NIGHT - 30 * 60, T0 - 3 * 3600 - 50 * 60])   # 00:05, and 04:10
def test_outside_the_nightly_window_it_ticks(wenv, when):
    lib, st, clock, pushes, make, tmp, beats = wenv
    clock.t = when
    assert make().next_unit() == ("tick", None)


def test_an_on_demand_run_is_taken_once(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    (tmp / "state").mkdir(exist_ok=True)
    (tmp / "state" / "run-now").write_text("")
    w = make()
    kind, window = w.next_unit()
    assert kind == "now" and window[0] == f"now-{int(T0)}"
    assert w.run_unit(kind, window) == 0 and has_readalong(lib, 111)
    assert not (tmp / "state" / "run-now").exists() and w.next_unit() == ("tick", None)
    assert "last_nightly" not in state_of(tmp) or state_of(tmp)["last_nightly"] == {}


def test_counts_and_last_success(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    w = make()
    ok0, failed0 = sample("librarian_readalong_runs_total", kind="tick", outcome="ok"), \
        sample("librarian_readalong_runs_total", kind="nightly", outcome="failed")
    assert w.run_unit("tick", None) == 0
    assert sample("librarian_readalong_runs_total", kind="tick", outcome="ok") == ok0 + 1
    assert sample("librarian_readalong_last_success_timestamp_seconds", kind="tick") == T0
    assert state_of(tmp)["last_success"]["tick"] == T0

    def down():
        raise RuntimeError("POST /books/query -> HTTP 502")
    lib.books_by_id = down
    clock.t = NIGHT + 24 * 3600
    kind, window = w.next_unit()
    assert w.run_unit(kind, window) == 1
    assert sample("librarian_readalong_runs_total", kind="nightly", outcome="failed") == failed0 + 1
    assert len([b for _t, b in pushes if "run failed" in b]) == 1
    ln = state_of(tmp)["last_nightly"]
    assert ln["done"] is False and ln["attempts"] == 1               # nothing ran: one retry ...
    clock.t += 600
    assert w.next_unit() == ("tick", None)                           # ... after 30 minutes
    clock.t += 1200
    kind, window = w.next_unit()
    assert kind == "nightly" and window[1] == NIGHT + 24 * 3600      # the same night, its own start
    assert w.run_unit(kind, window) == 1
    assert state_of(tmp)["last_nightly"]["done"] is True             # failed again: the night is over
    assert len([b for _t, b in pushes if "run failed" in b]) == 1    # told once per night


def test_last_success_survives_a_restart(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    (tmp / "state").mkdir(exist_ok=True)
    s = State.load(str(tmp / "state" / "readalong.json"))
    s.last_success = {"nightly": 1234.0}
    s.save()
    w = make()
    w._sleep = lambda seconds: w.on_sigterm()           # one pass of the loop, then SIGTERM
    assert w.serve() == 0
    assert sample("librarian_readalong_last_success_timestamp_seconds", kind="nightly") == 1234.0


def test_a_dry_run_nightly_is_not_repeated_and_writes_nothing(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    clock.t = NIGHT
    w = make(DRY_RUN="true")
    kind, window = w.next_unit()
    assert kind == "nightly" and w.run_unit(kind, window) == 0
    assert w.next_unit() == ("tick", None)
    assert not (tmp / "state" / "readalong.json").exists() and st.calls == [("login",)]


def test_sigterm_stops_the_unit_in_progress(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    st.polls_until_done = 10 ** 6
    clock.t = NIGHT
    w = make()
    real = w._sleep

    def sleep(seconds):
        w.on_sigterm()
        real(seconds)
    w._sleep = sleep
    kind, window = w.next_unit()
    assert w.run_unit(kind, window) == 0
    assert w.stopping and state_of(tmp)["in_flight"]["uuid"] == "u1"
    assert state_of(tmp)["last_nightly"]["done"] is False             # a rollout: the next pod resumes it
    clock.t += 300
    assert make().next_unit() == ("nightly", ("night-2027-01-15", NIGHT))


def test_waits_beat_the_heartbeat(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    w = make()
    t = clock.t
    w.sleep(95)
    assert clock.t == t + 95 and len(beats) >= 4



def test_an_idle_tick_resends_an_undelivered_push(wenv):
    lib, st, clock, pushes, make, tmp, beats = wenv
    (tmp / "state").mkdir(exist_ok=True)
    s = State.load(str(tmp / "state" / "readalong.json"))
    s.pending_push = {"lines": ["📖🎧 X — read-along published (grade S)"], "published": 1, "refused": 0}
    s.save()
    assert make().run_unit("tick", None) == 0
    assert pushes and "1 published" in pushes[-1][0] and state_of(tmp)["pending_push"] is None
