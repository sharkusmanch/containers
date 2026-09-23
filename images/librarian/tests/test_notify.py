"""Tests for app/notify.py (Plan 2 Task 5): the durable Apprise outbox, plus
the summary/escalation/failure wiring in app/runs.py, app/execution.py and
app/service.py.

A `FakeSession` stands in for `requests` -- its `.post` returns queued
status codes (or raises, to exercise a network error) and records every
call so tests can assert on the payload and the URL.
"""
import logging

from app import states
from app.notify import MAX_ATTEMPTS, OUTBOX_STATES, Notifier, cap, sanitize, truncate_utf8
from app.service import Service
from app.store import Store
from tests.test_live import FakeExecutor, failed
from tests.test_service import (
    Clock,
    FakeModel,
    add_libation,
    approve_all,
    attach_script,
    fake_prober,
    make_index,
    make_settings,
)

# --- fakes -------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


class FakeSession:
    def __init__(self, codes=None):
        self.codes = list(codes) if codes is not None else []
        self.calls = []  # (url, json, timeout)

    def post(self, url, json=None, timeout=None):
        self.calls.append((url, json, timeout))
        if self.codes:
            code = self.codes.pop(0)
        else:
            code = 200
        if code == "raise":
            raise ConnectionError("boom")
        return FakeResponse(code)


class Clk:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


def make_outbox(tmp_path, name="outbox.jsonl"):
    return Store(str(tmp_path / name), "msg_id", OUTBOX_STATES)


# --- sanitize / truncate / cap ------------------------------------------------


def test_sanitize_strips_control_chars_keeps_newline():
    assert sanitize("hi\x07there\nline2\x1b[31m") == "hithere\nline2[31m"


def test_sanitize_keeps_plain_text_and_newlines_unchanged():
    assert sanitize("hello\nworld") == "hello\nworld"


def test_truncate_utf8_short_text_unchanged():
    assert truncate_utf8("hello", 100) == "hello"


def test_truncate_utf8_appends_ellipsis_and_respects_byte_budget():
    text = "x" * 50
    out = truncate_utf8(text, 10)
    assert out.endswith("…")
    assert len(out.encode("utf-8")) <= 10


def test_truncate_utf8_never_splits_a_multibyte_char():
    # each "é" is 2 UTF-8 bytes
    text = "é" * 20
    out = truncate_utf8(text, 11)
    # must decode cleanly (would raise/produce mojibake if a byte were split)
    assert out.encode("utf-8").decode("utf-8") == out
    assert len(out.encode("utf-8")) <= 11


def test_cap_leaves_short_title_and_body_untouched():
    title, body = cap("Title", "Body text")
    assert (title, body) == ("Title", "Body text")


def test_cap_truncates_body_to_combined_budget_not_title():
    title = "Short Title"
    body = "y" * 5000
    capped_title, capped_body = cap(title, body, max_bytes=100)
    assert capped_title == title  # title is never truncated by cap()
    assert len(capped_title.encode("utf-8")) + len(capped_body.encode("utf-8")) <= 100
    assert capped_body.endswith("…")


def test_cap_strips_control_chars_from_both_fields():
    title, body = cap("Bad\x07Title", "Bad\x07Body\nkept")
    assert "\x07" not in title and "\x07" not in body
    assert "\n" in body


# --- enqueue -------------------------------------------------------------------


def test_enqueue_is_idempotent_on_msg_id(tmp_path):
    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    n.enqueue("summary", "summary:run1", "Title", "Body")
    n.enqueue("summary", "summary:run1", "Different Title", "Different Body")
    rec = outbox.get("summary:run1")
    assert rec["title"] == "Title" and rec["body"] == "Body"
    assert outbox.counts() == {"pending": 1}


def test_enqueue_caps_title_and_body_at_write_time(tmp_path):
    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    n.enqueue("summary", "m1", "T", "z" * 5000)
    rec = outbox.get("m1")
    assert len(rec["title"].encode("utf-8")) + len(rec["body"].encode("utf-8")) <= 1800


# --- flush: success / retry / dry-run -----------------------------------------


