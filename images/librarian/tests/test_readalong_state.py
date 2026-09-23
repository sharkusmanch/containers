"""Read-along worker: settings and the state file."""
import json
import os

import pytest

from app.readalong.config import Settings
from app.readalong.state import State

ENV = {"BOOKORBIT_URL": "http://b/api/v1", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p",
       "STORYTELLER_URL": "http://st:8001", "STORYTELLER_USER": "su", "STORYTELLER_PASS": "sp",
       "APPRISE_URL": "http://apprise/notify/librarian"}


def test_settings_require_the_credentials_and_urls():
    s = Settings.from_env(ENV)
    assert (s.libraries, s.start_hours, s.run_hours, s.max_books, s.dry_run) == ((7, 8), 3.5, 5.5, 3, False)
    for key in ENV:
        with pytest.raises(ValueError, match=key):
            Settings.from_env({k: v for k, v in ENV.items() if k != key})


def test_settings_parse_only_dry_run_and_window():
    s = Settings.from_env({**ENV, "ONLY": "111, 292", "DRY_RUN": "true", "START_HOURS": "3",
                           "RUN_HOURS": "5", "LIBRARIES": "7"})
    assert s.only == frozenset({111, 292}) and s.dry_run and s.libraries == (7,)
    assert (s.start_hours, s.run_hours) == (3.0, 5.0)
    with pytest.raises(ValueError, match="START_HOURS"):
        Settings.from_env({**ENV, "START_HOURS": "6", "RUN_HOURS": "5"})


def test_missing_state_file_is_empty(tmp_path):
    st = State.load(str(tmp_path / "readalong.json"))
    assert st.in_flight is None and st.refused == {} and st.errors == {} and st.history == []


def test_a_corrupt_state_file_is_an_error_never_an_empty_state(tmp_path):
    """Empty would forget every refusal and re-align them all night."""
    p = tmp_path / "readalong.json"
    p.write_text('{"refused": {"292": ')
    with pytest.raises(RuntimeError, match="readalong.json"):
        State.load(str(p))


def test_refusal_only_holds_for_the_same_file_pair(tmp_path):
    st = State.load(str(tmp_path / "readalong.json"))
    st.refuse(292, (1, 100, 2, 200), "D", ["grade 'D'"], now=5)
    assert st.is_refused(292, (1, 100, 2, 200))
    assert not st.is_refused(292, (1, 101, 2, 200))      # the EPUB changed
    assert not st.is_refused(292, (9, 100, 2, 200))      # a different file
    assert not st.is_refused(293, (1, 100, 2, 200))


def test_error_count_resets_when_the_pair_changes(tmp_path):
    st = State.load(str(tmp_path / "readalong.json"))
    st.add_error(111, (1, 1, 2, 2), "scan timeout", now=1)
    st.add_error(111, (1, 1, 2, 2), "scan timeout", now=2)
    assert st.error_count(111, (1, 1, 2, 2)) == 2
    assert st.error_count(111, (1, 1, 2, 3)) == 0
    st.add_error(111, (1, 1, 2, 3), "x", now=3)
    assert st.error_count(111, (1, 1, 2, 3)) == 1


def test_save_round_trips_and_is_atomic(tmp_path, monkeypatch):
    p = tmp_path / "readalong.json"
    st = State.load(str(p))
    st.in_flight = {"book": 111, "uuid": "u", "pair": [1, 1, 2, 2]}
    st.refuse(292, (1, 100, 2, 200), "D", ["r"], now=5)
    st.record("published", 111, "S", now=6)
    st.save()
    again = State.load(str(p))
    assert again.in_flight["uuid"] == "u" and again.is_refused(292, (1, 100, 2, 200))
    assert again.history[-1]["outcome"] == "published"
    # a crash between writing the temp file and the rename leaves the old file intact
    st.in_flight = None
    monkeypatch.setattr(os, "replace", lambda a, b: (_ for _ in ()).throw(OSError("killed")))
    with pytest.raises(OSError):
        st.save()
    assert json.loads(p.read_text())["in_flight"]["uuid"] == "u"


def test_history_is_capped(tmp_path):
    st = State.load(str(tmp_path / "readalong.json"))
    for i in range(250):
        st.record("published", i, "S", now=i)
    assert len(st.history) == 200 and st.history[0]["book"] == 50



def test_a_second_run_exits_while_the_first_holds_the_lock(tmp_path):
    import fcntl
    from app.readalong.__main__ import main
    state = tmp_path / "state"
    state.mkdir()
    held = open(state / "readalong.lock", "w")
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert main({**ENV, "STATE_DIR": str(state)}) == 1       # never reaches the network
