"""Direct unit tests for the pure helpers in app/bookmeta.py that don't
already get full coverage indirectly through tests/test_executor.py.

`update_metadata_fields` (Plan 2 Task 3) maps an update_metadata intent's
LLM-facing metadata keys to BookOrbit's PATCH body key names -- the same
`series` -> `seriesName` mapping `create_metadata` uses, but with no
arrival-derived overrides, since update_metadata corrects a book that
already exists rather than deriving identity from a brand-new arrival file.
"""
from app.bookmeta import update_metadata_fields


def test_update_metadata_fields_maps_series_to_seriesname():
    out = update_metadata_fields({"series": "Murderbot Diaries", "seriesIndex": 2})
    assert out == {"seriesName": "Murderbot Diaries", "seriesIndex": "2"}


def test_update_metadata_fields_passes_through_simple_fields():
    out = update_metadata_fields({"title": "New Title", "subtitle": "A Subtitle", "language": "en"})
    assert out == {"title": "New Title", "subtitle": "A Subtitle", "language": "en"}


def test_update_metadata_fields_authors_passthrough_as_list():
    out = update_metadata_fields({"authors": ["Martha Wells", "Someone Else"]})
    assert out == {"authors": ["Martha Wells", "Someone Else"]}


def test_update_metadata_fields_published_year_coerced_to_int():
    out = update_metadata_fields({"publishedYear": 2020.0})
    assert out == {"publishedYear": 2020}


def test_update_metadata_fields_audible_id_passthrough():
    out = update_metadata_fields({"audibleId": "B0TEST1234"})
    assert out == {"audibleId": "B0TEST1234"}


def test_update_metadata_fields_ignores_narrators_and_asin_tag():
    # narrators has no confirmed PATCH key (see bookmeta's own docstring);
    # asinTag only makes sense as a tag derived from a NEW arrival's own
    # file, which update_metadata never has.
    out = update_metadata_fields({"title": "T", "narrators": ["N"], "asinTag": "B0X"})
    assert out == {"title": "T"}


def test_update_metadata_fields_empty_input_gives_empty_output():
    assert update_metadata_fields({}) == {}


def test_update_metadata_fields_none_values_omitted():
    out = update_metadata_fields({"title": "T", "subtitle": None, "series": None})
    assert out == {"title": "T"}


def test_update_metadata_fields_fractional_series_index_kept():
    out = update_metadata_fields({"seriesIndex": 2.5})
    assert out == {"seriesIndex": "2.5"}


def test_policy_mapped_fields_equal_the_keys_update_metadata_fields_maps():
    """Final review M7: policy._UPDATE_METADATA_MAPPED_FIELDS is kept in
    lockstep with bookmeta.update_metadata_fields by hand -- pin it."""
    from app import bookmeta as bm
    from app import policy
    samples = {"authors": ["A. Author"], "seriesIndex": 1, "publishedYear": 2020}
    candidates = (set(policy._UPDATE_METADATA_MAPPED_FIELDS) | set(policy._UPDATE_METADATA_REJECTED_KEYS)
                  | set(bm._UPDATE_METADATA_SIMPLE_FIELDS)
                  | {"description", "isbn", "tags", "genres", "publisher", "seriesName", "narrator"})
    mapped = {k for k in candidates if bm.update_metadata_fields({k: samples.get(k, "x")})}
    assert mapped == set(policy._UPDATE_METADATA_MAPPED_FIELDS)


# --- Task 9c ---------------------------------------------------------------------


def test_create_metadata_sends_every_identity_field_null_when_absent():
    """(c): the provider fetch after import writes junk into unset fields
    (a bogus series, live); null clears it."""
    from app.bookmeta import IDENTITY, create_metadata
    out = create_metadata({"title": "T", "authors": ["A"]}, {"source": "manual"})
    f = out["fields"]
    assert set(IDENTITY) <= set(f)
    assert f["title"] == "T" and f["authors"] == ["A"]
    assert all(f[k] is None for k in ("subtitle", "seriesName", "seriesIndex", "publishedYear", "language"))


def test_create_metadata_drops_index_without_series():
    from app.bookmeta import create_metadata
    f = create_metadata({"title": "T", "authors": ["A"], "seriesIndex": 3}, {"source": "manual"})["fields"]
    assert f["seriesName"] is None and f["seriesIndex"] is None
    f = create_metadata({"title": "T", "authors": ["A"], "series": "S", "seriesIndex": 3,
                         "publishedYear": 2001, "language": "en", "subtitle": "Sub"},
                        {"source": "manual"})["fields"]
    assert (f["seriesName"], f["seriesIndex"], f["publishedYear"], f["language"], f["subtitle"]) == \
        ("S", "3", 2001, "en", "Sub")


def test_identity_locks_cover_every_identity_field():
    from app import bookmeta
    assert set(bookmeta.IDENTITY_LOCKS) == set(bookmeta.IDENTITY)
    assert set(bookmeta.CREATE_LOCKS) == set(bookmeta.IDENTITY) | {"description"}
