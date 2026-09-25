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


def update_metadata_intent(book_id, *, metadata=None, lock=None, arrival=DEFAULT_ARRIVAL_KEY,
                            reason="fixing the series name"):
    return {
        "kind": "update_metadata", "arrival": arrival, "book_id": book_id,
        "metadata": metadata if metadata is not None else {"series": "Murderbot Diaries"},
        "lock": lock if lock is not None else [],
        "reason": reason,
    }


def answer(option_intent=None, *, option=None, text=None):
    """A human_answer in the Global shape (Plan 2 Task 6), as
    app/escalations.py builds it from a Vikunja reply."""
    if option_intent is None:
        choice = None
    elif option_intent.get("kind") == "create_book" and option_intent.get("library") == "kids":
        choice = "kids"
    else:
        choice = "option"
    if option is None and option_intent is not None:
        option = 1
    return {"text": text if text is not None else str(option or "free text"), "option": option,
            "option_intent": option_intent, "choice": choice, "comment_id": 7}


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
    """Build a dossier the way build_dossier actually would: `kids_inputs`
    already holds the parsed/normalized series name and the plain
    asins/authors lists (fix round 2 -- guard 7 must consume exactly this,
    not re-derive its own from raw tag text)."""
    d = make_dossier(
        candidates=candidates,
        kids={"allow": list(stored_allow), "deny": list(stored_deny)},
    )
    d["untrusted"] = {
        "files": [], "epub": None, "sidecar": None, "folder_name": "x",
        "kids_inputs": {
            "series": fresh_series,
            "asins": list(fresh_asins),
            "authors": list(fresh_authors),
        },
    }
    return d


# --- render_folder -------------------------------------------------------


def test_render_folder_with_series_and_index_is_zero_padded():
    # BookOrbit formatSeriesIndex pads the whole part to 2 digits (Task 9b probe)
    assert render_folder("Martha Wells", "Murderbot Diaries", 2.0, "Artificial Condition") == \
        "Martha Wells/Murderbot Diaries/02. Artificial Condition"


def test_render_folder_probe_observed_output():
    assert render_folder(["Librarian Probe Author"], "The Arcanaeum", "3", "Librarian Probe") == \
        "Librarian Probe Author/The Arcanaeum/03. Librarian Probe"


def test_render_folder_no_series_drops_segment_and_prefix():
    assert render_folder("A", None, None, "T") == "A/T"


def test_render_folder_series_without_index_has_no_prefix():
    assert render_folder("A", "S", None, "T") == "A/S/T"


def test_render_folder_fractional_index_keeps_decimal():
    assert render_folder("A", "S", 2.5, "T") == "A/S/02.5. T"
    assert render_folder("A", "The Witcher", "0.5", "The Last Wish") == "A/The Witcher/00.5. The Last Wish"


def test_render_folder_large_integer_index_no_scientific_notation():
    assert render_folder("A", "S", 1234567.0, "T") == "A/S/1234567. T"


def test_render_folder_sanitizes_colon_like_bookorbit():
    # real library: "The Mistborn Saga_ The Original Trilogy/03.5. Mistborn_ Secret History"
    assert render_folder("Brandon Sanderson", "The Mistborn Saga: The Original Trilogy", "3.5",
                         "Mistborn: Secret History") == \
        "Brandon Sanderson/The Mistborn Saga_ The Original Trilogy/03.5. Mistborn_ Secret History"


def test_render_folder_index_without_series_still_prefixes_like_bookorbit():
    assert render_folder("A", None, "2", "T") == "A/02. T"


def test_render_intent_folder_sends_no_index_without_a_series():
    from app.policy import render_intent_folder
    assert render_intent_folder({"authors": ["A", "B"], "title": "T", "seriesIndex": 2}) == "A/T"
    assert render_intent_folder({"authors": ["A"], "title": "T", "series": "S", "seriesIndex": 2}) == "A/S/02. T"


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
    ok, msg = validate_shape({"kind": "reticulate_splines", "arrival": "x"})
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


# --- validate_shape: update_metadata ----------------------------------------


def test_validate_shape_update_metadata_valid():
    assert validate_shape(update_metadata_intent(2))[0]


def test_validate_shape_update_metadata_requires_fields():
    ok, msg = validate_shape({"kind": "update_metadata", "arrival": "x"})
    assert not ok
    assert "book_id" in msg and "metadata" in msg and "lock" in msg and "reason" in msg


