import json

from app.policy import (
    GuardContext,
    KidsLists,
    check_intent,
    claims_for,
    kids_signals,
    render_folder,
    validate_shape,
)

DEFAULT_ARRIVAL_KEY = "libation:X:abc123"

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


def make_book(id, *, library="Library", folder=None, files=None, series_index=None):
    return {
        "id": id,
        "libraryName": library,
        "folderPath": folder or f"/books/{library}/x/{id}",
        "files": files or [],
        "seriesIndex": series_index,
    }


def make_dossier(*, key=DEFAULT_ARRIVAL_KEY, primary_kind="m4b",
                  candidates=None, measures=None, kids=None,
                  untrusted=None, arrival_series_index=None, source_id=None):
    return {
        "key": key,
        "source_id": source_id,
        "trusted": {
            "files": [{"name_hash": "h1", "kind": primary_kind, "size": 1, "primary": True}],
            "measures": measures or [],
            "kids": kids or {"allow": [], "deny": []},
            "arrival_series_index": arrival_series_index,
        },
        "untrusted": untrusted or {"files": [], "epub": None, "sidecar": None, "folder_name": "x"},
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


def attach_intent(book_id, *, reason="matches title and author", arrival=DEFAULT_ARRIVAL_KEY):
    return {"kind": "attach", "arrival": arrival, "book_id": book_id, "reason": reason}


def create_book_intent(*, library="adult", title="Artificial Condition", authors=None,
                        series=None, series_index=None, arrival=DEFAULT_ARRIVAL_KEY,
                        reason="new title, no existing match"):
    metadata = {"title": title, "authors": ["Martha Wells"] if authors is None else authors}
    if series is not None:
        metadata["series"] = series
    if series_index is not None:
        metadata["seriesIndex"] = series_index
    return {
        "kind": "create_book", "arrival": arrival, "library": library,
        "metadata": metadata, "reason": reason,
    }


def escalate_intent(n_options=2, arrival=DEFAULT_ARRIVAL_KEY):
    return {
        "kind": "escalate",
        "arrival": arrival,
        "question": "Which candidate is correct?",
        "options": [{"label": f"option {i}"} for i in range(n_options)],
        "recommendation": "option 0",
    }


def defer_intent(hours=24, arrival=DEFAULT_ARRIVAL_KEY):
    return {"kind": "defer", "arrival": arrival, "reason": "waiting on more info", "not_before_hours": hours}


def _kids_dir_lists(tmp_path, *, allow_series=(), deny_series=()):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({
        "series": list(allow_series), "asins": [], "authors": [],
    }))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({
        "series": list(deny_series), "asins": [], "authors": [],
    }))
    return KidsLists.load(tmp_path)


def _dossier_for_kids(*, stored_allow=(), stored_deny=(), fresh_series=None,
                       fresh_authors=(), fresh_asins=(), candidates=None):
    d = make_dossier(
        candidates=candidates,
        kids={"allow": list(stored_allow), "deny": list(stored_deny)},
        source_id=fresh_asins[0] if fresh_asins else None,
    )
    has_fresh = fresh_series or fresh_authors or fresh_asins
    d["untrusted"] = {
        "files": [{"tags": {
            "series": fresh_series,
            "artist": fresh_authors[0] if fresh_authors else None,
            "audible_asin": fresh_asins[0] if fresh_asins else None,
        }}] if has_fresh else [],
        "epub": None,
        "sidecar": None,
        "folder_name": "x",
    }
    return d


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


def test_render_folder_large_integer_index_no_scientific_notation():
    assert render_folder("A", "S", 1234567.0, "T") == "A/S/1234567. T"


# --- KidsLists.load / C1: fail closed on malformed lists --------------------


def test_kids_lists_load_missing_files_returns_empty_and_valid(tmp_path):
    lists = KidsLists.load(tmp_path)
    assert lists.valid
    assert kids_signals(lists, series="anything") == {"allow": [], "deny": []}


def test_kids_lists_load_parses_files(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("Murderbot Diaries",), deny_series=("Grim Series",))
    assert lists.valid
    assert kids_signals(lists, series="Murderbot Diaries")["allow"]
    assert kids_signals(lists, series="Grim Series")["deny"]


