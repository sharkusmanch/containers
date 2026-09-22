import json
from app.bookorbit import BookorbitClient, LibraryIndex

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

def fake_transport(calls):
    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if url.endswith("/books/query"):
            page = json.loads(body)["pagination"]["page"]
            items = [{"id": i, "updatedAt": b["updatedAt"]} for i, b in BOOKS.items()] if page == 0 else []
            return 200, json.dumps({"items": items, "total": 2, "page": page, "size": 100})
        bid = int(url.rsplit("/", 1)[1])
        return 200, json.dumps(BOOKS[bid])
    return t

def make(tmp_path, calls):
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=fake_transport(calls),
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