def test_validate_shape_update_metadata_book_id_must_be_int():
    intent = update_metadata_intent(2)
    intent["book_id"] = "2"
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_update_metadata_book_id_bool_rejected():
    intent = update_metadata_intent(2)
    intent["book_id"] = True
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_update_metadata_empty_metadata_rejected():
    intent = update_metadata_intent(2, metadata={})
    ok, msg = validate_shape(intent)
    assert not ok
    assert "metadata" in msg


def test_validate_shape_update_metadata_does_not_require_title_or_authors():
    # unlike create_book, a correction may touch only one field
    assert validate_shape(update_metadata_intent(2, metadata={"title": "New Title"}))[0]
    assert validate_shape(update_metadata_intent(2, metadata={"authors": ["Someone"]}))[0]


def test_validate_shape_update_metadata_unknown_metadata_key_rejected():
    intent = update_metadata_intent(2, metadata={"bogus": "x"})
    ok, msg = validate_shape(intent)
    assert not ok
    assert "bogus" in msg


def test_validate_shape_update_metadata_reuses_create_book_field_checks():
    # title path-segment check
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": "A/B"}))
    assert not ok
    # authors[0] path-segment check
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"authors": [".."]}))
    assert not ok
    # series index must be a finite number
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"seriesIndex": "abc"}))
    assert not ok
    # published year must be a finite number
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"publishedYear": "2020"}))
    assert not ok
    # empty title rejected
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": ""}))
    assert not ok
    # empty authors list rejected
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"authors": []}))
    assert not ok


def test_validate_shape_update_metadata_lock_must_be_list():
    intent = update_metadata_intent(2, lock="title")
    ok, msg = validate_shape(intent)
    assert not ok


def test_validate_shape_update_metadata_lock_allows_title_subtitle_description():
    assert validate_shape(update_metadata_intent(2, lock=["title", "subtitle", "description"]))[0]


def test_validate_shape_update_metadata_lock_allows_every_identity_field():
    # Task 9c (b): every identity field the librarian sets is locked, so the
    # post-import provider fetch can never overwrite it
    lock = ["title", "subtitle", "authors", "seriesName", "seriesIndex", "publishedYear", "language"]
    assert validate_shape(update_metadata_intent(2, lock=lock))[0]


def test_validate_shape_update_metadata_lock_rejects_non_identity_fields():
    ok, msg = validate_shape(update_metadata_intent(2, lock=["genres"]))
    assert not ok
    assert "lock" in msg


def test_validate_shape_update_metadata_lock_rejects_unknown_entry():
    ok, msg = validate_shape(update_metadata_intent(2, lock=["bogus"]))
    assert not ok


def test_validate_shape_update_metadata_lock_empty_list_ok():
    assert validate_shape(update_metadata_intent(2, lock=[]))[0]


def test_validate_shape_update_metadata_reason_required():
    intent = update_metadata_intent(2, reason="")
    ok, msg = validate_shape(intent)
    assert not ok


# --- fix round 1, Important: narrators/asinTag/None must be REJECTED, not --
# --- silently dropped -- an approved no-op intent used to reach the       --
# --- executor with nothing left to patch                                  --


def test_validate_shape_update_metadata_rejects_narrators():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": "T", "narrators": ["N"]}))
    assert not ok
    assert "narrators" in msg


def test_validate_shape_update_metadata_rejects_asin_tag():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": "T", "asinTag": "B0X"}))
    assert not ok
    assert "asinTag" in msg


def test_validate_shape_update_metadata_rejects_only_narrators_and_asin_tag():
    # nothing left for update_metadata_fields to map -- must be rejected,
    # not silently accepted as a no-op
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"narrators": ["N"], "asinTag": "B0X"}))
    assert not ok


def test_validate_shape_update_metadata_rejects_none_value():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": "T", "subtitle": None}))
    assert not ok
    assert "subtitle" in msg


def test_validate_shape_update_metadata_rejects_none_title():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"title": None}))
    assert not ok
    assert "title" in msg


def test_validate_shape_update_metadata_rejects_empty_string_series():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"series": ""}))
    assert not ok
    assert "series" in msg


def test_validate_shape_update_metadata_rejects_empty_string_subtitle():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"subtitle": ""}))
    assert not ok
    assert "subtitle" in msg


def test_validate_shape_update_metadata_rejects_empty_string_language():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"language": ""}))
    assert not ok
    assert "language" in msg


def test_validate_shape_update_metadata_rejects_empty_string_audible_id():
    ok, msg = validate_shape(update_metadata_intent(2, metadata={"audibleId": ""}))
    assert not ok
    assert "audibleId" in msg


