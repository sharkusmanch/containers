import json

import pytest

from app.policy import (
    GuardContext,
    KidsLists,
    check_intent,
    claims_for,
    kids_signals,
    render_folder,
    validate_shape,
)

# --- fixtures ----------------------------------------------------------------


class FakeIndex:
    """Minimal stand-in for LibraryIndex -- policy.py only ever calls
    .book(id) and .books()."""

    def __init__(self, books):
        self._books = books  # dict[int, dict]

    def book(self, book_id):
        return self._books.get(book_id)

    def books(self):
        return list(self._books.values())


def make_book(id, *, library="Library", folder=None, files=None):
    return {
        "id": id,
        "libraryName": library,
        "folderPath": folder or f"/books/{library}/x/{id}",
        "files": files or [],
    }


def make_dossier(*, key="libation:X:abc123", primary_kind="m4b",
                  candidates=None, measures=None, kids=None):
    return {
        "key": key,
        "trusted": {
            "files": [{"name_hash": "h1", "kind": primary_kind, "size": 1, "primary": True}],
            "measures": measures or [],
            "kids": kids or {"allow": [], "deny": []},
        },
        "candidates": candidates or [],
    }


def candidate(book_id):
    return {"reasons": ["title-key:x"], "book": {"id": book_id, "claimed_by": None}}


def ctx(dossier, index, *, seen_ids=None, run_claims=None, lists=None, human_answer=None):
    return GuardContext(
        dossier=dossier,
        index=index,
        seen_ids=seen_ids or set(),
        run_claims=run_claims or {},
        lists=lists or KidsLists.load("/nonexistent-dir-for-tests"),
        human_answer=human_answer,
    )


def attach_intent(book_id, *, reason="matches title and author"):
    return {"kind": "attach", "arrival": "libation:X:abc123", "book_id": book_id, "reason": reason}


def create_book_intent(*, library="adult", title="Artificial Condition",
                        authors=None, series=None, series_index=None):
    metadata = {"title": title, "authors": ["Martha Wells"] if authors is None else authors}
    if series is not None:
        metadata["series"] = series
    if series_index is not None:
        metadata["seriesIndex"] = series_index
    return {
        "kind": "create_book",
        "arrival": "libation:X:abc123",
        "library": library,
        "metadata": metadata,
        "reason": "new title, no existing match",
    }


def escalate_intent(n_options=2):
    return {
        "kind": "escalate",
        "arrival": "libation:X:abc123",
        "question": "Which candidate is correct?",
        "options": [{"label": f"option {i}"} for i in range(n_options)],
        "recommendation": "option 0",
    }


def defer_intent(hours=24):
    return {
        "kind": "defer",
        "arrival": "libation:X:abc123",
        "reason": "waiting on more info",
        "not_before_hours": hours,
    }


# --- render_folder -------------------------------------------------------


def test_render_folder_with_series_and_index():
    assert render_folder("Martha Wells", "Murderbot Diaries", 2.0, "Artificial Condition") == \
        "Martha Wells/Murderbot Diaries/2. Artificial Condition"


def test_render_folder_no_series_drops_segment_and_prefix():
    assert render_folder("A", None, None, "T") == "A/T"


def test_render_folder_series_without_index_has_no_prefix():
    assert render_folder("A", "S", None, "T") == "A/S/T"


def test_render_folder_fractional_index_keeps_decimal():
    assert render_folder("A", "S", 2.5, "T") == "A/S/2.5. T"


# --- KidsLists.load --------------------------------------------------------


def test_kids_lists_load_missing_files_returns_empty(tmp_path):
    lists = KidsLists.load(tmp_path)
    assert kids_signals(lists, series="anything") == {"allow": [], "deny": []}


