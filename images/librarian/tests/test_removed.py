"""An arrival whose intake copy a human removed (2026-10-01).

A duplicate the owner deleted from `manual/` by hand left its arrival in
needs-decision for good: out of deferrals it could only escalate again, and a
task closed by hand was re-created within the hour. An OPEN arrival (ready,
needs-decision, answered, deferred) whose intake copy has been gone for
REMOVED_CONFIRM seconds is now retired as `removed`: its Vikunja task is closed,
one summary line says so, and the same file dropped again is taken in afresh."""
import logging
import os
import shutil

import pytest

from app import escalations, fsops, runs, states
from app.service import REMOVED_CONFIRM, RETURN_LIMIT
from app.store import Store
from tests.test_escalations import BO, _task, env, escalate, outbox  # noqa: F401
from tests.test_service import (Clock, FakeModel, add_libation, attach_script, metric, only_key,  # noqa: F401
                                svc_factory)

WAIT = REMOVED_CONFIRM + 1


def real_intake(tmp_path):
    """The librarian's own staging folder: what tells its intake from a fresh or wrong mount."""
    (tmp_path / "intake" / fsops.EXECUTING_DIR).mkdir(parents=True, exist_ok=True)


def needs_decision(tmp_path, svc_factory, **kw):
    """One libation arrival the reviewer never ruled on: needs-decision."""
    model = FakeModel(librarian=attach_script(), reviewer=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock, **kw)
    real_intake(tmp_path)
    folder = add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.NEEDS_DECISION
    return svc, clock, model, key, folder


def state(svc, key):
    return svc.arrivals.get(key)["state"]


def test_an_open_arrival_whose_copy_was_removed_is_retired_after_the_wait(tmp_path, svc_factory, caplog):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    shutil.rmtree(folder)
    svc.tick()                                         # first seen gone
    clock.t += REMOVED_CONFIRM - 5
    svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION    # not yet: it may be on its way back
    clock.t += 10
    with caplog.at_level(logging.INFO):
        svc.tick()
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.REMOVED and rec["detail"] == "removed from intake"
    assert rec.get("human_answer") is None and rec.get("not_before") is None
    assert "retired as removed" in caplog.text
    assert "nothing filed" not in caplog.text          # a dry run (the default here) pushes no summary
    assert metric("librarian_arrivals", state="removed") == 1
    assert model.calls == ["librarian", "reviewer"]    # no new run for it


def test_a_copy_that_comes_back_restarts_the_wait(tmp_path, svc_factory):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    shutil.rmtree(folder)
    svc.tick()
    clock.t += REMOVED_CONFIRM - 5
    add_libation(tmp_path)                             # the same bytes, back
    svc.tick()
    shutil.rmtree(folder)
    clock.t += 10                                      # > REMOVED_CONFIRM since the FIRST disappearance
    svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION
    clock.t += WAIT
    svc.tick()
    assert state(svc, key) == states.REMOVED


def test_an_intake_that_cannot_be_listed_retires_nothing(tmp_path, svc_factory):
    """/media not mounted: the source dir is gone too. Unknown is never 'removed'."""
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    shutil.rmtree(tmp_path / "intake" / "libation")
    for _ in range(4):
        clock.t += WAIT
        svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION
    shutil.rmtree(tmp_path / "intake")                 # the whole root
    for _ in range(4):
        clock.t += WAIT
        svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION


def test_a_staged_copy_is_not_removed(tmp_path, svc_factory):
    """The executor moved it under .executing/: it is being filed, not gone."""
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    staging = fsops.staging_dir(svc.settings.intake_root, key)
    os.makedirs(os.path.dirname(staging), exist_ok=True)
    os.rename(folder, staging)
    for _ in range(3):
        clock.t += WAIT
        svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION


def test_an_intake_without_the_librarians_own_folder_retires_nothing(tmp_path, svc_factory, caplog):
    """A fresh or wrong export with empty source folders is not the intake it filed from."""
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    shutil.rmtree(folder)
    os.rmdir(tmp_path / "intake" / fsops.EXECUTING_DIR)
    with caplog.at_level(logging.WARNING):
        for _ in range(4):
            clock.t += WAIT
            svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION
    assert caplog.text.count("nothing is retired as removed") == 1      # said once, not every tick