def test_validate_shape_update_metadata_series_index_alone_is_a_mapped_field():
    # seriesIndex without series still maps to something patchable
    assert validate_shape(update_metadata_intent(2, metadata={"seriesIndex": 3}))[0]


def test_validate_shape_update_metadata_audible_id_alone_is_valid():
    assert validate_shape(update_metadata_intent(2, metadata={"audibleId": "B0TEST1234"}))[0]


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


def _never_raises_update_metadata(mutate) -> None:
    intent = update_metadata_intent(2)
    mutate(intent)
    index = FakeIndex({})
    dossier = make_dossier()
    ok, msg = check_intent(intent, ctx(dossier, index))  # must not raise
    assert ok is False
    assert isinstance(msg, str) and msg


def test_check_intent_never_raises_update_metadata_book_id_wrong_type():
    _never_raises_update_metadata(lambda i: i.__setitem__("book_id", "nope"))


def test_check_intent_never_raises_update_metadata_lock_wrong_type():
    _never_raises_update_metadata(lambda i: i.__setitem__("lock", "title"))


def test_check_intent_never_raises_update_metadata_metadata_wrong_type():
    _never_raises_update_metadata(lambda i: i.__setitem__("metadata", "x"))


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


# --- update_metadata: book_id existence + library allowlist -----------------


def test_update_metadata_book_id_not_in_index_rejected():
    index = FakeIndex({})
    ok, msg = check_intent(update_metadata_intent(2), ctx(make_dossier(), index))
    assert not ok


def test_update_metadata_book_id_valid_target_accepted():
    index = FakeIndex({2: make_book(2)})
    ok, msg = check_intent(update_metadata_intent(2), ctx(make_dossier(), index))
    assert ok


def test_update_metadata_target_comics_rejected():
    index = FakeIndex({2: make_book(2, library="Comics")})
    ok, msg = check_intent(update_metadata_intent(2), ctx(make_dossier(), index))
    assert not ok


def test_update_metadata_target_unknown_library_rejected():
    index = FakeIndex({2: make_book(2, library="Secret")})
    ok, msg = check_intent(update_metadata_intent(2), ctx(make_dossier(), index))
    assert not ok


# --- guard 7 applies to update_metadata's kids target too -------------------


def test_update_metadata_kids_target_deny_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(update_metadata_intent(2), ctx(dossier, index, lists=lists))
    assert not ok


def test_update_metadata_kids_target_allow_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(update_metadata_intent(2), ctx(dossier, index, lists=lists))
    assert ok


def test_update_metadata_kids_human_override_accepted(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        update_metadata_intent(2), ctx(dossier, index, lists=lists, human_answer=answer(attach_intent(2))),
    )
    assert ok


def test_update_metadata_adult_target_ignores_kids_signals(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Library")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(update_metadata_intent(2), ctx(dossier, index, lists=lists))
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


# --- I4 fix round 2: guard 7 must use build_dossier's OWN parsed series, ---
# --- not re-derive one from a raw tag (a "#2" suffix normalizes          ---
# --- differently than the plain series name) -------------------------------


def test_guard7_hash_number_series_tag_matches_plain_denylist_entry(tmp_path):
    from app.titles import parse_series

    lists = _kids_dir_lists(tmp_path, deny_series=("Murderbot Diaries",))
    # This is what build_dossier ACTUALLY stores in kids_inputs.series: the
    # PARSED name, with the "#2" already split off by parse_series -- not
    # the raw tag "Murderbot Diaries #2" (which normalizes to "murderbot
    # diaries 2" and would never match "Murderbot Diaries").
    parsed_series, _number = parse_series("Murderbot Diaries #2")
    dossier = _dossier_for_kids(fresh_series=parsed_series)

    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert not ok


def test_guard7_hash_number_series_tag_matches_plain_allowlist_entry(tmp_path):
    from app.titles import parse_series

    lists = _kids_dir_lists(tmp_path, allow_series=("Murderbot Diaries",))
    parsed_series, _number = parse_series("Murderbot Diaries #2")
    dossier = _dossier_for_kids(fresh_series=parsed_series)

    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert ok


def test_guard7_raw_hash_number_series_tag_would_have_missed_the_denylist():
    """Documents the actual bug this fix closes: normalizing the RAW tag
    (what the old, reverted _extract_kids_inputs did) produces a DIFFERENT
    key than normalizing the parsed series name, so a naive re-derivation
    silently misses list entries."""
    from app.titles import normalize, parse_series

    raw_normalized = normalize("Murderbot Diaries #2")
    parsed_series, _number = parse_series("Murderbot Diaries #2")
    assert raw_normalized != normalize("Murderbot Diaries")
    assert parsed_series == normalize("Murderbot Diaries")


# --- fix round 2 minor: malformed kids_inputs must never crash guard 7 -----


def test_guard7_malformed_kids_inputs_does_not_raise():
    lists = KidsLists.load("/nonexistent-dir-for-tests")
    dossier = make_dossier()
    dossier["untrusted"]["kids_inputs"] = {
        "series": ["not", "a", "string"],
        "asins": "not-a-list",
        "authors": "Not A List",
    }
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert ok is False  # no crash; safe default is reject (no valid fresh allow)


def test_guard7_kids_inputs_with_non_string_list_entries_does_not_raise(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("x",))
    dossier = make_dossier()
    dossier["untrusted"]["kids_inputs"] = {
        "series": "x",
        "asins": [123, None, "real-asin"],
        "authors": [456, {"nested": "dict"}, "Real Author"],
    }
    ok, msg = check_intent(create_book_intent(library="kids"), ctx(dossier, FakeIndex({}), lists=lists))
    assert ok  # "x" still matches; the junk entries are filtered, not fatal


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
        ctx(dossier, FakeIndex({}), lists=lists, human_answer=answer(create_book_intent(library="kids"))),
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
        attach_intent(2), ctx(dossier, index, lists=lists, human_answer=answer(attach_intent(2))),
    )
    assert ok


