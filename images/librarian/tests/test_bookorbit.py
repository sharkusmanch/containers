import json
from app.bookorbit import FULL_REFRESH_INTERVAL_SECONDS, BookorbitClient, LibraryIndex

# `authors`/`narrators` on GET /books/{id} are objects ({"id","name","sortName"}),
# not plain strings -- verified live against bookorbit.sharkus.xyz 2026-09-22;
# the brief's draft fixture had them as strings, which crashed titles.surnames()
# on a real detail payload. Fixed here to match the real shape.
BOOKS = {
 1: {"id": 1, "title": "Star Wars: Thrawn", "subtitle": None,
     "authors": [{"id": 1, "name": "Timothy Zahn", "sortName": "Zahn, Timothy"}],
     "providerIds": {"audible": None}, "tags": [], "isbn13": "9780399178771", "isbn10": None,
     "libraryName": "Library", "seriesName": "Star Wars: Thrawn", "seriesIndex": 1,
     "publishedYear": 2017, "narrators": [], "readAloudSync": {"state": "unavailable"},
     "folderPath": "/books/Library/Timothy Zahn/Star Wars/1. Thrawn",
     "files": [{"format": "epub", "filename": "1. Thrawn.epub", "sizeBytes": 10}], "updatedAt": "t1"},
 2: {"id": 2, "title": "Artificial Condition", "subtitle": "The Murderbot Diaries",
     "authors": [{"id": 2, "name": "Martha Wells", "sortName": "Wells, Martha"}],
     "providerIds": {"audible": "B07BB1L9T6"}, "tags": ["asin:B07K1"],
     "isbn13": None, "isbn10": None, "libraryName": "Library", "seriesName": "Murderbot Diaries",
     "seriesIndex": 2, "publishedYear": 2018,
     # GET /books/{id} has no top-level "narrators" -- verified live
     # 2026-09-22 -- it's nested under audioMetadata.narrators for audio books.
     "audioMetadata": {"narrators": [{"id": 3, "name": "Kevin R. Free", "sortName": "Free, Kevin R."}]},
     "readAloudSync": {"state": "enabled"}, "folderPath": "/books/Library/Martha Wells/x",
     "files": [{"format": "m4b", "filename": "x.m4b", "sizeBytes": 5, "durationSeconds": 20000}],
     "updatedAt": "t2"},
}

def fake_transport(calls, books=BOOKS):
    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if url.endswith("/books/query"):
            page = json.loads(body)["pagination"]["page"]
            items = [{"id": i, "updatedAt": b["updatedAt"]} for i, b in books.items()] if page == 0 else []
            return 200, json.dumps({"items": items, "total": len(books), "page": page, "size": 100})
        bid = int(url.rsplit("/", 1)[1])
        return 200, json.dumps(books[bid])
    return t

def make(tmp_path, calls, books=BOOKS):
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=fake_transport(calls, books=books),
                        cookie_path=str(tmp_path / "c.txt"))
    c.authenticate()
    return LibraryIndex(c, state_path=str(tmp_path / "idx.json"))

def test_refresh_is_incremental(tmp_path):
    calls = []
    idx = make(tmp_path, calls)
    idx.refresh(now=0, force=True)
    n = len([c for c in calls if "/books/1" in c[1] or "/books/2" in c[1]])
    idx.refresh(now=10_000, force=True)
    m = len([c for c in calls if "/books/1" in c[1] or "/books/2" in c[1]])
    assert n == 2 and m == 2                     # unchanged updatedAt -> no detail refetch

def test_candidates_rank(tmp_path):
    idx = make(tmp_path, []); idx.refresh(now=0, force=True)
    ids = [d["id"] for d, _ in idx.candidates(titles=["Thrawn"], authors=["Timothy Zahn"])]
    assert ids == [1]
    top, reasons = idx.candidates(audible_asin="B07BB1L9T6")[0]
    assert top["id"] == 2 and "audible-asin" in reasons
    assert idx.candidates(kindle_asin="B07K1")[0][0]["id"] == 2
    assert idx.candidates(titles=["Unrelated"], authors=["Wells"]) == []

