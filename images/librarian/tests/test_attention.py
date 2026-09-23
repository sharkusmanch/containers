"""Final review I1: executor escalations on arrivals that need no decision
(filed but needs a look, failed, metadata correction failed) reach the
human -- a push `attention:<arrival>:<intent>` (a failed filing keeps its
own failure push instead) and a Vikunja task "Librarian needs a look" --
and filings finished outside a run cycle get a "late" summary push."""
import logging

import pytest

from app import states
from app.executor import ExecResult
from app.notify import OUTBOX_STATES, Notifier
from app.store import Store
from app.vikunja import Vikunja
from tests.test_live import (  # noqa: F401 (live_factory is a fixture)
    Clock, FakeExecutor, FakeModel, add_libation, approve_all, attach_and_update_script,
    attach_script, create_script, drive, failed, filed, filing_intent, live_factory, only_key,
    retryable,
)
from tests.test_notify import FakeSession
from tests.test_vikunja import BASE, PUBLIC, TOKEN, FakeVikunjaSession


@pytest.fixture
def wired(tmp_path, live_factory):
    def make(results=(), update_results=(), *, vikunja=True, model=None, clock=None, **kw):
        outbox = Store(str(tmp_path / "state" / "outbox.jsonl"), "msg_id", OUTBOX_STATES)
        nt = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
        fake = FakeVikunjaSession()
        vk = None
        if vikunja:
            store = Store(str(tmp_path / "state" / "vikunja.jsonl"), "comment_id", frozenset({"ours"}))
            vk = Vikunja(BASE, TOKEN, 5, PUBLIC, store, session=fake)
        clock = clock or Clock()
        fx = FakeExecutor(list(results), list(update_results))
        svc = live_factory(model or FakeModel(librarian=attach_script(), reviewer=approve_all),
                           fx, clock, notifier=nt, vikunja=vk, **kw)
        return svc, fx, fake, clock
    return make


def pushes(svc, kind=None):
    return [r for r in svc.notifier.outbox.all() if kind is None or r["kind"] == kind]


def test_filed_with_escalate_pushes_attention_and_opens_a_task(tmp_path, wired, caplog):
    caplog.set_level(logging.INFO)
    svc, fx, fake, clock = wired([filed(escalate="rename-files skipped for book 2: collision at /media/books/x")])
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    intent = filing_intent(svc, key)
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.FILED

    [p] = pushes(svc, "attention")
    assert p["msg_id"] == f"attention:{key}:{intent['intent_id']}"
    assert p["title"] == "Librarian needs a look: Artificial Condition"
    assert "rename-files skipped" in p["body"] and "/media/books/x" in p["body"]

    [task] = fake.tasks.values()
    assert task["title"] == "Librarian needs a look: Artificial Condition"
    assert "rename-files skipped" in task["description"] and key in task["description"]
    assert task["done"] is False                           # left open for the human
    [item] = rec["attention"]
    assert item["task_id"] in fake.tasks
    assert "needs a look — see task" in caplog.text

    svc.tick()
    svc.tick()
    assert len(fake.tasks) == 1 and len(pushes(svc, "attention")) == 1   # once


def test_failed_filing_gets_a_task_but_no_second_push(tmp_path, wired, caplog):
    caplog.set_level(logging.INFO)
    svc, fx, fake, clock = wired([failed()])
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.FAILED
    assert [p["kind"] for p in pushes(svc) if p["kind"] != "summary"] == ["failure"]
    [task] = fake.tasks.values()
    assert task["title"].startswith("Librarian needs a look:")
    assert "/media/books/y/x.m4b" in task["description"]
    assert "⚠️ Artificial Condition — failed, see task" in caplog.text


def test_update_metadata_failure_pushes_attention_and_opens_a_task(tmp_path, wired):
    svc, fx, fake, clock = wired(
        update_results=[ExecResult(False, "failed", 2, "read-back mismatch: seriesName")],
        model=FakeModel(librarian=attach_and_update_script, reviewer=approve_all))
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    meta = [r for r in svc.intents.store.all() if r["kind"] == states.UPDATE_METADATA][0]
    assert svc.arrivals.get(key)["state"] == states.FILED
    [p] = pushes(svc, "attention")
    assert p["msg_id"] == f"attention:{key}:{meta['intent_id']}"
    assert "seriesName" in p["body"]
    [task] = fake.tasks.values()
    assert "seriesName" in task["description"]