def test_kids_lists_invalid_json_marks_invalid_not_empty(tmp_path):
    (tmp_path / "kids-denylist.json").write_text("{not valid json,}")
    lists = KidsLists.load(tmp_path)
    assert not lists.valid
    assert "kids-denylist.json" in lists.error


def test_kids_lists_wrong_root_type_marks_invalid(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps(["not", "an", "object"]))
    lists = KidsLists.load(tmp_path)
    assert not lists.valid
    assert "kids-allowlist.json" in lists.error


def test_kids_lists_series_not_list_of_str_marks_invalid(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({"series": [1, 2]}))
    lists = KidsLists.load(tmp_path)
    assert not lists.valid


def test_kids_lists_author_missing_name_marks_invalid(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({"authors": [{"whole_author": True}]}))
    lists = KidsLists.load(tmp_path)
    assert not lists.valid


def test_kids_lists_whole_author_wrong_type_marks_invalid(tmp_path):
    # minor: whole_author must be `is True`; a non-bool value is a
    # structural violation per C1 and fails the whole file closed rather
    # than being silently treated as falsy.
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({
        "authors": [{"name": "Author X", "whole_author": "false"}],
    }))
    lists = KidsLists.load(tmp_path)
    assert not lists.valid


def test_kids_lists_load_never_raises_on_garbage(tmp_path):
    (tmp_path / "kids-allowlist.json").write_bytes(b"\xff\xfe not even text")
    lists = KidsLists.load(tmp_path)  # must not raise
    assert not lists.valid


# --- kids_signals ------------------------------------------------------------


def test_kids_signals_asin_match(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({"asins": ["B0KIDS"]}))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({}))
    lists = KidsLists.load(tmp_path)
    result = kids_signals(lists, asins=("B0KIDS",))
    assert result["allow"] == ["asin:b0kids"]
    assert result["deny"] == []


def test_kids_signals_author_allow_requires_whole_author(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({
        "authors": [{"name": "Rick Riordan", "whole_author": False}],
    }))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({}))
    lists = KidsLists.load(tmp_path)
    result = kids_signals(lists, authors=("Rick Riordan",))
    assert result["allow"] == []


