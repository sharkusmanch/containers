"""Umbrella series (2026-09-24): app.umbrella and the membership helpers of app.bookmeta."""
from app import bookmeta, umbrella
from app.bookorbit import LibraryIndex


def _book(bid=1, series=None, index=None, extras=()):
    ms = ([{"seriesName": series, "seriesIndex": index, "displayOrder": 0}] if series else []) + \
         [{"seriesName": n, "seriesIndex": i, "displayOrder": k + 1} for k, (n, i) in enumerate(extras)]
    return {"id": bid, "seriesName": series, "seriesIndex": index, "seriesMemberships": ms}


def test_key_is_bookorbits_series_identity():
    assert umbrella.key("  The   Cosmere ") == "the cosmere"
    assert umbrella.key(None) == "" and umbrella.key(7) == ""


def test_member_series_and_aliases():
    assert umbrella.umbrellas_for("The Stormlight Archive") == ["The Cosmere"]
    assert umbrella.umbrellas_for("the farseer  trilogy") == ["The Realm of the Elderlings"]
    assert umbrella.umbrellas_for("Farseer Trilogy") == ["The Realm of the Elderlings"]   # provider spelling
    assert umbrella.umbrellas_for("Mistborn: Wax & Wayne") == ["The Cosmere", "The Mistborn Saga"]
    assert umbrella.umbrellas_for("The Age of Madness") == ["First Law World"]
    assert umbrella.umbrellas_for("Secret Projects") == []          # mixed: not every one is Cosmere
    assert umbrella.umbrellas_for("The Cosmere") == []              # an umbrella is no member of itself
    for name, u in (("Cosmere", "The Cosmere"), ("Cosmere Universe", "The Cosmere"),
                    ("The Cosmere Collection", "The Cosmere"), ("The Elderlings", "The Realm of the Elderlings"),
                    ("realm of the elderlings", "The Realm of the Elderlings"), ("Mistborn", "The Mistborn Saga"),
                    ("The Mistborn Saga", "The Mistborn Saga"), ("First Law World", "First Law World")):
        assert umbrella.as_umbrella(name) == u, name
    for name in ("The Stormlight Archive", "Elantris", "The First Law", "The Mistborn Saga: The Original Trilogy",
                 "The Collection", "Series", None, ""):
        assert umbrella.as_umbrella(name) is None, name


def test_memberships_are_ordered_by_display_order():
    b = _book(series="Hoid's Travails", index="2", extras=[("The Cosmere", "18")])
    b["seriesMemberships"].reverse()
    assert umbrella.memberships(b) == [("Hoid's Travails", "2"), ("The Cosmere", "18")]
    assert umbrella.memberships({}) == []


def test_series_change_problem():
    plain = _book(series="Murderbot Diaries", index="2")
    cosmere = _book(series="The Stormlight Archive", index="1", extras=[("The Cosmere", "6")])
    elantris = _book(258, series="The Cosmere", index="1")                  # the umbrella IS its series
    assert "umbrella" in umbrella.series_change_problem({}, "The Cosmere")
    assert "umbrella" in umbrella.series_change_problem(plain, "Cosmere")           # an alias
    assert umbrella.series_change_problem(plain, "The Murderbot Diaries") is None    # no extras: free
    assert umbrella.series_change_problem({}, "The Stormlight Archive") is None      # a new book
    assert umbrella.series_change_problem(cosmere, "the stormlight  archive") is None  # same series
    why = umbrella.series_change_problem(cosmere, "Mistborn: Wax & Wayne")
    assert why and "'The Cosmere'" in why
    why = umbrella.series_change_problem(elantris, "Elantris")
    assert why and "umbrella 'The Cosmere'" in why
    assert umbrella.series_change_problem(elantris, "the cosmere") is None          # same series


def test_create_memberships():
    assert bookmeta.create_memberships({"seriesName": None, "seriesIndex": None}) == []
    assert bookmeta.create_memberships({}) == []
    assert bookmeta.create_memberships({"seriesName": "Saga", "seriesIndex": "2"}) == [
        {"seriesName": "Saga", "seriesIndex": "2"}]
    assert bookmeta.create_memberships({"seriesName": "The Stormlight Archive", "seriesIndex": "6"}) == [
        {"seriesName": "The Stormlight Archive", "seriesIndex": "6"},
        {"seriesName": "The Cosmere", "seriesIndex": None}]
    assert bookmeta.create_memberships({"seriesName": "Mistborn: Ghostbloods", "seriesIndex": "1"}) == [
        {"seriesName": "Mistborn: Ghostbloods", "seriesIndex": "1"},
        {"seriesName": "The Cosmere", "seriesIndex": None},
        {"seriesName": "The Mistborn Saga", "seriesIndex": None}]
    # a standalone a human filed under the umbrella itself: just that
    assert bookmeta.create_memberships({"seriesName": "First Law World", "seriesIndex": "12"}) == [
        {"seriesName": "First Law World", "seriesIndex": "12"}]
    # the index travels as BookOrbit's string (a number would be a 400)
    fields = bookmeta.create_metadata({"title": "T", "authors": ["A"], "series": "The Tawny Man", "seriesIndex": 2},
                                      {"source": "manual"})["fields"]
    for m in bookmeta.create_memberships(fields):
        assert m["seriesIndex"] is None or isinstance(m["seriesIndex"], str)
    # never an expectedBookCount: even null rewrites the count of the whole series
    for m in bookmeta.create_memberships({"seriesName": "Fitz and the Fool", "seriesIndex": "1"}):
        assert set(m) == {"seriesName", "seriesIndex"}


def test_memberships_match_by_key_and_numeric_index():
    want = [{"seriesName": "The Stormlight Archive", "seriesIndex": "6"},
            {"seriesName": "The Cosmere", "seriesIndex": None}]
    stored = _book(series="the stormlight archive", index="6.0", extras=[("The  Cosmere", None)])
    assert bookmeta.memberships_match(stored, want)
    assert not bookmeta.memberships_match(_book(series="The Stormlight Archive", index="6"), want)
    assert not bookmeta.memberships_match(
        _book(series="The Stormlight Archive", index="7", extras=[("The Cosmere", None)]), want)
    assert not bookmeta.memberships_match(
        _book(series="The Stormlight Archive", index="6", extras=[("The Cosmere", "6")]), want)
    assert bookmeta.memberships_match(_book(), [])


def test_summarize_shows_every_membership_primary_first():
    idx = LibraryIndex(client=None, state_path="/nonexistent/library-index.json")
    d = dict(_book(7, "Hoid's Travails", "2", [("The Cosmere", "18")]), title="Yumi", files=[])
    s = idx.summarize(d)
    assert s["series"] == "Hoid's Travails" and s["series_index"] == "2"
    assert s["series_memberships"] == [{"series": "Hoid's Travails", "index": "2"},
                                       {"series": "The Cosmere", "index": "18"}]
    assert idx.summarize(dict(_book(8), title="Solo", files=[]))["series_memberships"] == []


def test_create_metadata_files_an_umbrella_under_its_own_name():
    fields = bookmeta.create_metadata({"title": "T", "authors": ["A"], "series": "Cosmere Universe", "seriesIndex": 3},
                                      {"source": "manual"})["fields"]
    assert fields["seriesName"] == "The Cosmere"
    fields = bookmeta.create_metadata({"title": "T", "authors": ["A"], "series": "The Tawny Man", "seriesIndex": 1},
                                      {"source": "manual"})["fields"]
    assert fields["seriesName"] == "The Tawny Man"
