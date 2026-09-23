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
    assert "file-key:sins of our fathers" in reasons and "surname:corey" in reasons
    # search_books passes only the query as a title: still found (title-only score)
    assert [d["id"] for d, _ in idx.candidates(titles=["Sins of Our Fathers"])] == [5]


def test_file_name_index_prefix_is_stripped_for_title_keys(tmp_path):
    idx = make(tmp_path, []); idx.refresh(now=0, force=True)
    # book 1's file is "1. Thrawn.epub" -- the "1. " rename prefix must not
    # stop the file name contributing the key "thrawn"
    from app.bookorbit import _file_title_keys
    assert "thrawn" in _file_title_keys(idx.book(1))


def test_generic_file_key_with_other_author_stays_title_only_and_is_suppressed(tmp_path):
    books = dict(BOOKS)
    books[6] = {"id": 6, "title": "Some Other Book", "subtitle": None,
                "authors": [{"id": 6, "name": "Jane Doe", "sortName": "Doe, Jane"}],
                "providerIds": {}, "tags": [], "isbn13": None, "isbn10": None,
                "libraryName": "Library", "seriesName": None, "seriesIndex": None,
                "publishedYear": 2001, "readAloudSync": {"state": "unavailable"},
                "folderPath": "/books/Library/Jane Doe/Some Other Book",
                "files": [{"format": "m4b", "filename": "Part 01.m4b", "sizeBytes": 5}],
                "updatedAt": "t6"}
    idx = make(tmp_path, [], books=books); idx.refresh(now=0, force=True)
    # alone, the generic file key only earns a title-only (score 20) match
    only = idx.candidates(titles=["Part 01"], authors=["Timothy Zahn"])
    assert [(d["id"], r) for d, r in only] == [(6, ["file-key:part 01"])]
    # with a real title+surname match present it is suppressed entirely
    ids = [d["id"] for d, _ in idx.candidates(titles=["Part 01", "Thrawn"], authors=["Timothy Zahn"])]
    assert ids == [1]


# --- final review I5: login cooldown after a failed login ---------------------

import pytest  # noqa: E402

from app import bookorbit as bookorbit_mod  # noqa: E402


class _Clock:
    def __init__(self, t=10_000.0):
        self.t = t

    def __call__(self):
        return self.t


def _failing_login_transport(calls, fail=lambda: True):
    ok = fake_transport([])

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login") and fail():
            return 429, "too many requests"
        if url.endswith("/auth/refresh"):
            return 401, "expired"
        return ok(method, url, body, headers)
    return t


def _logins(calls):
    return sum(1 for _m, u in calls if u.endswith("/auth/login"))


def test_failed_login_is_not_retried_within_cooldown(tmp_path):
    calls, clock = [], _Clock()
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=_failing_login_transport(calls),
                        cookie_path=str(tmp_path / "c.txt"), clock=clock)
    with pytest.raises(RuntimeError):
        c.authenticate()
    assert _logins(calls) == 1
    for _ in range(5):
        clock.t += 30
        with pytest.raises(RuntimeError, match="cooldown"):
            c.authenticate()
    assert _logins(calls) == 1
    clock.t = 10_000.0 + bookorbit_mod.AUTH_RETRY_SECONDS
    with pytest.raises(RuntimeError):
        c.authenticate()
    assert _logins(calls) == 2


def test_requests_with_stale_token_do_not_relogin_during_cooldown(tmp_path):
    calls, clock = [], _Clock()
    state = {"fail": False}
    c = BookorbitClient("http://b/api/v1", "u", "p",
                        transport=_failing_login_transport(calls, fail=lambda: state["fail"]),
                        cookie_path=str(tmp_path / "c.txt"), clock=clock)
    c.authenticate()
    assert _logins(calls) == 1
    state["fail"] = True
    clock.t += bookorbit_mod.RELOGIN_AFTER_SECONDS            # token is now stale
    with pytest.raises(RuntimeError):
        c.get("/books/1")                                     # refresh+login both fail
    assert _logins(calls) == 2
    for _ in range(10):
        with pytest.raises(RuntimeError, match="cooldown"):
            c.get("/books/1")
    assert _logins(calls) == 2
    state["fail"] = False
    clock.t += bookorbit_mod.AUTH_RETRY_SECONDS
    assert c.get("/books/1")["id"] == 1
    assert _logins(calls) == 3


# --- Plan 2 Task 1: BookorbitWriter + BookorbitClient._write allowlist ------

from app.bookorbit import BookorbitHTTPError, BookorbitWriter, ScanError  # noqa: E402


def _history_entry(id, status, error=None):
    return {
        "id": id, "status": status, "triggeredBy": "manual",
        "startedAt": "s", "completedAt": "e" if status != "running" else None,
        "addedCount": 0, "updatedCount": 0, "missingCount": 0,
        "errorMessage": error,
    }