def test_guard7_override_note_names_missing_allowlist_hit(tmp_path):
    lists = _kids_dir_lists(tmp_path)
    dossier = _dossier_for_kids()
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer=answer(create_book_intent(library="kids"))),
    )
    assert ok
    assert "allowlist" in msg.lower()


def test_guard7_override_note_names_denylist_hit(tmp_path):
    lists = _kids_dir_lists(tmp_path, allow_series=("x",), deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, msg = check_intent(
        create_book_intent(library="kids"),
        ctx(dossier, FakeIndex({}), lists=lists, human_answer=answer(create_book_intent(library="kids"))),
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


def test_guard10_legacy_choice_without_option_intent_no_longer_counts():
    index = FakeIndex({2: make_book(2)})
    dossier = make_dossier(candidates=[candidate(2)],
                            measures=[{"book_id": 2, "series_index_agreement": "disagree"}])
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer={"choice": "attach"}))
    assert not ok


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


# --- guard 8 amendment: two create_books in one run can't render the same --
# --- folder, even before either is a real book in the index ----------------


def test_guard8_same_run_folder_claim_collision_rejected():
    claims = {("folder", "Library", "martha wells/artificial condition"): "run1:1"}
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"],
                                 arrival="libation:Y:def456")
    ok, msg = check_intent(intent, ctx(make_dossier(key="libation:Y:def456"), FakeIndex({}), run_claims=claims))
    assert not ok


def test_guard8_same_run_folder_claim_different_folder_accepted():
    claims = {("folder", "Library", "someone else/different book"): "run1:1"}
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({}), run_claims=claims))
    assert ok


def test_guard8_same_run_folder_claim_different_library_ignored():
    claims = {("folder", "Kids Audiobooks", "martha wells/artificial condition"): "run1:1"}
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({}), run_claims=claims))
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
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer=answer(attach_intent(2))))
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
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer=answer(attach_intent(2))))
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
    assert ("arrival", dossier["key"]) in claims


def test_claims_for_create_book_includes_folder_claim():
    dossier = make_dossier()
    intent = create_book_intent(library="adult", title="Artificial Condition", authors=["Martha Wells"])
    claims = claims_for(intent, dossier)
    assert ("folder", "Library", "martha wells/artificial condition") in claims


def test_claims_for_update_metadata_takes_no_claims():
    dossier = make_dossier()
    assert claims_for(update_metadata_intent(2), dossier) == []


# --- Plan 2 Task 6: human answers honoured only when the intent matches ----
# --- the option the human selected (Global "Human answer shape") -----------


def _disagree(book_id=2, others=()):
    index = FakeIndex({book_id: make_book(book_id), **{o: make_book(o) for o in others}})
    dossier = make_dossier(candidates=[candidate(book_id)] + [candidate(o) for o in others],
                            measures=[{"book_id": b, "series_index_agreement": "disagree"}
                                      for b in (book_id, *others)])
    return dossier, index


