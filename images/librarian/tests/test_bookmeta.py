"""Direct unit tests for the pure helpers in app/bookmeta.py that don't
already get full coverage indirectly through tests/test_executor.py.

`update_metadata_fields` (Plan 2 Task 3) maps an update_metadata intent's
LLM-facing metadata keys to BookOrbit's PATCH body key names -- the same
`series` -> `seriesName` mapping `create_metadata` uses, but with no
arrival-derived overrides, since update_metadata corrects a book that
already exists rather than deriving identity from a brand-new arrival file.
"""
import pytest

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


def test_create_metadata_nulls_absent_subtitle_and_series_but_omits_year_and_language():
    """(c): the provider fetch after import writes junk into unset fields
    (a bogus series, live); null clears it. Task 11: publishedYear and
    language are the exception -- absent and not in the EPUB OPF, they are
    left out (neither null nor locked)."""
    from app.bookmeta import create_metadata
    out = create_metadata({"title": "T", "authors": ["A"]}, {"source": "manual"})
    f = out["fields"]
    assert f["title"] == "T" and f["authors"] == ["A"]
    assert all(k in f and f[k] is None for k in ("subtitle", "seriesName", "seriesIndex"))
    assert "publishedYear" not in f and "language" not in f


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


def test_whitespace_normalised_like_bookorbit_normalizeMetadataText():
    """BookOrbit stores authors and seriesName through normalizeMetadataText
    (/\\s+/g -> " ", trimmed); title is stored verbatim."""
    from app.bookmeta import create_metadata, update_metadata_fields
    md = {"title": "T  x", "authors": [" Jane\u00a0\u00a0Author ", "Bob\tSmith", "jane author"],
          "series": "The\u2003 Saga "}
    f = create_metadata(md, {"source": "manual"})["fields"]
    assert f["authors"] == ["Jane Author", "Bob Smith"]           # deduped case-insensitively
    assert f["seriesName"] == "The Saga" and f["title"] == "T  x"
    u = update_metadata_fields(md)
    assert u["authors"] == ["Jane Author", "Bob Smith"] and u["seriesName"] == "The Saga"


def test_render_normalises_authors_and_series_whitespace():
    from app.policy import render_folder
    assert render_folder(["Jane\u00a0 Author"], "The  Saga", "1", "T") == "Jane Author/The Saga/01. T"


def test_render_identity_keeps_the_stored_series_index_string():
    from app.bookmeta import render_identity
    assert render_identity({"title": "T", "authors": [{"name": "A"}], "seriesIndex": "2.50"})["seriesIndex"] == "2.50"


# --- Task 11: language / publishedYear from the arrival's EPUB OPF ----------------


@pytest.mark.parametrize("value", ["en", "en-US", "fr", "zh-Hant", "sr-Latn-RS", "es-419", "eng",
                                   "English", "Old English", "x" * 20])
def test_plausible_language_accepts_codes_and_plain_names(value):
    from app.bookmeta import plausible_language
    assert plausible_language(value) == value
    assert plausible_language(f"  {value} ") == value


@pytest.mark.parametrize("value, normalised", [("en_US", "en-US"), (" en_GB ", "en-GB"),
                                               ("zh_Hant_TW", "zh-Hant-TW")])
def test_plausible_language_normalises_underscores_to_hyphens(value, normalised):
    """Fix round 1 (I1): "_" -> "-" first -- en_US is the same tag as en-US."""
    from app.bookmeta import plausible_language
    assert plausible_language(value) == normalised


@pytest.mark.parametrize("value", [
    None, 5, ["en"], "", "   ", "a", "x" * 21, "<b>en</b>", "en;fr", "en--US", "en-", "-",
    "\u200ben", "en\nUS",
    "419", "en_", "_en", "en__US",               # fix round 1 (I1)
    "und", "UND", "und-Latn",                    # primary subtag "und" = BCP-47 "undetermined"
    "en\u00b2", "\u2167", "Fran\u00e7ais",       # ASCII only: superscript two, Roman numeral eight, a non-ASCII name
])
def test_plausible_language_rejects_junk(value):
    from app.bookmeta import plausible_language
    assert plausible_language(value) is None


@pytest.mark.parametrize("value, year", [(2011, 2011), (1999.0, 1999), (1000, 1000), (2200, 2200)])
def test_plausible_year_takes_a_number_in_range(value, year):
    from app.bookmeta import plausible_year
    assert plausible_year(value) == year


@pytest.mark.parametrize("value", [None, True, "2011", 0, 999, 2201, -5, 20200, float("nan"), float("inf")])
def test_plausible_year_rejects_everything_else(value):
    from app.bookmeta import plausible_year
    assert plausible_year(value) is None