def _writer(tmp_path, transport):
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=transport,
                        cookie_path=str(tmp_path / "c.txt"), writable=True)
    c.authenticate()
    return c, BookorbitWriter(c)


def test_write_rejects_unallowlisted_paths(tmp_path):
    c, _w = _writer(tmp_path, fake_transport([]))
    for method, path in [
        ("POST", "/books/1/refresh-metadata"),   # explicitly forbidden by global constraints
        ("DELETE", "/books/1"),
        ("PATCH", "/books/1"),
        ("PATCH", "/books/abc/metadata-and-locks"),   # not a valid id
        ("POST", "/scanner/libraries/9/scan"),   # not library 7 or 8
        ("GET", "/scanner/libraries/7/scan"),    # right path, wrong verb
        # --- fix round 1 #5: fullmatch + [0-9]+ closes these off ---------
        ("POST", "/books/1/rename-files/extra"),      # trailing segment
        ("POST", "/books/1/rename-files?x=1"),         # query string
        ("POST", "/books/1/rename-files/"),             # trailing slash
        ("POST", "/books/1/rename-files\n"),             # trailing newline
        ("POST", "/books/１/rename-files"),           # unicode digit (fullwidth 1)
    ]:
        with pytest.raises(PermissionError):
            c._write(method, path, {})


def test_write_rejects_when_client_not_constructed_writable(tmp_path):
    # fix round 1 #6: writable=False (the default) refuses even an
    # otherwise-allowlisted path -- this is the P1 read-only client's shape.
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=fake_transport([]),
                        cookie_path=str(tmp_path / "c.txt"))
    c.authenticate()
    assert c.writable is False
    with pytest.raises(PermissionError):
        c._write("POST", "/books/1/rename-files", {})


def test_writer_requires_writable_client(tmp_path):
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=fake_transport([]),
                        cookie_path=str(tmp_path / "c.txt"))
    c.authenticate()
    with pytest.raises(ValueError):
        BookorbitWriter(c)


def test_writer_rejects_invalid_library_id(tmp_path):
    _c, w = _writer(tmp_path, fake_transport([]))
    with pytest.raises(ValueError):
        w.scan(9)
    with pytest.raises(ValueError):
        w.scan_running(9)
    with pytest.raises(ValueError):
        w.wait_scan(9, after_id=0)


def test_scan_running_reflects_latest_history_entry(tmp_path):
    def make_transport(status):
        def t(method, url, body, headers):
            if url.endswith("/auth/login"):
                return 200, json.dumps({"accessToken": "tok"})
            if "/scan-history" in url:
                return 200, json.dumps([_history_entry(5, status)])
            raise AssertionError((method, url))
        return t

    _c, w = _writer(tmp_path, make_transport("running"))
    assert w.scan_running(7) is True
    _c2, w2 = _writer(tmp_path, make_transport("completed"))
    assert w2.scan_running(7) is False


def test_scan_when_idle_returns_max_id_and_triggers(tmp_path):
    calls = []

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(4, "completed"), _history_entry(3, "failed")])
        if url.endswith("/scanner/libraries/7/scan"):
            return 200, json.dumps({})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    max_id = w.scan(7)
    assert max_id == 4
    assert ("POST", "http://b/api/v1/scanner/libraries/7/scan") in calls


def test_scan_waits_for_already_running_scan_then_triggers(tmp_path):
    """`scan_running()` catches the already-running scan up front (no 409
    needed): scan() must poll until it finishes, THEN record the max id and
    trigger its own scan."""
    history_calls = {"n": 0}
    scan_posts = {"n": 0}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            history_calls["n"] += 1
            status = "completed" if history_calls["n"] >= 3 else "running"
            return 200, json.dumps([_history_entry(5, status)])
        if url.endswith("/scanner/libraries/7/scan"):
            scan_posts["n"] += 1
            return 200, json.dumps({})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    sleeps = []
    max_id = w.scan(7, sleep=sleeps.append, clock=lambda: 0.0)
    assert max_id == 5              # recorded AFTER the running scan finished
    assert scan_posts["n"] == 1     # triggered exactly once -- no 409 involved
    assert len(sleeps) >= 1         # it actually waited