def test_local_path(tmp_path):
    idx = make(tmp_path, [])
    assert idx.local_path("/books/Library/a") == "/media/books/Library/a"

def test_local_path_rejects_outside_prefix(tmp_path):
    idx = make(tmp_path, [])
    try:
        idx.local_path("/other/x")
        assert False, "expected ValueError"
    except ValueError:
        pass

def test_summarize_extracts_object_shaped_authors_and_narrators(tmp_path):
    idx = make(tmp_path, []); idx.refresh(now=0, force=True)
    s = idx.summarize(idx.book(2))
    assert s["authors"] == ["Martha Wells"]
    assert s["narrators"] == ["Kevin R. Free"]
    assert s["kindle_asin"] == "B07K1"
    assert s["audible"] == "B07BB1L9T6"
    assert s["formats"] == [{"format": "m4b", "filename": "x.m4b", "size": 5, "duration_s": 20000}]
    assert s["readalong"] == "enabled"
    assert s["library"] == "Library"

def test_post_write_paths_rejected(tmp_path):
    idx = make(tmp_path, [])
    try:
        idx._client.post("/books/1/rename-files", {})
        assert False, "expected PermissionError"
    except PermissionError:
        pass

def test_client_has_no_write_verbs(tmp_path):
    idx = make(tmp_path, [])
    for verb in ("patch", "put", "delete"):
        assert not hasattr(idx._client, verb)

def test_detail_fresh_vs_cached(tmp_path):
    calls = []
    idx = make(tmp_path, calls)
    idx.refresh(now=0, force=True)
    before = len([c for c in calls if "/books/1" in c[1]])
    idx.detail(1, fresh=False)                    # cached -> no new GET
    after_cached = len([c for c in calls if "/books/1" in c[1]])
    idx.detail(1, fresh=True)                      # forces a re-GET
    after_fresh = len([c for c in calls if "/books/1" in c[1]])
    assert after_cached == before
    assert after_fresh == before + 1

# --- fix round 1 additions -----------------------------------------------

def test_full_refresh_every_24h_refetches_unchanged_details(tmp_path):
    calls = []
    idx = make(tmp_path, calls)
    idx.refresh(now=0, force=True)
    n = len([c for c in calls if "/books/1" in c[1] or "/books/2" in c[1]])
    # Same updatedAt as before, but 24h+1s later -> the independent full-
    # refresh clock should force a re-GET of every book regardless.
    idx.refresh(now=FULL_REFRESH_INTERVAL_SECONDS + 1, force=True)
    m = len([c for c in calls if "/books/1" in c[1] or "/books/2" in c[1]])
    assert n == 2
    assert m == n + 2   # both books refetched again despite unchanged updatedAt

def test_refresh_within_15_min_without_force_fetches_nothing(tmp_path):
    calls = []
    idx = make(tmp_path, calls)
    idx.refresh(now=0, force=True)
    before = len(calls)
    idx.refresh(now=100, force=False)   # well within the 15-min cadence, not forced
    after = len(calls)
    assert after == before   # no HTTP calls at all -- not even /books/query

def test_refresh_pagination_multi_page(tmp_path):
    calls = []
    ids = list(range(1, 251))  # 250 books -> pages of 100 need 3 requests

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if url.endswith("/books/query"):
            pagination = json.loads(body)["pagination"]
            page, size = pagination["page"], pagination["size"]
            page_ids = ids[page * size:(page + 1) * size]
            items = [{"id": i, "updatedAt": "t"} for i in page_ids]
            return 200, json.dumps({"items": items, "total": len(ids), "page": page, "size": size})
        bid = int(url.rsplit("/", 1)[1])
        return 200, json.dumps({
            "id": bid, "title": f"Book {bid}", "subtitle": None, "authors": [],
            "providerIds": {}, "tags": [], "isbn13": None, "isbn10": None,
            "libraryName": "Library", "seriesName": None, "seriesIndex": None,
            "publishedYear": None, "readAloudSync": {"state": "unavailable"},
            "folderPath": f"/books/Library/x/{bid}", "files": [], "updatedAt": "t",
        })

    c = BookorbitClient("http://b/api/v1", "u", "p", transport=t,
                        cookie_path=str(tmp_path / "c.txt"))
    c.authenticate()
    idx = LibraryIndex(c, state_path=str(tmp_path / "idx.json"))
    idx.refresh(now=0, force=True)

    query_calls = [u for _, u in calls if u.endswith("/books/query")]
    assert len(query_calls) == 3   # pages 0, 1, 2 (100 + 100 + 50), then stop
    assert len(idx.books()) == 250
    assert {int(b["id"]) for b in idx.books()} == set(ids)

