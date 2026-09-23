import threading

from app.intents import IntentBook, would_do
from app.policy import GuardContext, KidsLists
from app.states import (
    APPROVED,
    ARRIVAL_STATES,
    ATTACH,
    CREATE_BOOK,
    DEFER,
    DEFERRED,
    ESCALATE,
    GUARD_REJECTED,
    INTENT_STATES,
    NEEDS_DECISION,
    PROPOSED,
    PROPOSED_I,
    REJECTED,
    Run,
    SIMULATED,
    SIMULATED_I,
)
from app.store import Store

ARRIVAL = "libation:X:abc123"
OTHER_ARRIVAL = "libation:Y:def456"

# --- fixtures ----------------------------------------------------------------


class FakeIndex:
    """Minimal LibraryIndex stand-in -- app.intents only ever calls .book(id)
    and .local_path(path)."""

    def __init__(self, books, prefix="/books", root="/media/books"):
        self._books = books
        self._prefix = prefix
        self._root = root

    def book(self, book_id):
        return self._books.get(book_id)

    def local_path(self, path):
        return self._root + path[len(self._prefix):]


def make_book(id, *, library="Library", folder=None):
    return {
        "id": id,
        "libraryName": library,
        "folderPath": folder or f"/books/{library}/x/{id}",
        "files": [],
    }


def make_dossier(*, key=ARRIVAL, primary_kind="m4b", candidates=None):
    return {
        "key": key,
        "source_id": None,
        "trusted": {
            "files": [{"name_hash": "h1", "kind": primary_kind, "size": 1, "primary": True}],
            "measures": [],
            "kids": {"allow": [], "deny": []},
            "arrival_series_index": None,
        },
        "untrusted": {"files": [], "epub": None, "sidecar": None, "folder_name": "x"},
        "candidates": candidates or [],
    }


def candidate(book_id):
    return {"reasons": ["title-key:x"], "book": {"id": book_id, "claimed_by": None}}


def make_run(run_id="run1", **kw):
    kw.setdefault("mode", "librarian")
    return Run(run_id=run_id, token="tok", arrival_keys=[ARRIVAL, OTHER_ARRIVAL], **kw)


def make_intent_book(tmp_path):
    intents_store = Store(str(tmp_path / "intents.jsonl"), "intent_id", INTENT_STATES)
    arrivals_store = Store(str(tmp_path / "arrivals.jsonl"), "key", ARRIVAL_STATES)
    book = IntentBook(intents_store, arrivals_store, threading.Lock())
    return book, intents_store, arrivals_store


def ctx_factory_for(dossier, index, run, lists=None):
    def factory(arrival):
        return GuardContext(
            dossier=dossier,
            index=index,
            seen_ids=set(),
            run_claims=run.claims,
            lists=lists or KidsLists.load("/nonexistent-dir-for-tests"),
            human_answer=None,
        )

    return factory


def attach_intent(book_id, *, arrival=ARRIVAL, reason="matches title and author"):
    return {"kind": ATTACH, "arrival": arrival, "book_id": book_id, "reason": reason}


def create_book_intent(*, arrival=ARRIVAL, library="adult", title="Artificial Condition", reason="no match"):
    return {
        "kind": CREATE_BOOK, "arrival": arrival, "library": library,
        "metadata": {"title": title, "authors": ["Martha Wells"]}, "reason": reason,
    }


def escalate_intent(*, arrival=ARRIVAL, question="Which candidate is correct?"):
    return {
        "kind": ESCALATE, "arrival": arrival, "question": question,
        "options": [{"label": "option a"}, {"label": "option b"}],
        "recommendation": "option a",
    }


def defer_intent(*, arrival=ARRIVAL, hours=24, reason="waiting on more info"):
    return {"kind": DEFER, "arrival": arrival, "reason": reason, "not_before_hours": hours}


# --- submit: guard rejection ---------------------------------------------