def test_flush_sends_pending_on_200(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([200])
    n = Notifier("http://apprise/notify/k", outbox, session=session)
    n.enqueue("summary", "m1", "Title", "Body")
    sent, failed_n = n.flush()
    assert (sent, failed_n) == (1, 0)
    assert outbox.get("m1")["state"] == "sent"
    url, payload, timeout = session.calls[0]
    assert url == "http://apprise/notify/k"
    assert payload == {"title": "Title", "body": "Body", "format": "markdown"}


def test_flush_204_stays_pending_and_is_retried(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([204, 200])
    clock = Clk(0.0)
    n = Notifier("http://apprise/notify/k", outbox, session=session, clock=clock)
    n.enqueue("summary", "m1", "Title", "Body")

    sent, failed_n = n.flush()
    assert (sent, failed_n) == (0, 0)
    rec = outbox.get("m1")
    assert rec["state"] == "pending" and rec["attempts"] == 1
    assert rec["next_at"] > clock.t

    # not yet due: retried too early does nothing
    sent, failed_n = n.flush()
    assert (sent, failed_n) == (0, 0)
    assert len(session.calls) == 1

    clock.t = rec["next_at"]
    sent, failed_n = n.flush()
    assert (sent, failed_n) == (1, 0)
    assert outbox.get("m1")["state"] == "sent"
    assert len(session.calls) == 2


def test_flush_500_stays_pending_with_backoff(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([500])
    n = Notifier("http://apprise/notify/k", outbox, session=session, clock=Clk(1000.0))
    n.enqueue("escalation", "m1", "Title", "Body")
    n.flush()
    rec = outbox.get("m1")
    assert rec["state"] == "pending"
    assert rec["next_at"] == 1000.0 + min(60 * 2 ** 1, 3600)


def test_flush_network_error_stays_pending(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession(["raise"])
    n = Notifier("http://apprise/notify/k", outbox, session=session)
    sent, failed_n = 0, 0
    n.enqueue("failure", "m1", "Title", "Body")
    sent, failed_n = n.flush()
    assert (sent, failed_n) == (0, 0)
    assert outbox.get("m1")["state"] == "pending"


def test_flush_backoff_is_capped_at_an_hour(tmp_path):
    outbox = make_outbox(tmp_path)
    clock = Clk(0.0)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession([500] * 10), clock=clock)
    n.enqueue("failure", "m1", "T", "B")
    for _ in range(10):
        rec = outbox.get("m1")
        clock.t = rec.get("next_at") or clock.t
        n.flush()
        rec = outbox.get("m1")
        if rec["state"] != "pending":
            break
        assert rec["next_at"] - clock.t <= 3600


def test_flush_marks_failed_after_max_attempts_and_increments_metric(tmp_path, caplog):
    from prometheus_client import REGISTRY

    caplog.set_level(logging.ERROR)
    before = REGISTRY.get_sample_value("librarian_notify_failures_total") or 0.0
    outbox = make_outbox(tmp_path)
    clock = Clk(0.0)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession([500] * MAX_ATTEMPTS), clock=clock)
    n.enqueue("failure", "m1", "T", "B")
    for _ in range(MAX_ATTEMPTS):
        rec = outbox.get("m1")
        if rec["state"] != "pending":
            break
        clock.t = rec.get("next_at") or clock.t
        n.flush()
    rec = outbox.get("m1")
    assert rec["state"] == "failed" and rec["attempts"] == MAX_ATTEMPTS
    after = REGISTRY.get_sample_value("librarian_notify_failures_total") or 0.0
    assert after == before + 1
    assert "giving up after" in caplog.text

    # a failed message is terminal: never retried, never double-logged/counted
    caplog.clear()
    n.flush()
    assert REGISTRY.get_sample_value("librarian_notify_failures_total") == after
    assert "giving up after" not in caplog.text


def test_dry_run_marks_sent_without_http_and_logs(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    outbox = make_outbox(tmp_path)
    session = FakeSession([200])
    n = Notifier("http://apprise/notify/k", outbox, session=session, dry_run=True)
    n.enqueue("summary", "m1", "My Title", "Body")
    sent, failed_n = n.flush()
    assert (sent, failed_n) == (1, 0)
    assert session.calls == []  # no HTTP at all
    rec = outbox.get("m1")
    assert rec["state"] == "sent" and rec["dry_run"] is True
    assert "would notify: My Title" in caplog.text


def test_flush_sends_in_enqueue_order(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([200, 200, 200])
    n = Notifier("http://apprise/notify/k", outbox, session=session)
    n.enqueue("summary", "m1", "First", "b")
    n.enqueue("summary", "m2", "Second", "b")
    n.enqueue("summary", "m3", "Third", "b")
    n.flush()
    titles = [c[1]["title"] for c in session.calls]
    assert titles == ["First", "Second", "Third"]


def test_flush_respects_max_per_tick(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([200, 200, 200])
    n = Notifier("http://apprise/notify/k", outbox, session=session)
    for i in range(3):
        n.enqueue("summary", f"m{i}", f"T{i}", "b")
    sent, failed_n = n.flush(max_per_tick=2)
    assert (sent, failed_n) == (2, 0)
    assert len(session.calls) == 2
    assert outbox.counts() == {"pending": 1, "sent": 2}
    sent, failed_n = n.flush(max_per_tick=2)
    assert (sent, failed_n) == (1, 0)
    assert outbox.counts() == {"sent": 3}


def test_flush_no_session_lazily_uses_requests_module(tmp_path):
    # session=None must not raise at construction time
    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox)
    import requests
    assert n.session is requests


# --- outbox durability (crash-safety) -----------------------------------------


def test_flush_survives_a_fresh_notifier_over_the_same_outbox_file(tmp_path):
    """A restart: a new Store + Notifier reading the same outbox.jsonl picks
    up a pending message and can still deliver it."""
    path = tmp_path / "outbox.jsonl"
    outbox1 = Store(str(path), "msg_id", OUTBOX_STATES)
    n1 = Notifier("http://apprise/notify/k", outbox1, session=FakeSession([500]), clock=Clk(0.0))
    n1.enqueue("summary", "m1", "T", "B")
    n1.flush()
    assert outbox1.get("m1")["state"] == "pending"

    outbox2 = Store(str(path), "msg_id", OUTBOX_STATES)
    assert outbox2.get("m1")["state"] == "pending"
    n2 = Notifier("http://apprise/notify/k", outbox2, session=FakeSession([200]), clock=Clk(9999.0))
    sent, failed_n = n2.flush()
    assert (sent, failed_n) == (1, 0)
    assert outbox2.get("m1")["state"] == "sent"


# --- service integration -------------------------------------------------------


def test_summary_push_enqueued_and_flushed_after_dry_run_cycle(tmp_path):
    outbox = make_outbox(tmp_path, "outbox2.jsonl")
    session = FakeSession()
    notifier = Notifier("http://apprise/notify/k", outbox, session=session)
    model = FakeModel(librarian=attach_script(), reviewer=approve_all)
    clock = Clock()
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=model,
                 prober=fake_prober, clock=clock, notifier=notifier)
    try:
        add_libation(tmp_path)
        svc.tick()
        clock.t += 1
        svc.tick()
        clock.t += 11
        svc.tick()          # runs the cycle; enqueues the summary
        svc.tick()          # next tick's flush() delivers it (called after execution)
    finally:
        svc.stop()

    sent_recs = [r for r in outbox.all() if r["state"] == "sent"]
    assert len(sent_recs) == 1
    rec = sent_recs[0]
    assert rec["kind"] == "summary"
    assert rec["msg_id"].startswith("summary:")
    assert "filed" in rec["title"] and "need a decision" in rec["title"]
    assert "would add to" in rec["body"]
    payload = session.calls[0][1]
    assert payload["title"] == rec["title"] and payload["body"] == rec["body"]


def test_no_summary_push_when_notifier_is_none(tmp_path):
    # regression: notifier=None (the default) must not raise anywhere in the
    # cycle -- every existing test_service.py/test_live.py test relies on this
    model = FakeModel(librarian=attach_script(), reviewer=approve_all)
    clock = Clock()
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=model,
                 prober=fake_prober, clock=clock)
    try:
        add_libation(tmp_path)
        svc.tick()
        clock.t += 1
        svc.tick()
        clock.t += 11
        svc.tick()
    finally:
        svc.stop()
    assert svc.arrivals.all()[0]["state"] == states.SIMULATED


def test_failure_push_enqueued_on_live_execution_failure(tmp_path):
    outbox = make_outbox(tmp_path, "outbox3.jsonl")
    session = FakeSession()
    notifier = Notifier("http://apprise/notify/k", outbox, session=session)
    fx = FakeExecutor([failed(detail="linked but hash differs")])
    clock = Clock()
    svc = Service(make_settings(tmp_path, dry_run=False), index=make_index(tmp_path), runner=FakeModel(
        librarian=attach_script(), reviewer=approve_all), prober=fake_prober, clock=clock,
        executor=fx, notifier=notifier)
    try:
        add_libation(tmp_path)
        for dt in (0, 1, 11):
            clock.t += dt
            svc.tick()
        svc.tick()   # flush after execution
    finally:
        svc.stop()

    sent_recs = [r for r in outbox.all() if r["state"] == "sent"]
    failure_recs = [r for r in sent_recs if r["kind"] == "failure"]
    assert len(failure_recs) == 1
    rec = failure_recs[0]
    assert rec["msg_id"].startswith("failure:")
    assert "Filing failed" in rec["title"]
    assert "hash differs" in rec["body"]


# --- notify_escalation helper (Task 6 will call this) --------------------------


def _svc_for_helper(tmp_path, notifier):
    return Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                   prober=fake_prober, clock=Clock(), notifier=notifier)


def test_notify_escalation_includes_vikunja_url_when_present(tmp_path):
    outbox = make_outbox(tmp_path, "outbox4.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = _svc_for_helper(tmp_path, notifier)
    try:
        arrival_rec = {"key": "manual:x:abc", "title_hint": "Some Book Title",
                      "vikunja_url": "https://vikunja.example.com/tasks/42"}
        intent = {"intent_id": "run1:2", "payload": {"question": "Which book is this?"}}
        svc.notify_escalation(arrival_rec, intent)
        rec = outbox.get("escalation:manual:x:abc:run1:2")
        assert rec is not None and rec["kind"] == "escalation"
        assert rec["title"] == "Needs a decision: Some Book Title"
        assert "Which book is this?" in rec["body"]
        assert "https://vikunja.example.com/tasks/42" in rec["body"]
    finally:
        svc.stop()


def test_notify_escalation_says_task_pending_without_vikunja_url(tmp_path):
    outbox = make_outbox(tmp_path, "outbox5.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = _svc_for_helper(tmp_path, notifier)
    try:
        arrival_rec = {"key": "manual:x:abc", "title_hint": "Some Book"}
        intent = {"intent_id": "run1:2", "payload": {"question": "Which book?"}}
        svc.notify_escalation(arrival_rec, intent)
        rec = outbox.get("escalation:manual:x:abc:run1:2")
        assert "task pending" in rec["body"]
    finally:
        svc.stop()


def test_notify_escalation_caps_question_at_600_bytes_and_strips_control_chars(tmp_path):
    outbox = make_outbox(tmp_path, "outbox6.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = _svc_for_helper(tmp_path, notifier)
    try:
        long_question = ("x" * 1000) + "\x07evil"
        arrival_rec = {"key": "manual:x:abc", "title_hint": "Book"}
        intent = {"intent_id": "run1:2", "payload": {"question": long_question}}
        svc.notify_escalation(arrival_rec, intent)
        rec = outbox.get("escalation:manual:x:abc:run1:2")
        question_part = rec["body"].split("\n\n")[0]
        assert len(question_part.encode("utf-8")) <= 600
        assert "\x07" not in rec["body"]
    finally:
        svc.stop()


def test_notify_escalation_is_idempotent_per_intent(tmp_path):
    outbox = make_outbox(tmp_path, "outbox7.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = _svc_for_helper(tmp_path, notifier)
    try:
        arrival_rec = {"key": "manual:x:abc", "title_hint": "Book"}
        intent = {"intent_id": "run1:2", "payload": {"question": "Q1"}}
        svc.notify_escalation(arrival_rec, intent)
        svc.notify_escalation({**arrival_rec, "vikunja_url": "https://x/1"}, intent)
        rec = outbox.get("escalation:manual:x:abc:run1:2")
        assert "task pending" in rec["body"]  # first call's body wins; not re-queued
        assert len([r for r in outbox.all() if r["msg_id"].startswith("escalation:")]) == 1
    finally:
        svc.stop()


def test_notify_failure_and_escalation_are_noop_without_a_notifier(tmp_path):
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                 prober=fake_prober, clock=Clock())
    try:
        svc.notify_failure({"key": "k"}, None, "boom")
        svc.notify_escalation({"key": "k"}, {"intent_id": "i1", "payload": {"question": "q"}})
    finally:
        svc.stop()