# Second book with a title-key overlap but no author-surname overlap, used to
# exercise the controller ruling: a title-only (score 20) match is dropped
# from the result set whenever a stronger (>=60) match is also present, but
# kept when it is the only match.
THRAWN_ALLIANCES = {
    "id": 3, "title": "Thrawn: Alliances", "subtitle": None,
    "authors": [{"id": 9, "name": "John Doe", "sortName": "Doe, John"}],
    "providerIds": {"audible": None}, "tags": [], "isbn13": None, "isbn10": None,
    "libraryName": "Library", "seriesName": None, "seriesIndex": None,
    "publishedYear": None, "readAloudSync": {"state": "unavailable"},
    "folderPath": "/books/Library/John Doe/Thrawn Alliances",
    "files": [], "updatedAt": "t3",
}

def test_title_only_match_suppressed_when_better_match_present(tmp_path):
    books = {1: BOOKS[1], 3: THRAWN_ALLIANCES}
    idx = make(tmp_path, [], books=books)
    idx.refresh(now=0, force=True)
    results = idx.candidates(titles=["Thrawn"], authors=["Timothy Zahn"])
    ids = [d["id"] for d, _ in results]
    assert ids == [1]   # book 1 scores 60 (title+surname); book 3's 20 is dropped

def test_title_only_match_kept_when_nothing_better(tmp_path):
    books = {3: THRAWN_ALLIANCES}
    idx = make(tmp_path, [], books=books)
    idx.refresh(now=0, force=True)
    results = idx.candidates(titles=["Thrawn"], authors=["Timothy Zahn"])
    ids = [d["id"] for d, _ in results]
    assert ids == [3]   # only a title-only (20) match exists -- kept


def test_candidates_match_real_title_in_file_name_of_placeholder_book(tmp_path):
    books = {
        5: {"id": 5, "title": "New James S. A. Corey Novella #1", "subtitle": None,
            "authors": [{"id": 5, "name": "James S. A. Corey", "sortName": "Corey, James S. A."}],
            "providerIds": {}, "tags": [], "isbn13": None, "isbn10": None,
            "libraryName": "Library", "seriesName": None, "seriesIndex": None,
            "publishedYear": 2022, "readAloudSync": {"state": "unavailable"},
            "folderPath": "/books/Library/James S. A. Corey/New James S. A. Corey Novella #1",
            "files": [{"format": "epub", "filename": "The Sins of Our Fathers (The Expanse) (2022).epub",
                       "sizeBytes": 10}],
            "updatedAt": "t5"},
    }
    idx = make(tmp_path, [], books=books); idx.refresh(now=0, force=True)
    top, reasons = idx.candidates(titles=["The Sins of Our Fathers"], authors=["James S. A. Corey"])[0]
    assert top["id"] == 5
    assert "title-key:sins of our fathers" in reasons and "surname:corey" in reasons
    # search_books passes only the query as a title: still found (title-only score)
    assert [d["id"] for d, _ in idx.candidates(titles=["Sins of Our Fathers"])] == [5]


def test_file_name_index_prefix_is_stripped_for_title_keys(tmp_path):
    idx = make(tmp_path, []); idx.refresh(now=0, force=True)
    # book 1's file is "1. Thrawn.epub" -- the "1. " rename prefix must not
    # stop the file name contributing the key "thrawn"
    from app.bookorbit import _file_title_keys
    assert "thrawn" in _file_title_keys(idx.book(1))