def test_guard_rejected_intent_stored_and_arrival_unchanged(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier()
    index = FakeIndex({})  # book 99 doesn't exist

    result = book.submit(run, attach_intent(99), ctx_factory_for(dossier, index, run))

    assert result["status"] == GUARD_REJECTED
    assert "not found" in result["reason"]
    rec = intents_store.get(result["intent_id"])
    assert rec is not None and rec["state"] == GUARD_REJECTED
    assert arrivals_store.get(ARRIVAL) is None


# --- submit: attach accepted ----------------------------------------------


def test_attach_accepted_moves_arrival_to_proposed(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    result = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))

    assert result["status"] == PROPOSED_I
    assert arrivals_store.get(ARRIVAL)["state"] == PROPOSED
    rec = intents_store.get(result["intent_id"])
    assert rec["kind"] == ATTACH and rec["state"] == PROPOSED_I
    assert rec["intent_id"] == f"{run.run_id}:1"


# --- submit: one intent per arrival per run, across kinds -----------------


def test_second_intent_for_same_arrival_same_run_is_guard_rejected(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})
    factory = ctx_factory_for(dossier, index, run)

    first = book.submit(run, attach_intent(412), factory)
    assert first["status"] == PROPOSED_I

    second = book.submit(run, escalate_intent(), factory)
    assert second["status"] == GUARD_REJECTED
    assert second["reason"] == "arrival already has an intent this run"