def test_scan_409_race_waits_then_retries(tmp_path):
    """scan_running() reports idle (a race: the scan started between our
    check and our POST), the trigger 409s, so scan() must wait it out and
    retry rather than raising."""
    history_calls = {"n": 0}
    scan_posts = {"n": 0}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            history_calls["n"] += 1
            # call 1: scan_running() check -> idle. call 2: max_id before
            # first trigger attempt -> still idle (race not yet visible).
            # calls 3-4: _wait_until_idle polling -> running, then completed.
            if history_calls["n"] <= 2:
                return 200, json.dumps([_history_entry(4, "completed")])
            status = "completed" if history_calls["n"] >= 4 else "running"
            return 200, json.dumps([_history_entry(4, "completed"), _history_entry(5, status)])
        if url.endswith("/scanner/libraries/7/scan"):
            scan_posts["n"] += 1
            if scan_posts["n"] == 1:
                return 409, "already running"
            return 200, json.dumps({})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    sleeps = []
    max_id = w.scan(7, sleep=sleeps.append, clock=lambda: 0.0)
    assert max_id == 5              # max id after the raced scan finished
    assert scan_posts["n"] == 2     # first attempt 409'd, second succeeded
    assert len(sleeps) >= 1


def test_scan_times_out_waiting_for_existing_scan(tmp_path):
    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(5, "running")])   # never finishes
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    clock_state = {"t": 0.0}

    def clock():
        clock_state["t"] += 700  # two ticks exceeds a 1200s timeout
        return clock_state["t"]

    with pytest.raises(ScanError) as exc_info:
        w.scan(7, timeout=1200, sleep=lambda s: None, clock=clock)
    assert exc_info.value.kind == "timeout"


def test_scan_non_409_error_from_trigger_is_reraised(tmp_path):
    """fix round 1 #9: a non-409 4xx from the scan POST must propagate as
    BookorbitHTTPError, not get swallowed or turned into a ScanError."""
    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(4, "completed")])
        if url.endswith("/scanner/libraries/7/scan"):
            return 403, "forbidden"
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(BookorbitHTTPError) as exc_info:
        w.scan(7)
    assert exc_info.value.status == 403


def test_scan_second_409_on_retry_raises_scan_error(tmp_path):
    """fix round 1 #4: if the retry POST (after waiting out the first
    running scan) ALSO 409s, that's not something scan() can recover from
    by retrying again -- it must surface as ScanError, not a raw
    BookorbitHTTPError."""
    scan_posts = {"n": 0}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            # never reports "running" -- the 409s below are the only signal
            # that something is scanning, simulating server-side flakiness
            # rather than a wait-observable running scan.
            return 200, json.dumps([_history_entry(4, "completed")])
        if url.endswith("/scanner/libraries/7/scan"):
            scan_posts["n"] += 1
            return 409, "already running"
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(ScanError) as exc_info:
        w.scan(7, sleep=lambda s: None, clock=lambda: 0.0)
    assert exc_info.value.kind == "failed"
    assert scan_posts["n"] == 2   # both the initial attempt and the retry


def test_scan_shares_one_deadline_across_both_waits(tmp_path):
    """fix round 1 #3 regression test: previously each _wait_until_idle call
    computed its own `clock() + timeout` deadline, so a proactive wait
    followed by a raced second wait could together wait up to 2x `timeout`.
    With a single deadline shared across both waits, once the shared
    deadline has already passed, the second wait must time out immediately
    rather than granting itself a fresh `timeout` budget.

    Both the clock and scan-history responses are finite iterators (not
    infinite generators) so that a regression which consumes more calls
    than expected fails loudly (StopIteration) instead of hanging."""
    history_responses = iter(["running", "running", "completed", "completed", "running"])
    clock_values = iter([0, 10, 35])   # deadline anchor, 1st wait check, 2nd wait check
    scan_posts = {"n": 0}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(5, next(history_responses))])
        if url.endswith("/scanner/libraries/7/scan"):
            scan_posts["n"] += 1
            return 409, "already running"   # every trigger attempt races
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(ScanError) as exc_info:
        w.scan(7, timeout=30, sleep=lambda s: None, clock=lambda: next(clock_values))
    assert exc_info.value.kind == "timeout"
    # the first attempt 409'd (reactively racing scan_running()'s "idle"
    # read); the second wait timed out on the SHARED deadline before any
    # retry POST was attempted
    assert scan_posts["n"] == 1


def test_wait_scan_picks_first_entry_with_id_greater_than_after_id(tmp_path):
    history_calls = {"n": 0}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            history_calls["n"] += 1
            if history_calls["n"] == 1:
                # not there yet
                return 200, json.dumps([_history_entry(4, "completed")])
            # newest-first; two entries qualify (id > 4 and terminal) -- the
            # "first" one is the smaller id (5), not the newest (7).
            return 200, json.dumps([
                _history_entry(7, "completed"),
                _history_entry(6, "running"),
                _history_entry(5, "completed"),
                _history_entry(4, "completed"),
            ])
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    sleeps = []
    entry = w.wait_scan(7, after_id=4, sleep=sleeps.append, clock=lambda: 0.0)
    assert entry["id"] == 5
    assert len(sleeps) == 1


def test_wait_scan_raises_scan_error_on_failed_status(tmp_path):
    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(5, "failed", error="disk full")])
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(ScanError, match="disk full"):
        w.wait_scan(7, after_id=4, sleep=lambda s: None, clock=lambda: 0.0)