def test_kids_signals_denylist_author_counts_without_whole_author(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text(json.dumps({}))
    (tmp_path / "kids-denylist.json").write_text(json.dumps({
        "authors": [{"name": "Some Author", "whole_author": False}],
    }))
    lists = KidsLists.load(tmp_path)
    result = kids_signals(lists, authors=("Some Author",))
    assert result["deny"] != []


def test_kids_signals_denylist_beats_allowlist_when_both_match(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("Shared Series",), deny_series=("Shared Series",))
    result = kids_signals(lists, series="Shared Series")
    assert result["allow"] != []
    assert result["deny"] != []


# --- validate_shape ----------------------------------------------------------


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
    assert validate_shape(attach_intent(2))[0]


def test_validate_shape_attach_book_id_bool_rejected():
    intent = attach_intent(2)
    intent["book_id"] = True
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_attach_readalong_must_be_bool():
    intent = attach_intent(2)
    intent["readalong"] = "yes"
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_rejects_non_string_arrival():
    intent = attach_intent(2)
    intent["arrival"] = 5
    ok, msg = validate_shape(intent)
    assert not ok
    assert "arrival" in msg


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


def test_validate_shape_metadata_language_must_be_string():
    intent = create_book_intent()
    intent["metadata"]["language"] = 5
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_published_year_must_be_number():
    intent = create_book_intent()
    intent["metadata"]["publishedYear"] = "2020"
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_series_index_accepts_int_or_float():
    assert validate_shape(create_book_intent(series="S", series_index=2))[0]
    assert validate_shape(create_book_intent(series="S", series_index=2.5))[0]


def test_validate_shape_authors_over_20_rejected():
    intent = create_book_intent(authors=[f"Author {i}" for i in range(21)])
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_narrators_over_20_rejected():
    intent = create_book_intent()
    intent["metadata"]["narrators"] = [f"N{i}" for i in range(21)]
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_narrators_must_be_strings():
    intent = create_book_intent()
    intent["metadata"]["narrators"] = [5]
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_create_book_readalong_must_be_bool():
    intent = create_book_intent()
    intent["readalong"] = "yes"
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_escalate_too_few_options():
    assert not validate_shape(escalate_intent(n_options=1))[0]


def test_validate_shape_escalate_too_many_options():
    assert not validate_shape(escalate_intent(n_options=7))[0]


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


# --- I5: folder-name-bound fields reject path-unsafe values ----------------


def test_validate_shape_rejects_path_traversal_title():
    ok, msg = validate_shape(create_book_intent(title="../../../etc"))
    assert not ok


def test_validate_shape_rejects_slash_in_title():
    ok, msg = validate_shape(create_book_intent(title="A/B"))
    assert not ok


def test_validate_shape_rejects_backslash_in_series():
    ok, msg = validate_shape(create_book_intent(series="A\\B"))
    assert not ok


def test_validate_shape_rejects_control_char_in_title():
    ok, msg = validate_shape(create_book_intent(title="Bad\x00Title"))
    assert not ok


def test_validate_shape_rejects_leading_trailing_whitespace_title():
    ok, msg = validate_shape(create_book_intent(title="  Title  "))
    assert not ok


def test_validate_shape_rejects_dotdot_as_whole_title():
    ok, msg = validate_shape(create_book_intent(title=".."))
    assert not ok


def test_validate_shape_rejects_dotdot_first_author():
    ok, msg = validate_shape(create_book_intent(authors=[".."]))
    assert not ok


def test_validate_shape_rejects_slash_in_subtitle():
    intent = create_book_intent()
    intent["metadata"]["subtitle"] = "A/B"
    ok, msg = validate_shape(intent)
    assert not ok


# --- I1: check_intent never raises on malformed LLM input -------------------


def _never_raises(mutate) -> None:
    intent = create_book_intent()
    mutate(intent)
    index = FakeIndex({})
    dossier = make_dossier()
    ok, msg = check_intent(intent, ctx(dossier, index))  # must not raise
    assert ok is False
    assert isinstance(msg, str) and msg


def test_check_intent_never_raises_library_wrong_type():
    _never_raises(lambda i: i.__setitem__("library", ["kids"]))


def test_check_intent_never_raises_authors_empty_dict_entry():
    _never_raises(lambda i: i["metadata"].__setitem__("authors", [{}]))


def test_check_intent_never_raises_authors_int_entry():
    _never_raises(lambda i: i["metadata"].__setitem__("authors", [5]))


def test_check_intent_never_raises_title_wrong_type():
    _never_raises(lambda i: i["metadata"].__setitem__("title", [".."]))


def test_check_intent_never_raises_series_index_string():
    _never_raises(lambda i: i["metadata"].__setitem__("seriesIndex", "abc"))


def test_check_intent_never_raises_series_index_bool():
    _never_raises(lambda i: i["metadata"].__setitem__("seriesIndex", True))


def test_check_intent_never_raises_series_index_nan():
    _never_raises(lambda i: i["metadata"].__setitem__("seriesIndex", float("nan")))


def test_check_intent_never_raises_arrival_wrong_type():
    _never_raises(lambda i: i.__setitem__("arrival", 5))


def test_check_intent_never_raises_reason_none():
    _never_raises(lambda i: i.__setitem__("reason", None))


# --- guard 1: id existence / candidate membership --------------------------


def test_guard1_book_id_not_in_index_rejected():
    index = FakeIndex({})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard1_book_id_not_candidate_or_seen_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[])
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


# --- guard 4: allowlisted target libraries / cbz routing --------------------


def test_guard4_create_book_bad_library_rejected():
    ok, msg = check_intent(create_book_intent(library="teen"), ctx(make_dossier(), FakeIndex({})))
    assert not ok