def test_guard_rejected_intent_does_not_claim_the_arrival(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier()
    index = FakeIndex({})  # attach to 99 fails guard 1

    first = book.submit(run, attach_intent(99), ctx_factory_for(dossier, index, run))
    assert first["status"] == GUARD_REJECTED

    # A later, valid intent for the same arrival must still be accepted --
    # a guard-rejected proposal must not burn the arrival's one-intent slot.
    target = make_book(412)
    dossier2 = make_dossier(candidates=[candidate(412)])
    second = book.submit(run, attach_intent(412), ctx_factory_for(dossier2, FakeIndex({412: target}), run))
    assert second["status"] == PROPOSED_I


# --- submit: defer ---------------------------------------------------------


def test_defer_sets_not_before_on_arrival(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier()
    index = FakeIndex({})
    now = 1_000_000.0
    book.clock = lambda: now

    result = book.submit(run, defer_intent(hours=24), ctx_factory_for(dossier, index, run))

    assert result["status"] == PROPOSED_I
    rec = arrivals_store.get(ARRIVAL)
    assert rec["state"] == DEFERRED
    assert rec["not_before"] == now + 24 * 3600


# --- proposals --------------------------------------------------------------


def test_proposals_returns_only_proposed_state_for_run(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    assert len(book.proposals(run.run_id)) == 1

    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)
    book.apply_review(reviewer_run, submitted["intent_id"], "approve", "ok")
    assert book.proposals(run.run_id) == []


# --- apply_review -----------------------------------------------------------


def test_reviewer_reject_creates_auto_escalation_with_rejected_intent_as_option(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    intent_id = submitted["intent_id"]

    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)
    result = book.apply_review(reviewer_run, intent_id, "reject", "wrong book")

    assert result["status"] == REJECTED
    rejected = intents_store.get(intent_id)
    assert rejected["state"] == REJECTED
    assert rejected["review"] == {"verdict": "reject", "argument": "wrong book"}

    esc = intents_store.get(result["escalation_id"])
    assert esc["kind"] == ESCALATE
    assert esc["state"] == PROPOSED_I
    payload = esc["payload"]
    assert payload["origin"] == "reviewer"
    assert "wrong book" in payload["question"]
    assert any(opt.get("intent") == rejected["payload"] for opt in payload["options"])
    assert any(opt["label"] == "Leave it for me" for opt in payload["options"])


def test_apply_review_approve_sets_approved(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)
    result = book.apply_review(reviewer_run, submitted["intent_id"], "approve", "matches")

    assert result["status"] == APPROVED
    assert intents_store.get(submitted["intent_id"])["state"] == APPROVED


def test_apply_review_rejects_double_review(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    intent_id = submitted["intent_id"]
    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)

    first = book.apply_review(reviewer_run, intent_id, "approve", "looks right")
    assert first["status"] == APPROVED

    second = book.apply_review(reviewer_run, intent_id, "approve", "again")
    assert "error" in second


def test_apply_review_unknown_intent_id_is_an_error(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    reviewer_run = make_run(run_id="review1", mode="reviewer")
    result = book.apply_review(reviewer_run, "run1:99", "approve", "n/a")
    assert "error" in result


# --- finalize_dry_run --------------------------------------------------------


def test_finalize_dry_run_approved_attach_sets_simulated_with_folder_and_scan(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412, folder="/books/Library/Martha Wells/Murderbot/2. Artificial Condition")
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    intent_id = submitted["intent_id"]
    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)
    book.apply_review(reviewer_run, intent_id, "approve", "matches")

    book.finalize_dry_run(run.run_id, index=index)

    rec = intents_store.get(intent_id)
    assert rec["state"] == SIMULATED_I
    assert any("scan" in s for s in rec["would_do"])

    arrival_rec = arrivals_store.get(ARRIVAL)
    assert arrival_rec["state"] == SIMULATED
    local_folder = index.local_path(target["folderPath"])
    assert any(local_folder in s for s in arrival_rec["would_do"])
    assert any("scan" in s for s in arrival_rec["would_do"])


def test_finalize_dry_run_unreviewed_proposal_counts_as_rejected_and_auto_escalates(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    target = make_book(412)
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: target})

    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    intent_id = submitted["intent_id"]
    # never reviewed

    book.finalize_dry_run(run.run_id, index=index)

    rec = intents_store.get(intent_id)
    assert rec["state"] == REJECTED

    arrival_rec = arrivals_store.get(ARRIVAL)
    assert arrival_rec["state"] == NEEDS_DECISION
    assert arrival_rec["would_do"]

    escalations = [r for r in intents_store.all() if r["kind"] == ESCALATE]
    assert len(escalations) == 1
    assert escalations[0]["payload"]["origin"] == "reviewer"


def test_finalize_dry_run_llm_escalation_sets_needs_decision_with_would_do(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier()
    index = FakeIndex({})

    book.submit(run, escalate_intent(question="Which candidate?"), ctx_factory_for(dossier, index, run))
    book.finalize_dry_run(run.run_id, index=index)

    arrival_rec = arrivals_store.get(ARRIVAL)
    assert arrival_rec["state"] == NEEDS_DECISION
    assert any("Which candidate?" in s for s in arrival_rec["would_do"])


def test_finalize_dry_run_defer_stays_deferred(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier()
    index = FakeIndex({})
    book.clock = lambda: 1_000_000.0

    book.submit(run, defer_intent(hours=5), ctx_factory_for(dossier, index, run))
    book.finalize_dry_run(run.run_id, index=index)

    arrival_rec = arrivals_store.get(ARRIVAL)
    assert arrival_rec["state"] == DEFERRED
    assert arrival_rec["not_before"] == 1_000_000.0 + 5 * 3600


# --- would_do -----------------------------------------------------------


def test_would_do_create_book_shows_rendered_folder():
    intent = create_book_intent(title="Artificial Condition")
    intent["metadata"]["series"] = "Murderbot Diaries"
    intent["metadata"]["seriesIndex"] = 2
    steps = would_do(intent)
    assert any("Murderbot Diaries/2. Artificial Condition" in s for s in steps)


def test_would_do_escalate_mentions_question_and_push():
    intent = escalate_intent(question="Kids or adult?")
    steps = would_do(intent)
    assert any("Kids or adult?" in s for s in steps)
    assert any("needs a decision" in s for s in steps)


def test_would_do_attach_without_index_does_not_crash():
    intent = attach_intent(412)
    steps = would_do(intent)
    assert any("scan" in s for s in steps)


# --- final review I1: the reviewer rules on filings only ----------------------


def test_proposals_excludes_escalate_and_defer(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: make_book(412)})

    book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    book.submit(run, escalate_intent(arrival=OTHER_ARRIVAL),
                ctx_factory_for(make_dossier(key=OTHER_ARRIVAL), index, run))

    props = book.proposals(run.run_id)
    assert [p["kind"] for p in props] == [ATTACH]


def test_apply_review_refuses_escalate_and_defer(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    index = FakeIndex({})
    esc = book.submit(run, escalate_intent(), ctx_factory_for(make_dossier(), index, run))
    dfr = book.submit(run, defer_intent(arrival=OTHER_ARRIVAL),
                      ctx_factory_for(make_dossier(key=OTHER_ARRIVAL), index, run))
    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)

    for submitted in (esc, dfr):
        for verdict in ("approve", "reject"):
            result = book.apply_review(reviewer_run, submitted["intent_id"], verdict, "x")
            assert result.get("error") == "conflict", result
        assert intents_store.get(submitted["intent_id"])["state"] == PROPOSED_I
    # no auto-escalation was filed for them either
    assert len(intents_store.all()) == 2


def test_apply_review_refuses_a_reviewer_auto_escalation(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: make_book(412)})
    submitted = book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))
    reviewer_run = make_run(run_id="review1", mode="reviewer", review_of=run.run_id)
    esc_id = book.apply_review(reviewer_run, submitted["intent_id"], "reject", "wrong")["escalation_id"]

    result = book.apply_review(reviewer_run, esc_id, "reject", "overrule the human")
    assert result.get("error") == "conflict"
    assert intents_store.get(esc_id)["state"] == PROPOSED_I


