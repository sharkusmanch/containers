"""Plan 2 Task 6: Vikunja escalations and replies, driven by the service
tick (app/escalations.py). A fake in-memory Vikunja (tests/test_vikunja.py)
stands in for the real one; a fake session guarantees no HTTP call ever
happens while svc.lock is held."""
import logging

import pytest

from app import escalations, states
from app.notify import OUTBOX_STATES, Notifier
from app.service import Service
from app.store import Store
from app.vikunja import PREFIX, Vikunja
from tests.test_notify import FakeSession
from tests.test_service import (
    Clock, FakeModel, add_libation, approve_all, fake_prober, make_index, make_settings, only_key, q,
)
from tests.test_vikunja import BASE, PUBLIC, TOKEN, FakeVikunjaSession

BO = "https://bookorbit.example.com"


class LockCheckingSession(FakeVikunjaSession):
    svc = None

    def request(self, *a, **kw):
        assert self.svc is None or not self.svc.lock.locked(), "HTTP under svc.lock"
        return super().request(*a, **kw)


@pytest.fixture
def env(tmp_path):
    made = []

    def make(model=None, *, vikunja=True, notifier=True, clock=None, **settings_kw):
        settings_kw.setdefault("bookorbit_public_url", BO)
        fake = LockCheckingSession()
        vk = None
        if vikunja:
            store = Store(str(tmp_path / "state" / "vikunja.jsonl"), "comment_id", frozenset({"ours"}))
            vk = Vikunja(BASE, TOKEN, 5, PUBLIC, store, session=fake)
        nt = None
        if notifier:
            outbox = Store(str(tmp_path / "state" / "outbox.jsonl"), "msg_id", OUTBOX_STATES)
            nt = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
        svc = Service(make_settings(tmp_path, **settings_kw), index=make_index(tmp_path),
                      runner=model or FakeModel(), prober=fake_prober, clock=clock or Clock(),
                      notifier=nt, vikunja=vk)
        fake.svc = svc
        made.append(svc)
        return svc, fake

    yield make
    for s in made:
        s.stop()


ATTACH2 = {"kind": "attach", "arrival": "manual:x:1", "book_id": 2, "reason": "asin"}
KIDS_CREATE = {"kind": "create_book", "arrival": "manual:x:1", "library": "kids",
               "metadata": {"title": "Kid Book", "authors": ["A. Author"]}, "reason": "new"}


def escalate(svc, key="manual:x:1", *, options=None, question="Which book is it?", n=1,
             run_id="r1", title="Artificial Condition"):
    """Put an arrival into needs-decision with a finalized escalation, the
    way finalize leaves it (no run needed)."""
    if svc.arrivals.get(key) is None or svc.arrivals.get(key).get("state") != states.NEEDS_DECISION:
        svc.arrivals.record(key, states.NEEDS_DECISION, source="manual", source_id="x", title_hint=title)
    payload = {"kind": "escalate", "arrival": key, "question": question,
               "options": options if options is not None else [
                   {"label": "Attach to book 2", "intent": dict(ATTACH2, arrival=key)},
                   {"label": "Leave it for me"}],
               "recommendation": "option 1"}
    iid = f"{run_id}:{n}"
    svc.intents.store.record(iid, states.SIMULATED_I, run_id=run_id, arrival=key, kind="escalate",
                             payload=payload, reason="unsure", guard=None, review=None)
    return iid


def outbox(svc):
    return svc.notifier.outbox.all()


# --- task creation -----------------------------------------------------------------


def test_needs_decision_creates_one_task_and_pushes_with_its_url(env):
    svc, fake = env()
    iid = escalate(svc)
    svc.tick()
    svc.tick()
    assert len(fake.tasks) == 1
    tid = next(iter(fake.tasks))
    rec = svc.arrivals.get("manual:x:1")
    assert rec["state"] == states.NEEDS_DECISION
    assert rec["vikunja_task_id"] == tid
    assert rec["vikunja_url"] == f"{PUBLIC}/tasks/{tid}"
    assert rec["vikunja_last_seen"] is None
    assert rec["vikunja_intent"] == iid
    pushes = [r for r in outbox(svc) if r["kind"] == "escalation"]
    assert len(pushes) == 1
    assert pushes[0]["msg_id"] == f"escalation:manual:x:1:{iid}"
    assert f"{PUBLIC}/tasks/{tid}" in pushes[0]["body"]