def test_guard4_cbz_arrival_attach_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(primary_kind="cbz", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard4_cbz_arrival_create_book_rejected():
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(create_book_intent(), ctx(dossier, FakeIndex({})))
    assert not ok


def test_guard4_cbz_arrival_escalate_allowed():
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(escalate_intent(), ctx(dossier, FakeIndex({})))
    assert ok


def test_guard4_cbz_arrival_defer_allowed():
    dossier = make_dossier(primary_kind="cbz")
    ok, msg = check_intent(defer_intent(), ctx(dossier, FakeIndex({})))
    assert ok


def test_guard4_attach_target_comics_rejected():
    index = FakeIndex({2: make_book(2, library="Comics")})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard4_attach_target_missing_library_name_rejected():
    index = FakeIndex({2: make_book(2, library=None)})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard4_attach_target_unknown_library_rejected():
    index = FakeIndex({2: make_book(2, library="Secret")})
    dossier = make_dossier(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


# --- guard 5: format collision / primary-format requirement -----------------


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


def test_guard5_format_comparison_case_insensitive():
    index = FakeIndex({2: make_book(2, files=[{"format": "M4B", "filename": "x.M4B"}])})
    dossier = make_dossier(primary_kind="m4b", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard5_attach_rejected_when_primary_not_m4b_or_epub():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(primary_kind="other", candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard5_attach_rejected_when_primary_missing():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(primary_kind=None, candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


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
    intent = attach_intent(2, arrival="libation:Y:def456")
    ok, msg = check_intent(intent, ctx(dossier, index, run_claims=claims))
    assert not ok


def test_guard6_escalate_not_blocked_by_prior_arrival_claim():
    dossier = make_dossier()
    claims = {("arrival", dossier["key"]): "prior-intent"}
    ok, msg = check_intent(escalate_intent(), ctx(dossier, FakeIndex({}), run_claims=claims))
    assert ok


def test_claims_for_escalate_and_defer_take_no_claims():
    dossier = make_dossier()
    assert claims_for(escalate_intent(), dossier) == []
    assert claims_for(defer_intent(), dossier) == []


# --- guard 7: kids allow/deny gate (fresh recompute, fail-closed lists) -----


def test_guard7_create_book_kids_no_signals_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    dossier = _dossier_for_kids()
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok


def test_guard7_create_book_fresh_allow_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("Kids Series",))
    dossier = _dossier_for_kids(fresh_series="Kids Series")
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert ok


def test_guard7_create_book_adult_library_ignores_kids_signals(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(create_book_intent(library="adult"), ctx(dossier, FakeIndex({}), lists=lists))
    assert ok


def test_guard7_stale_stored_allow_without_fresh_hit_rejected(tmp_path):
    # I4: allow requires a FRESH hit -- a stale stored allow (from when the
    # dossier was built against an older allowlist) must not be enough.
    lists = _kids_dir_lists(tmp_path, allow_series=("Current Series",))
    dossier = _dossier_for_kids(stored_allow=["series:old series"], fresh_series="Something Unrelated")
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok


def test_guard7_stale_stored_deny_still_rejects_despite_fresh_allow(tmp_path):
    # I4: deny if EITHER stored or fresh has a deny hit.
    lists = _kids_dir_lists(tmp_path, allow_series=("Current Series",))  # denylist now empty
    dossier = _dossier_for_kids(
        stored_allow=["series:current series"], stored_deny=["author:stale flag"],
        fresh_series="Current Series",
    )
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok


def test_guard7_fresh_deny_hit_rejects_even_without_stored_deny(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("Current Series",), deny_series=("Current Series",))
    dossier = _dossier_for_kids(stored_allow=["series:current series"], stored_deny=[],
                                 fresh_series="Current Series")
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok


def test_guard7_attach_kids_target_deny_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(candidates=[candidate(2)], fresh_series="x")
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert not ok


def test_guard7_attach_kids_target_allow_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(candidates=[candidate(2)], fresh_series="x")
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert ok


def test_guard7_attach_adult_target_ignores_kids_signals(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Library")})
    dossier = _dossier_for_kids(candidates=[candidate(2)], fresh_series="x")
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert ok


# --- C1: malformed lists fail EVERY kids filing closed, no override --------


def test_guard7_invalid_denylist_rejects_create_book(tmp_path):
    (tmp_path / "kids-denylist.json").write_text("{bad json")
    lists = KidsLists.load(tmp_path)
    dossier = _dossier_for_kids(stored_allow=["series:x"])
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok
    assert "kids-denylist.json" in msg


def test_guard7_invalid_lists_rejects_even_with_human_override(tmp_path):
    (tmp_path / "kids-denylist.json").write_text("{bad json")
    lists = KidsLists.load(tmp_path)
    dossier = _dossier_for_kids()
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": "kids"}),
    )
    assert not ok


def test_guard7_invalid_lists_rejects_attach_into_kids(tmp_path):
    (tmp_path / "kids-allowlist.json").write_text("[not, an, object]")
    lists = KidsLists.load(tmp_path)
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(candidates=[candidate(2)])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, lists=lists))
    assert not ok


# --- human answer strictness (guard 7 + guard 10) ---------------------------


def test_guard7_human_answer_must_be_dict_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists, human_answer="kids"),
    )
    assert not ok


def test_guard7_human_answer_empty_choice_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": ""}),
    )
    assert not ok