# --- final review I2: finalize makes escalate/defer terminal ------------------


def test_finalize_moves_escalate_and_defer_to_simulated(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    index = FakeIndex({})
    esc = book.submit(run, escalate_intent(), ctx_factory_for(make_dossier(), index, run))
    dfr = book.submit(run, defer_intent(arrival=OTHER_ARRIVAL),
                      ctx_factory_for(make_dossier(key=OTHER_ARRIVAL), index, run))

    book.finalize_dry_run(run.run_id, index=index)

    for submitted in (esc, dfr):
        rec = intents_store.get(submitted["intent_id"])
        assert rec["state"] == SIMULATED_I, rec
        assert rec["would_do"]
    assert arrivals_store.get(OTHER_ARRIVAL)["state"] == DEFERRED


def test_finalize_moves_auto_escalations_to_simulated(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    run = make_run()
    dossier = make_dossier(candidates=[candidate(412)])
    index = FakeIndex({412: make_book(412)})
    book.submit(run, attach_intent(412), ctx_factory_for(dossier, index, run))   # never reviewed

    book.finalize_dry_run(run.run_id, index=index)

    escalations = [r for r in intents_store.all() if r["kind"] == ESCALATE]
    assert [e["state"] for e in escalations] == [SIMULATED_I]
    assert [r["state"] for r in intents_store.all() if r["state"] == PROPOSED_I] == []



# --- final review I4: defer limit ---------------------------------------------


def _defer_in_new_run(book, n, clock_value):
    book.clock = lambda: clock_value
    run = make_run(run_id=f"run{n}")
    return book.submit(run, defer_intent(hours=1), ctx_factory_for(make_dossier(), FakeIndex({}), run))


def test_fourth_defer_is_guard_rejected(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    t = 1_000_000.0
    for n in range(3):
        r = _defer_in_new_run(book, n, t + n * 3600)
        assert r["status"] == PROPOSED_I, r
        book.finalize_dry_run(f"run{n}")
    r = _defer_in_new_run(book, 3, t + 3 * 3600)
    assert r["status"] == GUARD_REJECTED
    assert r["reason"] == "defer limit reached — escalate"
    # escalating is still allowed
    run = make_run(run_id="run9")
    esc = book.submit(run, escalate_intent(), ctx_factory_for(make_dossier(), FakeIndex({}), run))
    assert esc["status"] == PROPOSED_I


def test_defer_rejected_seven_days_after_first_defer(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    t = 1_000_000.0
    assert _defer_in_new_run(book, 0, t)["status"] == PROPOSED_I
    book.finalize_dry_run("run0")
    r = _defer_in_new_run(book, 1, t + 7 * 86400)
    assert r["status"] == GUARD_REJECTED
    assert r["reason"] == "defer limit reached — escalate"


def test_rejected_defers_do_not_count_toward_limit(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    t = 1_000_000.0
    for n in range(3):
        r = _defer_in_new_run(book, n, t + n)
        # a discarded (failed) run's defer is rejected -- it never took effect
        intents_store.record(r["intent_id"], REJECTED, review={"verdict": "reject", "argument": "x"})
    assert _defer_in_new_run(book, 3, t + 10)["status"] == PROPOSED_I


def test_defer_limit_is_per_arrival(tmp_path):
    book, intents_store, arrivals_store = make_intent_book(tmp_path)
    t = 1_000_000.0
    for n in range(3):
        _defer_in_new_run(book, n, t + n)
    book.clock = lambda: t + 5
    run = make_run(run_id="runX")
    r = book.submit(run, defer_intent(arrival=OTHER_ARRIVAL),
                    ctx_factory_for(make_dossier(key=OTHER_ARRIVAL), FakeIndex({}), run))
    assert r["status"] == PROPOSED_I
