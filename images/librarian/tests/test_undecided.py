"""Final review I2: an arrival offered to a (successful) run that ends the
run with no accepted intent -- still `ready` or `answered` -- would sit
unmarked forever (debounce: offered and left alone). Finalize now
auto-escalates it: `needs-decision` with a fresh escalation "the
librarian made no decision: <guard reasons>", so the human is asked
(again) -- never a paid re-run by itself."""
import pytest

from app import states
from tests.test_live import (  # noqa: F401 (live_factory is a fixture)
    Clock, Crash, FakeExecutor, FakeModel, add_libation, approve_all, drive, live_factory,
    only_key, q,
)


def core_escalations(svc, key):
    return [r for r in svc.intents.store.all()
            if r["kind"] == states.ESCALATE and r["arrival"] == key
            and (r.get("payload") or {}).get("origin") == "core"]


def look_only(call):
    st, arrivals = call("GET", "/arrivals")
    for a in arrivals:
        call("GET", f"/arrivals/{q(a['key'])}")


def attach_missing_book(call):
    st, arrivals = call("GET", "/arrivals")
    for a in arrivals:
        st, body = call("POST", "/intents", {"kind": "attach", "arrival": a["key"],
                                            "book_id": 999999, "reason": "guess"})
        assert body["status"] == states.GUARD_REJECTED, body


@pytest.mark.parametrize("dry_run", [False, True])
def test_ready_arrival_left_alone_is_escalated(tmp_path, live_factory, dry_run):
    clock = Clock()
    model = FakeModel(librarian=look_only)
    svc = live_factory(model, FakeExecutor(), clock, dry_run=dry_run)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.NEEDS_DECISION
    [esc] = core_escalations(svc, key)
    assert esc["state"] == states.SIMULATED_I
    assert esc["payload"]["question"].startswith("The librarian made no decision")
    assert svc.intents.latest_escalation(key)["intent_id"] == esc["intent_id"]
    drive(svc, clock, (4000, 4000))
    assert model.calls == ["librarian"]                   # no paid re-run


def test_guard_reasons_are_in_the_question(tmp_path, live_factory):
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_missing_book), FakeExecutor(), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    [esc] = core_escalations(svc, key)
    guard = [r for r in svc.intents.store.all() if r["state"] == states.GUARD_REJECTED][0]
    assert guard["reason"] and guard["reason"] in esc["payload"]["question"]


def test_answered_arrival_left_alone_is_asked_again_and_the_answer_cleared(tmp_path, live_factory):
    clock = Clock()
    svc = live_factory(FakeModel(librarian=look_only), FakeExecutor(), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    first = svc.intents.latest_escalation(key)["intent_id"]
    svc.arrivals.record(key, states.ANSWERED, human_answer={
        "text": "do what you think", "option": None, "option_intent": None, "choice": None,
        "comment_id": 7})
    drive(svc, clock, (1, 11))
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.NEEDS_DECISION
    assert rec.get("human_answer") is None
    assert svc.intents.latest_escalation(key)["intent_id"] != first
    assert len(core_escalations(svc, key)) == 2


def test_decided_arrivals_are_not_escalated(tmp_path, live_factory):
    from tests.test_live import attach_script
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), FakeExecutor(), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.FILED
    assert core_escalations(svc, key) == []


def test_crash_before_finalize_escalates_the_left_alone_arrival_on_restart(tmp_path, live_factory):
    clock = Clock()
    svc = live_factory(FakeModel(librarian=look_only), FakeExecutor(), clock)

    def die(*a, **kw):
        raise Crash()

    svc.intents.finalize_live = die
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    svc.stop()

    svc2 = live_factory(FakeModel(), FakeExecutor(), clock)
    assert svc2.arrivals.get(key)["state"] == states.NEEDS_DECISION
    assert len(core_escalations(svc2, key)) == 1


# --- final review M4: a newer escalation clears the old human answer ----------------------------


ANSWER = {"text": "1", "option": 1, "option_intent": {"kind": "attach", "book_id": 2},
          "choice": "option", "comment_id": 7}


def escalate_again(call):
    st, arrivals = call("GET", "/arrivals")
    for a in arrivals:
        st, body = call("POST", "/intents", {
            "kind": "escalate", "arrival": a["key"], "question": "Which edition did you mean?",
            "options": [{"label": "First edition"}, {"label": "Leave it for me"}],
            "recommendation": "ask"})
        assert body["status"] == states.PROPOSED_I, body


def test_llm_escalating_again_clears_the_answer(tmp_path, live_factory):
    clock = Clock()
    svc = live_factory(FakeModel(librarian=escalate_again), FakeExecutor(), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    svc.arrivals.record(key, states.ANSWERED, human_answer=dict(ANSWER))
    drive(svc, clock, (1, 11))
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.NEEDS_DECISION and rec.get("human_answer") is None


def test_code_escalation_clears_the_answer(tmp_path, live_factory):
    svc = live_factory(FakeModel(), FakeExecutor())
    svc.arrivals.record("manual:a:1", states.NEEDS_DECISION, source="manual",
                        human_answer=dict(ANSWER))
    with svc.lock:
        svc.intents.record_escalation("r1", "manual:a:1", "A re-check refused it", reason="guard")
    assert svc.arrivals.get("manual:a:1").get("human_answer") is None
    assert svc.arrivals.get("manual:a:1")["state"] == states.NEEDS_DECISION
