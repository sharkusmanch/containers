"""Tests for app/notify.py (Plan 2 Task 5): the durable Apprise outbox, plus
the summary/escalation/failure wiring in app/runs.py, app/execution.py and
app/service.py.

A `FakeSession` stands in for `requests` -- its `.post` returns queued
status codes (or raises, to exercise a network error) and records every
call so tests can assert on the payload and the URL.
"""
import logging

from app import metrics, states
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


class URLLeakingSession:
    """A real `requests` connection/timeout error's own message commonly
    embeds the request URL -- used to verify _send's log line never repeats
    it (fix round 1: the Apprise URL carries a secret stateful key)."""

    def post(self, url, json=None, timeout=None):
        raise ConnectionError(f"Failed to establish a new connection to {url}: [Errno 111] refused")


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


# --- fix round 1: byte budgets are hard limits, never exceeded ---------------


def test_truncate_utf8_budget_zero_returns_empty():
    assert truncate_utf8("hello", 0) == ""


def test_truncate_utf8_budget_of_one_hard_cuts_without_ellipsis():
    # the ellipsis ("…") is 3 UTF-8 bytes -- a 1-byte budget can't hold it,
    # so the old implementation returned the ellipsis alone (4x over budget)
    out = truncate_utf8("hello", 1)
    assert len(out.encode("utf-8")) <= 1
    assert "…" not in out


def test_truncate_utf8_budget_below_ellipsis_size_hard_cuts():
    out = truncate_utf8("hello", 2)
    assert len(out.encode("utf-8")) <= 2
    assert "…" not in out


def test_cap_truncates_an_oversized_title_too():
    title = "T" * 5000
    body = "B" * 5000
    capped_title, capped_body = cap(title, body, max_bytes=100)
    assert capped_title != title
    total = len(capped_title.encode("utf-8")) + len(capped_body.encode("utf-8"))
    assert total <= 100


def test_cap_extreme_budget_of_one_never_exceeds_it():
    capped_title, capped_body = cap("Title", "Body", max_bytes=1)
    total = len(capped_title.encode("utf-8")) + len(capped_body.encode("utf-8"))
    assert total <= 1


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
    assert payload == {"title": "Title", "body": "Body", "format": "text"}


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


def test_connection_error_log_never_contains_the_url(tmp_path, caplog):
    # fix round 1: the exception's own str() commonly embeds the URL, which
    # here carries a secret Apprise stateful key -- only the exception's
    # type name (and, separately, a plain status code) are safe to log.
    caplog.set_level(logging.WARNING)
    outbox = make_outbox(tmp_path)
    url = "http://apprise.tools.svc.cluster.local:8000/notify/SUPERSECRETKEY"
    n = Notifier(url, outbox, session=URLLeakingSession())
    n.enqueue("failure", "m1", "T", "B")
    n.flush()
    assert "SUPERSECRETKEY" not in caplog.text
    assert url not in caplog.text
    assert "ConnectionError" in caplog.text
    assert outbox.get("m1")["state"] == "pending"


def test_non_200_status_is_logged_without_leaking_anything_secret(tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession([503]))
    n.enqueue("failure", "m1", "T", "B")
    n.flush()
    assert "503" in caplog.text


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


# --- fix round 1: stopping + liveness heartbeat during flush -----------------


def test_flush_checks_stopping_between_messages(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([200, 200, 200])
    seen = {"n": 0}

    def stopping():
        seen["n"] += 1
        return seen["n"] > 1   # not stopping for the first message, then stops

    n = Notifier("http://apprise/notify/k", outbox, session=session, stopping=stopping)
    for i in range(3):
        n.enqueue("summary", f"m{i}", f"T{i}", "b")
    sent, failed_n = n.flush()
    assert sent == 1
    assert len(session.calls) == 1   # never started a 2nd send once stopping tripped
    assert outbox.counts() == {"sent": 1, "pending": 2}


def test_flush_default_stopping_never_stops():
    # constructor default (stopping=lambda: False) -- direct Notifier use
    # outside a Service must not silently stop after the first message
    assert Notifier("http://x", None).stopping() is False


def test_flush_calls_beat_after_each_send(tmp_path):
    outbox = make_outbox(tmp_path)
    session = FakeSession([200, 500])
    beats = []
    n = Notifier("http://apprise/notify/k", outbox, session=session, beat=lambda: beats.append(1))
    n.enqueue("summary", "m1", "T1", "b")
    n.enqueue("summary", "m2", "T2", "b")
    n.flush()
    assert len(beats) == 2   # once per send attempt, success or failure


def test_flush_calls_beat_in_dry_run_too(tmp_path):
    outbox = make_outbox(tmp_path)
    beats = []
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession(), dry_run=True,
                beat=lambda: beats.append(1))
    n.enqueue("summary", "m1", "T1", "b")
    n.flush()
    assert len(beats) == 1


def test_flush_default_beat_is_a_noop():
    Notifier("http://x", None).beat()   # must not raise


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


# --- outbox pruning (fix round 1) ---------------------------------------------
#
# `Store.record` always stamps `ts` with the REAL wall clock (`time.time()`),
# never any clock injected into the Notifier -- so these tests pass an
# explicit `now=` to `prune()` (real-time-based) rather than driving a fake
# `Clk`, which would only move `next_at`/backoff math, not `ts`.


def test_prune_drops_old_terminal_records_keeps_recent_and_pending(tmp_path):
    import time as time_mod

    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession([200]))
    n.enqueue("summary", "old-sent", "T", "b")
    n.flush()
    assert outbox.get("old-sent")["state"] == "sent"

    n.enqueue("summary", "new-pending", "T2", "b")

    removed = n.prune(now=time_mod.time() + 40 * 86400)
    assert removed == 1
    assert outbox.get("old-sent") is None
    assert outbox.get("new-pending") is not None