def test_guard7_human_answer_non_kids_choice_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": "attach"}),
    )
    assert not ok


def test_guard7_human_kids_override_on_attach_path(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(candidates=[candidate(2)], fresh_series="x")
    ok, msg = check_intent(
        attach_intent(2), ctx(dossier, index, lists=lists, human_answer={"choice": "kids"}),
    )
    assert ok


def test_guard7_override_note_names_missing_allowlist_hit(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    dossier = _dossier_for_kids()
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": "kids"}),
    )
    assert ok
    assert "allowlist" in msg.lower()


def test_guard7_override_note_names_denylist_hit(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("x",), deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": "kids"}),
    )
    assert ok
    assert "denylist" in msg.lower()


def test_guard10_human_answer_must_be_dict_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer="yes"))
    assert not ok


def test_guard10_human_answer_empty_choice_rejected():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer={"choice": ""}))
    assert not ok


def test_guard10_human_answer_any_nonempty_choice_counts():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer={"choice": "attach"}))
    assert ok


# --- guard 8: folder-name collision ------------------------------------------


def test_guard8_folder_collision_rejected_case_insensitive():
    index = FakeIndex({
        9: make_book(9, library="Library", folder="/books/Library/martha wells/artificial condition"),
    })
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(make_dossier(), index))
    assert not ok


def test_guard8_folder_no_collision_accepted():
    index = FakeIndex({
        9: make_book(9, library="Library", folder="/books/Library/Someone Else/Different Book"),
    })
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(make_dossier(), index))
    assert ok


def test_guard8_collision_only_checked_within_target_library():
    index = FakeIndex({
        9: make_book(9, library="Kids Audiobooks",
                     folder="/books/Kids Audiobooks/Martha Wells/Artificial Condition"),
    })
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(make_dossier(), index))
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


# --- I3: guard 10 fallback for a candidate with no dossier measure ----------


def test_guard10_fallback_computes_disagreement_when_no_measure():
    index = FakeIndex({2: make_book(2, series_index=3)})
    dossier = make_dossier(candidates=[candidate(2)], measures=[], arrival_series_index=2.0)
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert not ok


def test_guard10_fallback_computes_agreement_when_no_measure():
    index = FakeIndex({2: make_book(2, series_index=2)})
    dossier = make_dossier(candidates=[candidate(2)], measures=[], arrival_series_index=2.0)
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


def test_guard10_fallback_unknown_when_missing_data_does_not_reject():
    index = FakeIndex({2: make_book(2)})  # seriesIndex None
    dossier = make_dossier(candidates=[candidate(2)], measures=[])  # arrival_series_index None
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index))
    assert ok


def test_guard10_fallback_disagreement_overridden_by_human():
    index = FakeIndex({2: make_book(2, series_index=3)})
    dossier = make_dossier(candidates=[candidate(2)], measures=[], arrival_series_index=2.0)
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer={"choice": "attach"}))
    assert ok


# --- I6: arrival must match the dossier this check_intent call is for ------


def test_guard_arrival_mismatch_rejected_attach():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)])
    intent = attach_intent(2, arrival="a-different-arrival-key")
    ok, msg = check_intent(intent, ctx(dossier, index))
    assert not ok


def test_guard_arrival_mismatch_rejected_create_book():
    intent = create_book_intent(arrival="a-different-arrival-key")
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({})))
    assert not ok


def test_guard_arrival_mismatch_rejected_escalate():
    intent = escalate_intent(arrival="a-different-arrival-key")
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({})))
    assert not ok


def test_guard_arrival_mismatch_rejected_defer():
    intent = defer_intent(arrival="a-different-arrival-key")
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({})))
    assert not ok


def test_guard_arrival_match_accepted():
    intent = defer_intent(arrival=DEFAULT_ARRIVAL_KEY)
    ok, msg = check_intent(intent, ctx(make_dossier(key=DEFAULT_ARRIVAL_KEY), FakeIndex({})))
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