def test_an_arrival_whose_copy_is_gone_is_not_run_while_it_waits(tmp_path, svc_factory):
    """The owner answered, then deleted the file: a run would only fail on the missing copy."""
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    svc.arrivals.record(key, states.ANSWERED, human_answer={"text": "1", "option": 1})
    shutil.rmtree(folder)
    for _ in range(6):                                 # well past the debounce, short of the wait
        clock.t += 90
        svc.tick()
    assert model.calls == ["librarian", "reviewer"] and state(svc, key) == states.ANSWERED
    clock.t += 200
    svc.tick()
    assert state(svc, key) == states.REMOVED and model.calls == ["librarian", "reviewer"]


def test_an_answered_arrival_whose_copy_came_back_is_run_after_all(tmp_path, svc_factory):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    svc.arrivals.record(key, states.ANSWERED, human_answer={"text": "1", "option": 1})
    shutil.rmtree(folder)
    svc.tick()
    add_libation(tmp_path)
    for dt in (1, 11, 11):
        clock.t += dt
        svc.tick()
    assert model.calls[:3] == ["librarian", "reviewer", "librarian"]


def test_a_single_manual_file_goes_the_same_way(tmp_path, svc_factory):
    model = FakeModel(librarian=attach_script(), reviewer=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock)
    real_intake(tmp_path)
    manual = tmp_path / "intake" / "manual"
    manual.mkdir(parents=True)
    (manual / "Shards of Earth.m4b").write_bytes(b"AUDIO" * 100)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    assert key.startswith("manual:Shards of Earth.m4b:") and state(svc, key) == states.NEEDS_DECISION
    os.remove(manual / "Shards of Earth.m4b")
    svc.tick()
    clock.t += WAIT
    svc.tick()
    assert state(svc, key) == states.REMOVED


def test_a_restart_starts_the_wait_again(tmp_path, svc_factory):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    shutil.rmtree(folder)
    svc.tick()
    svc.stop()
    clock.t += WAIT                                    # gone for long enough -- but nobody watched
    again = svc_factory(FakeModel(), clock)
    again.tick()
    assert state(again, key) == states.NEEDS_DECISION
    clock.t += WAIT
    again.tick()
    assert state(again, key) == states.REMOVED


def test_a_file_that_keeps_coming_back_is_taken_in_only_so_often(tmp_path, svc_factory, caplog):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    for n in range(RETURN_LIMIT + 1):
        shutil.rmtree(folder)
        svc.tick()
        clock.t += WAIT
        svc.tick()
        assert state(svc, key) == states.REMOVED
        add_libation(tmp_path)
        with caplog.at_level(logging.WARNING):
            for dt in (1, 1, 11):
                clock.t += dt
                svc.tick()
        assert (state(svc, key) == states.REMOVED) is (n == RETURN_LIMIT)
    assert model.calls == ["librarian", "reviewer"] * (1 + RETURN_LIMIT)       # no paid run for the last one
    assert caplog.text.count("this copy is left in the intake untouched") == 1


def test_an_older_image_loads_a_store_holding_a_removed_arrival(tmp_path):
    """Rollback: Store checks a state only when it records one, and no older code path
    records on an arrival it does not know the state of -- it is simply inert there."""
    path = str(tmp_path / "arrivals.jsonl")
    Store(path, "key", states.ARRIVAL_STATES).record("manual:x:1", states.REMOVED, source="manual")
    old = Store(path, "key", states.ARRIVAL_STATES - {states.REMOVED})
    assert old.get("manual:x:1")["state"] == "removed" and old.counts() == {"removed": 1}
    with pytest.raises(ValueError):
        old.record("manual:x:1", "removed")


def test_only_open_arrivals_are_retired(tmp_path, svc_factory):
    svc = svc_factory(FakeModel(), Clock())
    real_intake(tmp_path)
    manual = tmp_path / "intake" / "manual"
    manual.mkdir(parents=True)
    closed = (states.PROPOSED, states.RETRYABLE, states.EXECUTING, states.FILED, states.FAILED,
              states.DUPLICATE, states.SIMULATED, states.REMOVED)
    opened = (states.READY, states.NEEDS_DECISION, states.ANSWERED, states.DEFERRED)
    for st in closed + opened:
        svc.arrivals.record(f"manual:{st}.m4b:1", st, source="manual", source_id=f"{st}.m4b",
                            path=str(manual / f"{st}.m4b"), not_before=10 ** 12)
    retired = set(svc._retire_removed(1000.0)) | set(svc._retire_removed(1000.0 + WAIT))
    assert retired == {f"manual:{st}.m4b:1" for st in opened}
    for st in closed:
        assert state(svc, f"manual:{st}.m4b:1") == st