def test_without_vikunja_the_push_is_all_and_the_summary_says_see_push(tmp_path, wired, caplog):
    caplog.set_level(logging.INFO)
    svc, fx, fake, clock = wired([filed(escalate="cleanup failed")], vikunja=False)
    add_libation(tmp_path)
    drive(svc, clock)
    assert len(pushes(svc, "attention")) == 1
    assert "Vikunja task" not in pushes(svc, "attention")[0]["body"]
    assert fake.tasks == {}
    assert "needs a look — see push" in caplog.text


def test_attention_task_create_failure_is_retried_next_tick(tmp_path, wired):
    svc, fx, fake, clock = wired([filed(escalate="look")])
    fake.fail = 500
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    assert not svc.arrivals.get(key)["attention"][0]["task_id"]
    fake.fail = None
    clock.t += 1
    svc.tick()
    assert svc.arrivals.get(key)["attention"][0]["task_id"] in fake.tasks


# --- late summaries --------------------------------------------------------------------------


def test_retry_filed_on_a_later_tick_gets_a_late_summary(tmp_path, wired):
    svc, fx, fake, clock = wired([retryable(), filed()])
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    [run_summary] = pushes(svc, "summary")
    assert "queued" in run_summary["body"] or "retry" in run_summary["body"]
    clock.t += 3600
    svc.tick()
    assert svc.arrivals.get(key)["state"] == states.FILED
    late = [p for p in pushes(svc, "summary") if p["msg_id"].startswith("late:")]
    assert len(late) == 1
    assert late[0]["title"] == "Librarian (later): 1 filed · 0 failed"
    assert 'Artificial Condition — added to "Artificial Condition"' in late[0]["body"]
    svc.tick()
    assert len([p for p in pushes(svc, "summary") if p["msg_id"].startswith("late:")]) == 1


def test_budget_spill_is_reported_late_and_the_run_summary_only_covers_its_tick(tmp_path, wired):
    from tests.test_live import _two_manual
    svc, fx, fake, clock = wired(model=FakeModel(librarian=create_script, reviewer=approve_all),
                                 max_exec_per_tick=1)
    _two_manual(tmp_path)
    drive(svc, clock)
    [run_summary] = pushes(svc, "summary")
    assert "1 filed" in run_summary["title"] and "queued" in run_summary["body"]
    clock.t += 1
    svc.tick()
    late = [p for p in pushes(svc, "summary") if p["msg_id"].startswith("late:")]
    assert len(late) == 1 and late[0]["title"].startswith("Librarian (later): 1 filed")


def test_retry_that_gives_up_is_reported_late_as_failed(tmp_path, wired):
    svc, fx, fake, clock = wired([retryable()] * 5)
    add_libation(tmp_path)
    drive(svc, clock)
    for _ in range(5):
        clock.t += 86400
        svc.tick()
    late = [p for p in pushes(svc, "summary") if p["msg_id"].startswith("late:")]
    assert len(late) == 1 and "1 failed" in late[0]["title"]
    assert "failed, see task" in late[0]["body"]


def test_filings_inside_the_cycle_get_no_late_summary(tmp_path, wired):
    svc, fx, fake, clock = wired()
    add_libation(tmp_path)
    drive(svc, clock)
    svc.tick()
    assert [p["msg_id"].split(":")[0] for p in pushes(svc, "summary")] == ["summary"]


def test_live_summary_counts_exclude_simulated_and_would_escalate(tmp_path, live_factory):
    """Final review M6: in live mode the push title counts real filings and
    live escalations only -- a non-live source's simulated filing or
    would-escalate is not "filed" / "need a decision"."""
    from app import runs
    svc = live_factory(FakeModel(), FakeExecutor(), live_sources=frozenset({"manual"}))
    svc.arrivals.record("libation:X:abc", states.SIMULATED, source="libation", primary="x.m4b")
    svc.arrivals.record("libation:Z:abc", states.NEEDS_DECISION, source="libation", primary="z.m4b")
    svc.arrivals.record("manual:y:abc", states.FILED, source="manual", primary="y.m4b", book_id=2)
    _text, n_filed, n_esc = runs.summary(svc, "none", ["libation:X:abc", "libation:Z:abc", "manual:y:abc"])
    assert (n_filed, n_esc) == (1, 0)