def test_kids_lists_load_parses_files(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({
        "series": ["Murderbot Diaries"],
        "asins": ["B0KIDS123"],
        "authors": [{"name": "Rick Riordan", "whole_author": True}],
    }))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({
        "series": ["Grim Series"],
        "asins": [],
        "authors": [{"name": "Some Adult Author", "whole_author": False}],
    }))
    lists = KidsLists.load(tmp_path)

    allow_series = kids_signals(lists, series="Murderbot Diaries")
    assert allow_series["allow"] and not allow_series["deny"]

    deny_series = kids_signals(lists, series="Grim Series")
    assert deny_series["deny"] and not deny_series["allow"]


# --- kids_signals ----------------------------------------------------------


def _lists_from(allow=None, deny=None):
    allow = allow or {"series": [], "asins": [], "authors": []}
    deny = deny or {"series": [], "asins": [], "authors": []}

    class _Obj:
        pass

    def load_dir(tmp_path):
        (tmp_path / "kids-allowlist.json").write_text(json.dumps(allow))
        (tmp_path / "kids-denylist.json").write_text(json.dumps(deny))
        return KidsLists.load(tmp_path)

    return load_dir


def test_kids_signals_asin_match(tmp_path):
    lists = _lists_from(allow={"series": [], "asins": ["B0KIDS"], "authors": []})(tmp_path)
    result = kids_signals(lists, asins=("B0KIDS",))
    assert result["allow"] == ["asin:b0kids"]
    assert result["deny"] == []


def test_kids_signals_author_allow_requires_whole_author(tmp_path):
    lists = _lists_from(
        allow={"series": [], "asins": [], "authors": [{"name": "Rick Riordan", "whole_author": False}]}
    )(tmp_path)
    result = kids_signals(lists, authors=("Rick Riordan",))
    assert result["allow"] == []


def test_kids_signals_denylist_author_counts_without_whole_author(tmp_path):
    lists = _lists_from(
        deny={"series": [], "asins": [], "authors": [{"name": "Some Author", "whole_author": False}]}
    )(tmp_path)
    result = kids_signals(lists, authors=("Some Author",))
    assert result["deny"] != []


def test_kids_signals_denylist_beats_allowlist_when_both_match(tmp_path):
    lists = _lists_from(
        allow={"series": ["Shared Series"], "asins": [], "authors": []},
        deny={"series": ["Shared Series"], "asins": [], "authors": []},
    )(tmp_path)
    result = kids_signals(lists, series="Shared Series")
    assert result["allow"] != []
    assert result["deny"] != []


# --- validate_shape ---------------------------------------------------------


def test_validate_shape_rejects_unknown_kind():
    ok, msg = validate_shape({"kind": "update_metadata", "arrival": "x"})
    assert not ok
    assert "kind" in msg


def test_validate_shape_rejects_unknown_top_level_key():
    intent = attach_intent(2)
    intent["extra_field"] = "nope"
    ok, msg = validate_shape(intent)
    assert not ok
    assert "extra_field" in msg


def test_validate_shape_attach_requires_fields():
    ok, msg = validate_shape({"kind": "attach", "arrival": "x"})
    assert not ok
    assert "book_id" in msg and "reason" in msg


def test_validate_shape_attach_valid():
    ok, msg = validate_shape(attach_intent(2))
    assert ok


def test_validate_shape_create_book_requires_nonempty_authors():
    intent = create_book_intent(authors=[])
    ok, msg = validate_shape(intent)
    assert not ok
    assert "authors" in msg


def test_validate_shape_create_book_unknown_metadata_key():
    intent = create_book_intent()
    intent["metadata"]["bogus"] = "x"
    ok, msg = validate_shape(intent)
    assert not ok
    assert "bogus" in msg


def test_validate_shape_escalate_too_few_options():
    ok, msg = validate_shape(escalate_intent(n_options=1))
    assert not ok


def test_validate_shape_escalate_too_many_options():
    ok, msg = validate_shape(escalate_intent(n_options=7))
    assert not ok


def test_validate_shape_escalate_boundary_counts_ok():
    assert validate_shape(escalate_intent(n_options=2))[0]
    assert validate_shape(escalate_intent(n_options=6))[0]


def test_validate_shape_defer_hours_out_of_range():
    assert not validate_shape(defer_intent(hours=0))[0]
    assert not validate_shape(defer_intent(hours=169))[0]