def test_a_path_the_librarian_cannot_place_is_left_alone(tmp_path, svc_factory):
    svc = svc_factory(FakeModel(), Clock())
    real_intake(tmp_path)
    (tmp_path / "intake" / "manual").mkdir(parents=True)
    odd = {"none": None, "nested": str(tmp_path / "intake" / "manual" / "sub" / "x.m4b"),
           "elsewhere": str(tmp_path / "x.m4b"), "wrong-source": str(tmp_path / "intake" / "kindle" / "x.epub")}
    for name, path in odd.items():
        svc.arrivals.record(f"manual:{name}:1", states.NEEDS_DECISION, source="manual", source_id=name, path=path)
    svc._retire_removed(1000.0)
    assert svc._retire_removed(1000.0 + WAIT) == []


def test_a_removed_file_dropped_again_is_taken_in_afresh(tmp_path, svc_factory):
    svc, clock, model, key, folder = needs_decision(tmp_path, svc_factory)
    svc.arrivals.record(key, states.NEEDS_DECISION, human_answer={"text": "skip", "option": 2},
                        vikunja_create_failures=3, vikunja_create_failed_since=5.0)
    shutil.rmtree(folder)
    svc.tick()
    clock.t += WAIT
    svc.tick()
    assert state(svc, key) == states.REMOVED
    os.remove(os.path.join(svc.dossier_dir, os.listdir(svc.dossier_dir)[0]))
    add_libation(tmp_path)                             # the owner changed their mind
    for dt in (1, 1, 11):
        clock.t += dt
        svc.tick()
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.NEEDS_DECISION       # offered, run, escalated again
    assert model.calls == ["librarian", "reviewer"] * 2
    assert rec.get("human_answer") is None
    assert rec["vikunja_create_failures"] == 0 and rec["vikunja_create_failed_since"] is None
    assert any(h.get("note") == "back in intake (was removed)" for h in rec.get("history") or [])
    assert svc.load_dossier(key) is not None           # a fresh dossier, as intake builds one
    for _ in range(3):                                 # and it does not flap
        clock.t += WAIT
        svc.tick()
    assert state(svc, key) == states.NEEDS_DECISION and model.calls == ["librarian", "reviewer"] * 2


# --- Vikunja -----------------------------------------------------------------------------------

def test_the_task_of_a_removed_arrival_is_closed_and_not_asked_again(tmp_path, env):
    clock = Clock()
    svc, fake = env(clock=clock)
    real_intake(tmp_path)
    manual = tmp_path / "intake" / "manual"
    manual.mkdir(parents=True)
    svc.arrivals.record("manual:x:1", states.NEEDS_DECISION, source="manual", source_id="x",
                        title_hint="Shards of Earth", path=str(manual / "x"))
    escalate(svc, title="Shards of Earth")
    svc.tick()
    tid = _task(svc)
    clock.t += WAIT
    svc.tick()
    svc.tick()
    rec = svc.arrivals.get("manual:x:1")
    assert rec["state"] == states.REMOVED and rec["vikunja_closed"] is True
    assert fake.tasks[tid]["done"] is True
    closing = [c["comment"] for c in fake.comments[tid] if "Removed from intake" in c["comment"]]
    assert len(closing) == 1 and "Nothing was filed" in closing[0]
    late = [m for m in outbox(svc) if m["kind"] == "summary"]             # live: one "(later)" push
    assert len(late) == 1 and late[0]["title"].endswith("1 removed from intake")
    assert "🗑️ Shards of Earth — removed from intake, nothing filed" in late[0]["body"]
    n = len(fake.tasks)
    for _ in range(3):                                 # the hourly "closed by hand" re-creation no longer applies
        clock.t += 4000
        svc.tick()
    assert len(fake.tasks) == n


def test_outcome_text_and_summary_line_for_a_removed_arrival():
    rec = {"state": states.REMOVED, "key": "manual:x:1", "title_hint": "Shards of Earth", "primary": "x.m4b"}
    assert escalations.outcome_text(rec, BO) == (
        "Removed from intake: the file is no longer there. Nothing was filed. Closing.")
    assert states.REMOVED in escalations.TERMINAL and states.REMOVED in states.ARRIVAL_STATES
    assert states.REMOVED not in states.OFFERABLE

    class Svc:
        settings = type("S", (), {"live_sources": ("manual",), "dry_run": False})()
        index = None
    assert runs._line(Svc(), rec, rec["key"], {}) == "🗑️ Shards of Earth — removed from intake, nothing filed"