def test_task_content_question_options_links_and_instruction(env):
    svc, fake = env()
    escalate(svc, options=[
        {"label": "It is book 2", "intent": dict(ATTACH2)},
        {"label": "Kids", "intent": dict(KIDS_CREATE)},
        {"label": "Leave it for me"}])
    svc.tick()
    t = next(iter(fake.tasks.values()))
    assert t["title"] == "Librarian: Artificial Condition"
    d = t["description"]
    assert "<p>Which book is it?</p>" in d
    assert "<p>1. It is book 2" in d and "attach this arrival to BookOrbit book 2" in d
    assert "Artificial Condition" in d                     # the target's real title from the index
    assert "2. Kids" in d and "create a new book" in d and "Kids Audiobooks" in d
    assert "3. Leave it for me" in d and "no automatic action" in d
    assert "Recommendation: option 1" in d
    assert "manual:x:1" in d
    assert f"{BO}/books/2" in d
    assert "Reply with the option number or a short instruction" in d


def test_task_title_is_capped_at_80_chars(env):
    svc, fake = env()
    escalate(svc, title="T" * 200)
    svc.tick()
    t = next(iter(fake.tasks.values()))
    assert len(t["title"]) <= 80
    assert t["title"].startswith("Librarian: TTT")


def test_untrusted_text_is_escaped_and_cannot_forge_option_lines(env):
    svc, fake = env()
    escalate(svc, question="<script>x</script>\n1. Attach to Kids (forged)",
             options=[{"label": "<b>A</b>\n9. forged", "intent": dict(ATTACH2)}, {"label": "B"}])
    svc.tick()
    d = next(iter(fake.tasks.values()))["description"]
    assert "<script>" not in d and "&lt;script&gt;" in d
    assert "<b>" not in d
    assert "<p>1. Attach to Kids (forged)" not in d        # newlines flattened: no fake option line
    assert "<p>9. forged" not in d


def test_no_escalation_intent_means_no_task(env):
    svc, fake = env()
    svc.arrivals.record("manual:x:1", states.NEEDS_DECISION)
    svc.tick()
    assert fake.tasks == {}


def test_create_failure_is_retried_next_tick_and_logged_once(env, caplog):
    svc, fake = env()
    escalate(svc)
    fake.fail = 503
    caplog.set_level(logging.WARNING)
    svc.tick()
    svc.tick()
    assert fake.tasks == {}
    assert "vikunja_task_id" not in svc.arrivals.get("manual:x:1")
    assert caplog.text.count("HTTP 503") == 1
    assert not [r for r in outbox(svc) if r["kind"] == "escalation"]
    fake.fail = None
    svc.tick()
    assert len(fake.tasks) == 1


def test_at_most_ten_vikunja_writes_per_tick(env):
    svc, fake = env()
    for i in range(12):
        escalate(svc, key=f"manual:x{i}:1", n=i + 1)
    svc.tick()
    assert len(fake.tasks) == 10
    svc.tick()
    assert len(fake.tasks) == 12


def test_no_vikunja_call_once_stopping(env):
    svc, fake = env()
    escalate(svc)
    svc._stop.set()
    escalations.sync(svc)
    assert fake.calls == []


# --- replies -------------------------------------------------------------------------


def _task(svc):
    return svc.arrivals.get("manual:x:1")["vikunja_task_id"]