def test_validate_shape_defer_hours_boundary_ok():
    assert validate_shape(defer_intent(hours=1))[0]
    assert validate_shape(defer_intent(hours=168))[0]


def test_validate_shape_rejects_oversized_string():
    intent = attach_intent(2, reason="x" * 2001)
    ok, msg = validate_shape(intent)
    assert not ok
    assert "reason" in msg


# --- guard 1: id existence / candidate membership --------------------------


def test_guard1_book_id_not_in_index_rejected():
    index = FakeIndex({})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard1_book_id_not_candidate_or_seen_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[])  # 2 is not a candidate
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard1_book_id_in_candidates_accepted():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


def test_guard1_book_id_in_seen_ids_accepted():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, seen_ids={2}))
    assert ok


# --- guard 4: library values / cbz routing / comics target ------------------


def test_guard4_create_book_bad_library_rejected():
    index = FakeIndex({})
    dossier = make_dossier()
    ok, msg = check_intent(create_book_intent(library="teen"), ctx(dossier, index))
    assert not ok


def test_guard4_cbz_arrival_attach_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(primary_kind="cbz", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard4_cbz_arrival_create_book_rejected():
    index = FakeIndex({})
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(create_book_intent(), ctx(dossier, index))
    assert not ok


def test_guard4_cbz_arrival_escalate_allowed():
    index = FakeIndex({})
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(escalate_intent(), ctx(dossier, index))
    assert ok


def test_guard4_cbz_arrival_defer_allowed():
    index = FakeIndex({})
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(defer_intent(), ctx(dossier, index))
    assert ok


def test_guard4_attach_target_in_comics_rejected():
    index = FakeIndex({2: make_book(2, library="Comics")})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


# --- guard 5: format collision ----------------------------------------------


def test_guard5_m4b_conflict_rejected():
    index = FakeIndex({2: make_book(2, files=[{"format": "m4b", "filename": "x.m4b"}])})
    dossier = make_dossier(primary_kind="m4b", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard5_m4b_no_conflict_accepted():
    index = FakeIndex({2: make_book(2, files=[{"format": "epub", "filename": "x.epub"}])})
    dossier = make_dossier(primary_kind="m4b", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


def test_guard5_plain_epub_conflict_rejected():
    index = FakeIndex({2: make_book(2, files=[{"format": "epub", "filename": "book.epub"}])})
    dossier = make_dossier(primary_kind="epub", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard5_readaloud_epub_not_counted_as_plain():
    index = FakeIndex({2: make_book(2, files=[{"format": "epub", "filename": "Book (readaloud).epub"}])})
    dossier = make_dossier(primary_kind="epub", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


def test_guard5_readaloud_epub_case_insensitive():
    index = FakeIndex({2: make_book(2, files=[{"format": "epub", "filename": "Book (READALOUD).EPUB"}])})
    dossier = make_dossier(primary_kind="epub", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


# --- guard 6: one filing intent per arrival / one arrival per (book,fmt) ---


def test_guard6_duplicate_arrival_filing_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)])
    claims = {("arrival", dossier["key"]): "some-other-intent-id"}
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, run_claims=claims))
    assert not ok


def test_guard6_duplicate_book_format_claim_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(key="libation:Y:def456", candidates=[candidate(2)])
    claims = {("book_fmt", 2, "m4b"): "libation:X:abc123"}
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, run_claims=claims))
    assert not ok


def test_guard6_escalate_not_blocked_by_prior_arrival_claim():
    # escalate/defer are not filing intents -- claims_for never records them,
    # so an arrival claim recorded elsewhere by, say, a retried attach should
    # not block a fresh escalate.
    index = FakeIndex({})
    dossier = make_dossier()
    claims = {("arrival", dossier["key"]): "prior-intent"}
    ok, msg = check_intent(escalate_intent(), ctx(dossier, index, run_claims=claims))
    assert ok


# --- guard 7: kids allow/deny gate -------------------------------------------