def test_guard10_reply_2_leave_it_for_me_does_not_unlock():
    dossier, index = _disagree()
    ha = answer(None, option=2, text="2")    # option 2 = "Leave it for me" (no intent)
    ok, msg = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert not ok
    assert "series index" in msg


def test_guard10_free_text_answer_never_overrides():
    dossier, index = _disagree()
    ha = answer(None, text="yes attach it to book 2, the index is wrong")
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert not ok


def test_guard10_answer_for_a_different_book_does_not_unlock():
    dossier, index = _disagree(2, others=(3,))
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=answer(attach_intent(3))))
    assert not ok
    ok, _ = check_intent(attach_intent(3), ctx(dossier, index, human_answer=answer(attach_intent(3))))
    assert ok


def test_guard10_answer_of_a_different_kind_does_not_unlock():
    dossier, index = _disagree()
    ha = answer(create_book_intent(library="adult"))
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert not ok


def test_guard10_attach_option_without_book_id_does_not_unlock():
    dossier, index = _disagree()
    ha = answer({"kind": "attach", "arrival": DEFAULT_ARRIVAL_KEY})
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert not ok


def test_guard10_bool_book_id_in_option_does_not_match_int():
    dossier, index = _disagree(1)
    ha = answer({"kind": "attach", "arrival": DEFAULT_ARRIVAL_KEY, "book_id": True})
    ok, _ = check_intent(attach_intent(1), ctx(dossier, index, human_answer=ha))
    assert not ok


def test_guard10_option_for_another_arrival_does_not_unlock():
    dossier, index = _disagree()
    ha = answer(attach_intent(2, arrival="libation:OTHER:def"))
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert not ok


def test_guard10_option_without_arrival_key_compares_kind_and_book_id():
    dossier, index = _disagree()
    ha = answer({"kind": "attach", "book_id": 2})
    ok, _ = check_intent(attach_intent(2), ctx(dossier, index, human_answer=ha))
    assert ok


def test_guard7_legacy_kids_choice_without_option_intent_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ok, _ = check_intent(create_book_intent(library="kids"),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer={"choice": "kids"}))
    assert not ok