def test_prune_never_drops_pending_regardless_of_age(tmp_path):
    import time as time_mod

    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    n.enqueue("summary", "m1", "T", "b")         # never flushed: stays pending
    removed = n.prune(now=time_mod.time() + 400 * 86400)
    assert removed == 0
    assert outbox.get("m1")["state"] == "pending"


def test_prune_keeps_a_recently_sent_record(tmp_path):
    import time as time_mod

    outbox = make_outbox(tmp_path)
    n = Notifier("http://apprise/notify/k", outbox, session=FakeSession([200]))
    n.enqueue("summary", "m1", "T", "b")
    n.flush()
    removed = n.prune(now=time_mod.time() + 1 * 86400)   # 1 day later: well under cutoff
    assert removed == 0
    assert outbox.get("m1")["state"] == "sent"


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
    # dry-run: the title says what WOULD happen (final review M6)
    assert rec["title"] == "Librarian (dry-run): 1 would file · 0 would escalate"
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


def test_notify_escalation_without_vikunja_says_vikunja_is_disabled(tmp_path):
    outbox = make_outbox(tmp_path, "outbox5.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = _svc_for_helper(tmp_path, notifier)
    try:
        arrival_rec = {"key": "manual:x:abc", "title_hint": "Some Book"}
        intent = {"intent_id": "run1:2", "payload": {"question": "Which book?"}}
        svc.notify_escalation(arrival_rec, intent)
        rec = outbox.get("escalation:manual:x:abc:run1:2")
        assert "task pending" not in rec["body"]
        assert "Vikunja is disabled" in rec["body"]
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
        assert "task pending" not in rec["body"]
        assert "Vikunja is disabled" in rec["body"]  # first call's body wins; not re-queued
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


# --- service wiring of stopping/beat/pruning (fix round 1) --------------------


def test_service_wires_notifier_stopping_and_beat(tmp_path):
    outbox = make_outbox(tmp_path, "outbox8.jsonl")
    notifier = Notifier("http://apprise/notify/k", outbox, session=FakeSession())
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                 prober=fake_prober, clock=Clock(), notifier=notifier)
    try:
        assert notifier.stopping == svc.stopping
        assert notifier.beat is metrics.beat
    finally:
        svc.stop()


def test_tick_does_not_flush_once_stopping(tmp_path):
    # coarse case: stop is already set before tick() starts -- every earlier
    # `if self._stop.is_set(): return` in tick() bails before reaching flush
    outbox = make_outbox(tmp_path, "outbox9.jsonl")
    session = FakeSession([200])
    notifier = Notifier("http://apprise/notify/k", outbox, session=session)
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                 prober=fake_prober, clock=Clock(), notifier=notifier)
    try:
        notifier.enqueue("summary", "m1", "T", "b")
        svc._stop.set()
        svc.tick()
        assert outbox.get("m1")["state"] == "pending"
        assert session.calls == []
    finally:
        svc.stop()


def test_tick_outer_gate_prevents_flush_even_without_the_inner_check(tmp_path, monkeypatch):
    """Isolates tick()'s OWN gate (`if self.notifier is not None and not
    self._stop.is_set(): self.notifier.flush()`) from `flush()`'s separate
    internal `stopping()` check (fix 2's other half, already covered by
    `test_flush_checks_stopping_between_messages`): `notifier.stopping` is
    stubbed to always return False here, so only tick()'s own guard is left
    standing. `_stop` flips to True partway through tick() -- as a real
    SIGTERM would, landing while no claude child is running (`_in_runner`
    False, so no `Stopping` exception, just the flag) -- AFTER every
    earlier stop-check in tick() has already passed."""
    outbox = make_outbox(tmp_path, "outbox9b.jsonl")
    session = FakeSession([200])
    notifier = Notifier("http://apprise/notify/k", outbox, session=session)
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                 prober=fake_prober, clock=Clock(), notifier=notifier)
    try:
        notifier.stopping = lambda: False   # neutralize flush()'s own inner guard
        notifier.enqueue("summary", "m1", "T", "b")
        orig_due = svc._due

        def due_then_stop(now):
            result = orig_due(now)
            svc._stop.set()
            return result

        monkeypatch.setattr(svc, "_due", due_then_stop)
        svc.tick()
        assert outbox.get("m1")["state"] == "pending"
        assert session.calls == []
    finally:
        svc._stop.clear()
        svc.stop()


def test_service_prunes_old_outbox_records_each_tick(tmp_path, monkeypatch):
    import time as time_mod

    # _prune_outbox()/Notifier.prune() age against the REAL wall clock (ts
    # is always real-time-stamped by Store.record, unaffected by the
    # service's injected `clock`) -- so the "old" record is backdated by
    # briefly patching time.time() while it's created, not by advancing the
    # service's fake clock.
    outbox = make_outbox(tmp_path, "outbox10.jsonl")
    session = FakeSession([200])
    clock = Clock()
    notifier = Notifier("http://apprise/notify/k", outbox, session=session, clock=clock)
    svc = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                 prober=fake_prober, clock=clock, notifier=notifier)
    try:
        real_now = time_mod.time()
        monkeypatch.setattr(time_mod, "time", lambda: real_now - 31 * 86400)
        notifier.enqueue("summary", "old", "T", "b")
        svc.tick()                                    # flushes it -> sent, backdated ts
        assert outbox.get("old")["state"] == "sent"

        monkeypatch.undo()                            # back to the real wall clock
        svc.tick()                                    # prunes it (>30 days old, real now)
        assert outbox.get("old") is None
    finally:
        svc.stop()