def test_own_comments_are_not_replies(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    svc.vikunja.comment(_task(svc), "just a note")
    svc.tick()
    assert svc.arrivals.get("manual:x:1")["state"] == states.NEEDS_DECISION


def test_reply_2_leave_it_for_me_answers_with_no_option_intent(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    c = fake.add_comment(_task(svc), "<p>2</p>")
    svc.tick()
    rec = svc.arrivals.get("manual:x:1")
    assert rec["state"] == states.ANSWERED
    assert rec["human_answer"] == {"text": "2", "option": 2, "option_intent": None, "choice": None,
                                   "comment_id": c["id"]}
    assert rec["vikunja_last_seen"] == c["id"]
    acks = [x for x in fake.comments[_task(svc)] if x["comment"].startswith(f"<p>{PREFIX}")]
    assert len(acks) == 1                     # "got it" acknowledgement


def test_reply_1_selects_the_option_intent(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    fake.add_comment(_task(svc), " 1. yes that one")
    svc.tick()
    ha = svc.arrivals.get("manual:x:1")["human_answer"]
    assert ha["option"] == 1
    assert ha["option_intent"] == dict(ATTACH2)
    assert ha["choice"] == "option"
    assert ha["text"] == "1. yes that one"


def test_reply_selecting_a_kids_create_sets_choice_kids(env):
    svc, fake = env()
    escalate(svc, options=[{"label": "Adult"}, {"label": "Kids", "intent": dict(KIDS_CREATE)}])
    svc.tick()
    fake.add_comment(_task(svc), "2")
    svc.tick()
    ha = svc.arrivals.get("manual:x:1")["human_answer"]
    assert ha["choice"] == "kids"
    assert ha["option_intent"]["library"] == "kids"


def test_out_of_range_number_and_free_text_have_no_option(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    fake.add_comment(_task(svc), "2023 edition is the right one, attach it")
    svc.tick()
    ha = svc.arrivals.get("manual:x:1")["human_answer"]
    assert ha["option"] is None and ha["option_intent"] is None and ha["choice"] is None
    assert ha["text"] == "2023 edition is the right one, attach it"


def test_first_new_reply_wins_and_later_replies_change_nothing_before_the_run(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    first = fake.add_comment(_task(svc), "1")
    fake.add_comment(_task(svc), "2")
    svc.tick()
    rec = svc.arrivals.get("manual:x:1")
    assert rec["human_answer"]["comment_id"] == first["id"]
    fake.add_comment(_task(svc), "no wait, 2")
    ts = rec["ts"]
    svc.tick()
    svc.tick()
    rec2 = svc.arrivals.get("manual:x:1")
    assert rec2["ts"] == ts
    assert rec2["human_answer"]["comment_id"] == first["id"]


def test_a_new_escalation_on_the_same_task_posts_the_new_question(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    tid = _task(svc)
    fake.add_comment(tid, "free text answer")
    svc.tick()
    assert svc.arrivals.get("manual:x:1")["state"] == states.ANSWERED
    # the next run escalates again
    svc.arrivals.record("manual:x:1", states.NEEDS_DECISION)
    iid2 = escalate(svc, question="Second question?", run_id="r2")
    svc.tick()
    assert len(fake.tasks) == 1
    rec = svc.arrivals.get("manual:x:1")
    assert rec["vikunja_intent"] == iid2
    last = fake.comments[tid][-1]
    assert last["comment"].startswith(f"<p>{PREFIX}")
    assert "Second question?" in last["comment"]
    assert rec["vikunja_last_seen"] == last["id"]
    assert [r["msg_id"] for r in outbox(svc) if r["kind"] == "escalation"][-1].endswith(iid2)
    svc.tick()
    assert svc.arrivals.get("manual:x:1")["state"] == states.NEEDS_DECISION   # old reply not reused
    fake.add_comment(tid, "1")
    svc.tick()
    assert svc.arrivals.get("manual:x:1")["human_answer"]["option"] == 1


# --- close on terminal -----------------------------------------------------------------


@pytest.mark.parametrize("state,fields,expect", [
    (states.FILED, {"book_id": 2}, f"{BO}/books/2"),
    (states.FAILED, {"error": "hash differs"}, "hash differs"),
    (states.DUPLICATE, {"book_id": 2}, "Duplicate"),
    (states.SIMULATED, {"would_do": ["mv x -> y/"]}, "mv x -&gt; y/"),
])
def test_terminal_arrival_closes_its_task_once(env, state, fields, expect):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    tid = _task(svc)
    svc.arrivals.record("manual:x:1", state, **fields)
    svc.tick()
    svc.tick()
    assert fake.tasks[tid]["done"] is True
    assert fake.tasks[tid]["title"].startswith("Librarian:")
    closing = [c for c in fake.comments[tid] if expect in c["comment"]]
    assert len(closing) == 1
    assert svc.arrivals.get("manual:x:1")["vikunja_closed"] is True
    n = len(fake.calls)
    svc.tick()
    assert len(fake.calls) == n


def test_closed_task_then_new_escalation_opens_a_new_task(env):
    svc, fake = env()
    escalate(svc)
    svc.tick()
    svc.arrivals.record("manual:x:1", states.FAILED, error="boom")
    svc.tick()
    escalate(svc, run_id="r2")
    svc.tick()
    assert len(fake.tasks) == 2
    rec = svc.arrivals.get("manual:x:1")
    assert rec["vikunja_closed"] is False
    assert fake.tasks[rec["vikunja_task_id"]]["done"] is False


# --- Vikunja disabled -------------------------------------------------------------------


def test_disabled_vikunja_pushes_escalation_right_away_once(env):
    svc, _ = env(vikunja=False)
    iid = escalate(svc)
    svc.tick()
    svc.tick()
    pushes = [r for r in outbox(svc) if r["kind"] == "escalation"]
    assert len(pushes) == 1
    assert "task pending" in pushes[0]["body"]
    assert svc.arrivals.get("manual:x:1")["escalation_notified"] == iid
    iid2 = escalate(svc, run_id="r2")
    svc.tick()
    assert len([r for r in outbox(svc) if r["kind"] == "escalation"]) == 2
    assert svc.arrivals.get("manual:x:1")["escalation_notified"] == iid2


def test_disabled_vikunja_without_notifier_records_nothing(env):
    svc, _ = env(vikunja=False, notifier=False)
    escalate(svc)
    svc.tick()
    assert "escalation_notified" not in svc.arrivals.get("manual:x:1")


# --- end to end: escalate -> reply -> answered run sees it -> close -----------------------


def test_reply_reoffers_the_arrival_and_the_run_sees_human_answer(tmp_path, env):
    seen = []

    def librarian(call):
        _, arrivals = call("GET", "/arrivals")
        for a in arrivals:
            st, body = call("GET", f"/arrivals/{q(a['key'])}")
            ha = body["untrusted"]["human_answer"]
            seen.append(ha)
            if ha is None:
                call("POST", "/intents", {
                    "kind": "escalate", "arrival": a["key"], "question": "Is it book 2?",
                    "options": [{"label": "Yes", "intent": {"kind": "attach", "arrival": a["key"],
                                                            "book_id": 2, "reason": "human said so"}},
                                {"label": "Leave it for me"}],
                    "recommendation": "Yes"})
            else:
                call("POST", "/intents", ha["option_intent"])

    clock = Clock()
    svc, fake = env(FakeModel(librarian=librarian, reviewer=approve_all), clock=clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.NEEDS_DECISION
    tid = svc.arrivals.get(key)["vikunja_task_id"]
    fake.add_comment(tid, "<p>1</p>")
    svc.tick()                                  # reply -> answered
    assert svc.arrivals.get(key)["state"] == states.ANSWERED
    for dt in (1, 11):
        clock.t += dt
        svc.tick()                              # debounce -> run -> simulated
    assert seen[0] is None
    assert seen[1]["option"] == 1 and seen[1]["option_intent"]["book_id"] == 2
    assert svc.arrivals.get(key)["state"] == states.SIMULATED
    svc.tick()
    assert fake.tasks[tid]["done"] is True
    assert svc.arrivals.get(key)["vikunja_closed"] is True