def test_wait_scan_times_out(tmp_path):
    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if "/scan-history" in url:
            return 200, json.dumps([_history_entry(5, "running")])
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    clock_state = {"t": 0.0}

    def clock():
        clock_state["t"] += 6
        return clock_state["t"]

    with pytest.raises(ScanError):
        w.wait_scan(7, after_id=4, timeout=10, sleep=lambda s: None, clock=clock)


def test_rename_files_calls_allowlisted_endpoint(tmp_path):
    calls = []

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if url.endswith("/books/3/rename-files"):
            return 200, json.dumps({"ok": True})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    result = w.rename_files(3)
    assert result == {"ok": True}
    assert ("POST", "http://b/api/v1/books/3/rename-files") in calls


def test_patch_metadata_merges_locked_fields_as_union(tmp_path):
    sent = {}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if method == "GET" and url.endswith("/books/4"):
            return 200, json.dumps({"id": 4, "lockedFields": ["authors", "tags"]})
        if method == "PATCH" and url.endswith("/books/4/metadata-and-locks"):
            sent["payload"] = json.loads(body)
            return 200, json.dumps({"id": 4})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    result = w.patch_metadata(4, {"title": "New Title"}, ["title"])
    assert result == {"id": 4}
    assert sent["payload"]["metadata"] == {"title": "New Title"}
    assert set(sent["payload"]["lockedFields"]) == {"authors", "tags", "title"}


def test_patch_metadata_never_drops_an_existing_lock_not_in_the_new_request(tmp_path):
    sent = {}

    def t(method, url, body, headers):
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if method == "GET" and url.endswith("/books/9"):
            return 200, json.dumps({"id": 9, "lockedFields": ["tags"]})
        if method == "PATCH" and url.endswith("/books/9/metadata-and-locks"):
            sent["payload"] = json.loads(body)
            return 200, json.dumps({"id": 9})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    w.patch_metadata(9, {"subtitle": "Sub"}, ["subtitle"])
    assert "tags" in sent["payload"]["lockedFields"]


def test_patch_metadata_refuses_when_locked_fields_missing_sends_no_patch(tmp_path):
    """fix round 1 Important #1: a GET with no lockedFields key at all must
    not be treated as an empty list -- that would replace-and-drop every
    existing lock. No PATCH may be sent."""
    calls = []

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if method == "GET" and url.endswith("/books/4"):
            return 200, json.dumps({"id": 4})   # no lockedFields key
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(RuntimeError):
        w.patch_metadata(4, {"title": "New Title"}, ["title"])
    assert not any(m == "PATCH" for m, _u in calls)


def test_patch_metadata_refuses_when_locked_fields_is_null_sends_no_patch(tmp_path):
    calls = []

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if method == "GET" and url.endswith("/books/4"):
            return 200, json.dumps({"id": 4, "lockedFields": None})
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(RuntimeError):
        w.patch_metadata(4, {"title": "New Title"}, ["title"])
    assert not any(m == "PATCH" for m, _u in calls)


def test_patch_metadata_sends_no_patch_when_get_fails(tmp_path):
    calls = []

    def t(method, url, body, headers):
        calls.append((method, url))
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        if method == "GET" and url.endswith("/books/4"):
            return 500, "boom"
        raise AssertionError((method, url))

    _c, w = _writer(tmp_path, t)
    with pytest.raises(RuntimeError):
        w.patch_metadata(4, {"title": "New Title"}, ["title"])
    assert not any(m == "PATCH" for m, _u in calls)


def test_rename_files_rejects_non_int_book_id(tmp_path):
    _c, w = _writer(tmp_path, fake_transport([]))
    with pytest.raises(TypeError):
        w.rename_files("3")
    with pytest.raises(TypeError):
        w.rename_files(True)   # bool is an int subclass -- must still be rejected


def test_patch_metadata_rejects_non_int_book_id(tmp_path):
    _c, w = _writer(tmp_path, fake_transport([]))
    with pytest.raises(TypeError):
        w.patch_metadata("4", {"title": "x"}, ["title"])


def test_scan_history_requests_the_larger_page(tmp_path):
    """Task 9c (e): the default page is only 5 entries (BookOrbit
    scanner.controller DefaultValuePipe(5)); ask for more -- the server
    clamps to its SCAN_HISTORY_LIMIT (10 in 3.0.0)."""
    urls = []

    def t(method, url, body, headers):
        urls.append(url)
        if url.endswith("/auth/login"):
            return 200, json.dumps({"accessToken": "tok"})
        return 200, json.dumps([_history_entry(5, "completed")])

    _c, w = _writer(tmp_path, t)
    w.scan_running(7)
    assert urls[-1] == "http://b/api/v1/scanner/libraries/7/scan-history?limit=20"