def test_guard7_free_text_kids_answer_never_overrides(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer(None, text="put it in kids please")
    ok, _ = check_intent(create_book_intent(library="kids"),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert not ok


def test_guard7_adult_option_does_not_unlock_kids_create(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer(create_book_intent(library="adult"))
    ok, _ = check_intent(create_book_intent(library="kids"),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert not ok


def test_guard7_kids_create_with_another_title_does_not_unlock(tmp_path):
    """Final review M5: a kids create_book answer unlocks only the book the
    human saw -- title and first author (normalised) must match too."""
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer(create_book_intent(library="kids", title="Some Other Title"))
    assert ha["choice"] == "kids"
    ok, _ = check_intent(create_book_intent(library="kids", title="The Real Title"),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert not ok


def test_guard7_kids_create_with_another_first_author_does_not_unlock(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer(create_book_intent(library="kids", authors=["Someone Else", "Martha Wells"]))
    ok, _ = check_intent(create_book_intent(library="kids", authors=["Martha Wells"]),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert not ok


def test_guard7_kids_create_matches_title_and_author_normalised(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer(create_book_intent(library="kids", title="  the REAL  title ",
                                   authors=["martha  WELLS", "Co Author"]))
    ok, msg = check_intent(create_book_intent(library="kids", title="The Real Title",
                                              authors=["Martha Wells"]),
                           ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert ok, msg
    assert "human" in msg


def test_guard7_kids_create_option_without_metadata_does_not_unlock(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    dossier = _dossier_for_kids(fresh_series="x")
    ha = answer({"kind": "create_book", "library": "kids"})
    ok, _ = check_intent(create_book_intent(library="kids"),
                         ctx(dossier, FakeIndex({}), lists=lists, human_answer=ha))
    assert not ok

def test_guard7_attach_option_for_another_kids_book_does_not_unlock(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks"),
                       3: make_book(3, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(candidates=[candidate(2), candidate(3)], fresh_series="x")
    ok, _ = check_intent(attach_intent(2),
                         ctx(dossier, index, lists=lists, human_answer=answer(attach_intent(3))))
    assert not ok


def test_guard7_update_metadata_paired_with_answered_attach_allowed(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, _ = check_intent(update_metadata_intent(2),
                         ctx(dossier, index, lists=lists, human_answer=answer(attach_intent(2))))
    assert ok


def test_guard7_update_metadata_for_another_book_than_answered_attach_rejected(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks"),
                       3: make_book(3, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, _ = check_intent(update_metadata_intent(2),
                         ctx(dossier, index, lists=lists, human_answer=answer(attach_intent(3))))
    assert not ok


def test_guard7_update_metadata_needs_an_attach_answer_not_a_create(tmp_path):
    lists = _kids_dir_lists(tmp_path, deny_series=("x",))
    index = FakeIndex({2: make_book(2, library="Kids Audiobooks")})
    dossier = _dossier_for_kids(fresh_series="x")
    ok, _ = check_intent(update_metadata_intent(2),
                         ctx(dossier, index, lists=lists,
                             human_answer=answer(create_book_intent(library="kids"))))
    assert not ok


# --- guard 12: umbrella series (2026-09-24) -------------------------------------------------


def _member_book(bid, series, index, extras=()):
    ms = [{"seriesName": series, "seriesIndex": index, "displayOrder": 0}] + \
         [{"seriesName": n, "seriesIndex": i, "displayOrder": k + 1} for k, (n, i) in enumerate(extras)]
    return dict(make_book(bid), seriesName=series, seriesIndex=index, seriesMemberships=ms)


def test_create_book_with_an_umbrella_or_alias_as_its_series_is_refused():
    for series in ("The Cosmere", "cosmere", "The Realm of the Elderlings"):
        ok, msg = check_intent(create_book_intent(series=series, series_index=6),
                               ctx(make_dossier(), FakeIndex({})))
        assert not ok and "umbrella" in msg, (series, msg)
    ok, msg = check_intent(create_book_intent(series="The Stormlight Archive", series_index=6),
                           ctx(make_dossier(), FakeIndex({})))
    assert ok, msg


def test_update_metadata_series_rules_on_a_book_with_an_umbrella():
    index = FakeIndex({2: _member_book(2, "The Stormlight Archive", "1", [("The Cosmere", "6")])})
    ok, msg = check_intent(update_metadata_intent(2, metadata={"series": "Warbreaker"}), ctx(make_dossier(), index))
    assert not ok and "'The Cosmere'" in msg
    ok, msg = check_intent(update_metadata_intent(2, metadata={"series": "Mistborn"}), ctx(make_dossier(), index))
    assert not ok and "umbrella series 'The Mistborn Saga'" in msg
    ok, msg = check_intent(update_metadata_intent(2, metadata={"series": "The Cosmere"}), ctx(make_dossier(), index))
    assert not ok and "umbrella" in msg
    ok, msg = check_intent(update_metadata_intent(2, metadata={"series": "the stormlight archive", "seriesIndex": 2}),
                           ctx(make_dossier(), index))
    assert ok, msg                                    # the same series: extras stay right
    ok, msg = check_intent(update_metadata_intent(2, metadata={"seriesIndex": 2}), ctx(make_dossier(), index))
    assert ok, msg


def test_update_metadata_series_change_on_a_plain_book_is_unaffected():
    index = FakeIndex({2: _member_book(2, "Murderbot", "2")})
    ok, msg = check_intent(update_metadata_intent(2), ctx(make_dossier(), index))
    assert ok, msg


def test_update_metadata_refuses_to_move_a_book_off_its_umbrella_series():
    index = FakeIndex({258: _member_book(258, "The Cosmere", "1")})
    ok, msg = check_intent(update_metadata_intent(258, metadata={"series": "Elantris"}), ctx(make_dossier(), index))
    assert not ok and "umbrella 'The Cosmere'" in msg


def test_create_book_under_an_umbrella_passes_only_on_the_humans_exact_choice():
    intent = create_book_intent(series="First Law World", series_index=12)
    chosen = {"option": 1, "option_intent": dict(create_book_intent(series="First Law World", series_index=12))}
    other = {"option": 1, "option_intent": dict(create_book_intent(series="The Age of Madness", series_index=4))}
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({})))
    assert not ok and "umbrella" in msg
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({}), human_answer=chosen))
    assert ok, msg
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({}), human_answer=other))
    assert not ok and "umbrella" in msg
    moved = {"option": 1, "option_intent": dict(create_book_intent(series="First Law World", series_index=3))}
    ok, msg = check_intent(intent, ctx(make_dossier(), FakeIndex({}), human_answer=moved))
    assert not ok and "umbrella" in msg            # the chosen position names the folder too