def _kids_dir_lists(tmp_path, *, allow_series=(), deny_series=()):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({
        "series": list(allow_series), "asins": [], "authors": [],
    }))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({
        "series": list(deny_series), "asins": [], "authors": [],
    }))
    return KidsLists.load(tmp_path)


def test_guard7_create_book_kids_no_allow_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({})
    dossier = make_dossier(kids={"allow": [], "deny": []})
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, index, lists=lists))
    assert not ok


def test_guard7_create_book_kids_allow_no_deny_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({})
    dossier = make_dossier(kids={"allow": ["series:x"], "deny": []})
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, index, lists=lists))
    assert ok


def test_guard7_create_book_kids_deny_present_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({})
    dossier = make_dossier(kids={"allow": ["series:x"], "deny": ["author:y"]})
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, index, lists=lists))
    assert not ok


def test_guard7_create_book_kids_human_override_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({})
    dossier = make_dossier(kids={"allow": [], "deny": ["author:y"]})
    ok, msg = check_intent(
        create_book_intent(library="kids"), ctx(dossier, index, lists=lists, human_answer={"choice": "kids"})
    )
    assert ok
    assert "override" in msg.lower()


def test_guard7_create_book_adult_library_ignores_kids_signals(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({})
    dossier = make_dossier(kids={"allow": [], "deny": ["author:y"]})
    ok, msg = check_intent(create_book_intent(library="adult"), ctx(dossier, index, lists=lists))
    assert ok


def test_guard7_attach_kids_target_deny_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = make_dossier(candidates=[candidate(2)], kids={"allow": [], "deny": ["author:y"]})
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert not ok


def test_guard7_attach_kids_target_allow_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = make_dossier(candidates=[candidate(2)], kids={"allow": ["series:x"], "deny": []})
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert ok


def test_guard7_attach_adult_target_ignores_kids_signals(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    index = FakeIndex({2: make_book(2, library="Library")})
    dossier = make_dossier(candidates=[candidate(2)], kids={"allow": [], "deny": ["author:y"]})
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert ok


# --- guard 8: folder-name collision ------------------------------------------


def test_guard8_folder_collision_rejected_case_insensitive():
    index = FakeIndex({
        9: make_book(9, library="Library", folder="/books/Library/martha wells/artificial condition"),
    })
    dossier = make_dossier()
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(dossier, index))
    assert not ok


def test_guard8_folder_no_collision_accepted():
    index = FakeIndex({
        9: make_book(9, library="Library", folder="/books/Library/Someone Else/Different Book"),
    })
    dossier = make_dossier()
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(dossier, index))
    assert ok


def test_guard8_collision_only_checked_within_target_library():
    # same folder tail, but the existing book is in Kids Audiobooks -- an
    # "adult" create_book targets Library, so this must not collide.
    index = FakeIndex({
        9: make_book(9, library="Kids Audiobooks",
                     folder="/books/Kids Audiobooks/Martha Wells/Artificial Condition"),
    })
    dossier = make_dossier()
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(dossier, index))
    assert ok


# --- guard 10: series-index disagreement ------------------------------------


def test_guard10_disagree_measure_without_human_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard10_disagree_measure_with_human_accepted():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer={"choice": "attach"}))
    assert ok


def test_guard10_agree_measure_no_human_needed():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "agree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


# --- claims_for --------------------------------------------------------------


def test_claims_for_attach():
    dossier = make_dossier(primary_kind="m4b")
    claims = claims_for(attach_intent(2), dossier)
    assert ("arrival", dossier["key"]) in claims
    assert ("book_fmt", 2, "m4b") in claims


def test_claims_for_create_book():
    dossier = make_dossier()
    claims = claims_for(create_book_intent(), dossier)
    assert claims == [("arrival", dossier["key"])]


def test_claims_for_escalate_and_defer_take_no_claims():
    dossier = make_dossier()
    assert claims_for(escalate_intent(), dossier) == []
    assert claims_for(defer_intent(), dossier) == []