@pytest.mark.parametrize("value, year", [
    ("2011", 2011), ("2011-06", 2011), ("2011-06-07", 2011), ("2011-06-07T04:00:00+00:00", 2011),
    ("2011-06-07T04:00:00+0000", 2011), ("06/07/2011", 2011), (" 1851 ", 1851), ("1000", 1000),
    ("2200", 2200),
])
def test_opf_year_takes_the_four_digit_year(value, year):
    from app.bookmeta import opf_year
    assert opf_year(value) == year


@pytest.mark.parametrize("value", [None, 2011, "", "unknown", "0101-01-01T00:00:00+00:00",  # calibre: no date
                                   "999", "0999", "2201", "3000-01-01", "20110607", "12345"])
def test_opf_year_rejects_implausible_dates(value):
    from app.bookmeta import opf_year
    assert opf_year(value) is None


def test_create_metadata_fills_absent_language_and_year_from_the_opf():
    """The canary: the intent had no language, the OPF said "en"."""
    from app.bookmeta import create_metadata
    f = create_metadata({"title": "T", "authors": ["A"]}, {"source": "manual"},
                        {"language": "en", "date": "2011-06-07T04:00:00+00:00"})["fields"]
    assert (f["language"], f["publishedYear"]) == ("en", 2011)
    # an explicit null / empty string in the intent counts as absent
    f = create_metadata({"title": "T", "authors": ["A"], "language": "", "publishedYear": None},
                        {"source": "manual"}, {"language": " en-GB ", "date": "1999"})["fields"]
    assert (f["language"], f["publishedYear"]) == ("en-GB", 1999)


def test_create_metadata_intent_values_beat_the_opf():
    from app.bookmeta import create_metadata
    out = create_metadata({"title": "T", "authors": ["A"], "language": "fr", "publishedYear": 1999.0},
                          {"source": "manual"}, {"language": "en", "date": "2011"})
    assert (out["fields"]["language"], out["fields"]["publishedYear"]) == ("fr", 1999)
    assert out["dropped"] == []


def test_create_metadata_validates_the_intents_language_and_year_too():
    """Fix round 1 (M6): the intent's own language/year pass the same checks.
    A plausible one is normalised; an implausible one is dropped (reported in
    `dropped` for the executor to log -- a filing never fails over it) and
    the OPF value, or nothing, is used instead."""
    from app.bookmeta import create_metadata
    out = create_metadata({"title": "T", "authors": ["A"], "language": "en_US", "publishedYear": 2011},
                          {"source": "manual"})
    assert (out["fields"]["language"], out["fields"]["publishedYear"]) == ("en-US", 2011)
    assert out["dropped"] == []
    out = create_metadata({"title": "T", "authors": ["A"], "language": "<b>en</b>", "publishedYear": 20200},
                          {"source": "manual"}, {"language": "fr", "date": "1851"})
    assert (out["fields"]["language"], out["fields"]["publishedYear"]) == ("fr", 1851)
    assert out["dropped"] == ["language '<b>en</b>'", "publishedYear 20200"]
    out = create_metadata({"title": "T", "authors": ["A"], "language": "und", "publishedYear": 0},
                          {"source": "manual"})
    assert "language" not in out["fields"] and "publishedYear" not in out["fields"]
    assert out["dropped"] == ["language 'und'", "publishedYear 0"]


@pytest.mark.parametrize("epub", [
    None,                                                          # audio-only arrival: no EPUB at all
    {},
    {"language": None, "date": None},
    {"language": "und", "date": "0101-01-01T00:00:00+00:00"},      # calibre's "unknown" values
    {"language": "<script>", "date": "someday"},
    "not a dict",
])
def test_create_metadata_omits_what_neither_the_intent_nor_the_opf_supplies(epub):
    from app.bookmeta import create_metadata
    f = create_metadata({"title": "T", "authors": ["A"]}, {"source": "manual"}, epub)["fields"]
    assert "language" not in f and "publishedYear" not in f
    assert f["subtitle"] is None and f["seriesName"] is None and f["seriesIndex"] is None


def test_create_locks_cover_only_the_identity_fields_written():
    from app.bookmeta import CREATE_LOCKS, create_locks, create_metadata
    bare = create_metadata({"title": "T", "authors": ["A"]}, {"source": "manual"})["fields"]
    assert create_locks(bare) == {"title", "subtitle", "description", "authors", "seriesName", "seriesIndex"}
    full = create_metadata({"title": "T", "authors": ["A"], "language": "en", "publishedYear": 2001},
                           {"source": "manual"})["fields"]
    assert create_locks(full) == set(CREATE_LOCKS)
    assert create_locks(dict(bare, language="en")) == create_locks(bare) | {"language"}
