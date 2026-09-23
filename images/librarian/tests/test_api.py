"""Tests for the internal loopback API (app/api.py).

Uses a FakeCore that satisfies the Global `Core` protocol with real
`Store`/`IntentBook` instances (in tmp_path) and a real `LibraryIndex` built
against a fake HTTP transport -- the same pattern `tests/test_bookorbit.py`
uses for its own `BookorbitClient` -- so the guard behaviour exercised here
(app.policy.check_intent via IntentBook.submit) is the real thing, not a
mock.
"""
import http.client
import json
import logging
import os
import socket
import threading

import pytest

from app.api import ApiServer
from app.bookorbit import BookorbitClient, LibraryIndex
from app.intents import IntentBook
from app.policy import GuardContext, KidsLists
from app.states import ARRIVAL_STATES, INTENT_STATES, PROPOSED_I, Run
from app.store import Store
from tests.fixtures import make_epub
from tests.test_bookorbit import fake_transport

# --- fixture library -----------------------------------------------------

BOOKS = {
    2: {
        "id": 2, "title": "Book Two", "subtitle": None,
        "authors": [{"id": 1, "name": "Author Two", "sortName": "Two, Author"}],
        "providerIds": {"audible": None}, "tags": [], "isbn13": None, "isbn10": None,
        "libraryName": "Library", "seriesName": None, "seriesIndex": None,
        "publishedYear": 2020, "readAloudSync": {"state": "unavailable"},
        "folderPath": "/books/Library/Author Two/Book Two",
        "files": [{"format": "m4b", "filename": "book2.m4b", "sizeBytes": 5, "durationSeconds": 100}],
        "updatedAt": "t2",
    },
    5: {
        "id": 5, "title": "Book Five", "subtitle": None,
        "authors": [{"id": 2, "name": "Author Five", "sortName": "Five, Author"}],
        "providerIds": {"audible": None}, "tags": [], "isbn13": None, "isbn10": None,
        "libraryName": "Library", "seriesName": None, "seriesIndex": None,
        "publishedYear": 2021, "readAloudSync": {"state": "unavailable"},
        "folderPath": "/books/Library/Author Five/Book Five",
        "files": [], "updatedAt": "t5",
    },
    3: {
        "id": 3, "title": "Book Three", "subtitle": None,
        "authors": [{"id": 3, "name": "Author Three", "sortName": "Three, Author"}],
        "providerIds": {"audible": None}, "tags": [], "isbn13": None, "isbn10": None,
        "libraryName": "Library", "seriesName": None, "seriesIndex": None,
        "publishedYear": 2019, "readAloudSync": {"state": "unavailable"},
        "folderPath": "/books/Library/Author Three/Book Three",
        "files": [
            {"format": "epub", "filename": "book3.epub", "sizeBytes": 1000,
             "absolutePath": "/books/Library/Author Three/Book Three/book3.epub"},
            {"format": "epub", "filename": "book3 (readaloud).epub", "sizeBytes": 900,
             "absolutePath": "/books/Library/Author Three/Book Three/book3 (readaloud).epub"},
        ],
        "updatedAt": "t3",
    },
    6: {
        "id": 6, "title": "Book Six", "subtitle": None,
        "authors": [{"id": 4, "name": "Author Six", "sortName": "Six, Author"}],
        "providerIds": {"audible": None}, "tags": [], "isbn13": None, "isbn10": None,
        "libraryName": "Library", "seriesName": None, "seriesIndex": None,
        "publishedYear": 2018, "readAloudSync": {"state": "unavailable"},
        "folderPath": "/books/Library/Author Six/Book Six",
        "files": [
            {"format": "epub", "filename": "escape.epub", "sizeBytes": 10,
             "absolutePath": "/books/../../etc/escape.epub"},
        ],
        "updatedAt": "t6",
    },
}


class FakeCore:
    def __init__(self, tmp_path, run, books=BOOKS):
        self.lock = threading.Lock()
        self._run = run
        self.arrivals = Store(str(tmp_path / "arrivals.jsonl"), "key", ARRIVAL_STATES)
        intents_store = Store(str(tmp_path / "intents.jsonl"), "intent_id", INTENT_STATES)
        self.intents = IntentBook(intents_store, self.arrivals, self.lock)
        self.lists = KidsLists.load(str(tmp_path / "nonexistent-lists"))

        client = BookorbitClient(
            "http://b/api/v1", "u", "p",
            transport=fake_transport([], books=books),
            cookie_path=str(tmp_path / "cookies.txt"),
        )
        client.authenticate()
        self.index = LibraryIndex(
            client, state_path=str(tmp_path / "idx.json"),
            local_root=str(tmp_path / "media" / "books"),
        )
        self.index.refresh(now=0, force=True)

        self._dossiers: dict[str, dict] = {}

    def current_run(self):
        return self._run

    def load_dossier(self, key):
        return self._dossiers.get(key)


class ClosingCoreProxy:
    """Wraps an existing `FakeCore`, delegating everything except
    `current_run()`, which returns `open_run` for the first `close_after`
    calls and `closed_run` (default `None`) after that -- simulates the
    service closing/replacing a run between a request's auth check and the
    locked section that later acts on it (fix round 1, I1)."""

    def __init__(self, inner, open_run, close_after=1, closed_run=None):
        self._inner = inner
        self._open_run = open_run
        self._close_after = close_after
        self._closed_run = closed_run
        self.calls = 0

    def current_run(self):
        self.calls += 1
        return self._open_run if self.calls <= self._close_after else self._closed_run

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _BoomArrivals:
    """A `Store`-shaped stand-in whose `.get` always raises -- used to
    exercise the generic internal-error path (fix round 1, M3)."""

    def get(self, key):
        raise RuntimeError("boom")


def make_dossier(key, primary_kind="epub", candidates=()):
    return {
        "key": key,
        "source_id": None,
        "trusted": {
            "files": [{"name_hash": "h1", "kind": primary_kind, "size": 1, "primary": True}],
            "measures": [],
            "kids": {"allow": [], "deny": []},
            "arrival_series_index": None,
        },
        "untrusted": {"files": [], "epub": None, "sidecar": None, "folder_name": "x", "kids_inputs": {}},
        "candidates": [{"reasons": [], "book": {"id": cid}} for cid in candidates],
    }


def attach_intent(arrival, book_id, reason="matches"):
    return {"kind": "attach", "arrival": arrival, "book_id": book_id, "reason": reason}


def direct_ctx_factory(core, run):
    """A `ctx_factory` for calling `IntentBook.submit` directly (bypassing
    the HTTP layer) when a test needs to seed a proposal before the API
    server it's testing is even the thing under test for that call."""
    def factory(key):
        return GuardContext(
            dossier=core._dossiers[key],
            index=core.index,
            seen_ids=run.seen_ids.get(key, set()),
            run_claims=run.claims,
            lists=core.lists,
            human_answer=None,
        )
    return factory


@pytest.fixture
def epub_root(tmp_path):
    d = tmp_path / "media" / "books" / "Library" / "Author Three" / "Book Three"
    os.makedirs(d, exist_ok=True)
    make_epub(str(d / "book3.epub"), "Book Three", ["Author Three"], "the dragon flew over the mountain")
    return tmp_path


def start(core, port=0):
    srv = ApiServer(core, port=port)
    bound_port = srv.start()
    return srv, bound_port


def request(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
    finally:
        conn.close()
    parsed = json.loads(data) if data else None
    return resp.status, parsed


def raw_request(port, raw: bytes) -> bytes:
    """Send exactly `raw` over a fresh socket and read until the server
    closes the connection. For exercising request shapes `http.client`
    won't let us construct (a malformed request line, a negative or
    non-numeric Content-Length, a bare Transfer-Encoding header)."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(raw)
        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
    return b"".join(chunks)


def status_of(raw_response: bytes) -> int:
    return int(raw_response.split(b"\r\n", 1)[0].split(b" ")[1])


def json_body_of(raw_response: bytes) -> dict:
    _headers, _, body = raw_response.partition(b"\r\n\r\n")
    return json.loads(body)


# --- auth ------------------------------------------------------------------


def test_no_token_is_401(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/arrivals")
        assert status == 401
        assert payload["error"] == "unauthorized"
    finally:
        srv.stop()


def test_wrong_token_is_401(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/arrivals", token="nope")
        assert status == 401
    finally:
        srv.stop()


def test_no_open_run_is_401(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core._run = None
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/arrivals", token="tok")
        assert status == 401
    finally:
        srv.stop()


def test_server_binds_loopback_only(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=[])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        assert srv.bound_host == "127.0.0.1"
        assert port != 0
    finally:
        srv.stop()


def test_non_loopback_host_rejected(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=[])
    core = FakeCore(tmp_path, run)
    with pytest.raises(ValueError):
        ApiServer(core, host="0.0.0.0")


# --- mode gating -------------------------------------------------------------


def test_reviewer_cannot_post_intents(tmp_path):
    run = Run(run_id="r1", token="tok", mode="reviewer", arrival_keys=[], review_of="lib1")
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body=attach_intent("a1", 2))
        assert status == 403
        assert payload["error"] == "forbidden"
    finally:
        srv.stop()


def test_librarian_cannot_get_proposals(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/proposals", token="tok")
        assert status == 403
    finally:
        srv.stop()


def test_librarian_cannot_post_reviews(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "POST", "/reviews", token="tok",
                                    body={"intent_id": "x:1", "verdict": "approve", "argument": "ok"})
        assert status == 403
    finally:
        srv.stop()


# --- GET /arrivals -----------------------------------------------------------


def test_get_arrivals_lists_only_runs_keys(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core.arrivals.record("a1", "ready", title_hint="Thrawn")
    core.arrivals.record("other", "ready", title_hint="Not Mine")
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/arrivals", token="tok")
        assert status == 200
        # Controller ruling: every file/tag-derived string lives under
        # "untrusted" -- title_hint is intake-derived text.
        assert payload == [{"key": "a1", "state": "ready", "untrusted": {"title_hint": "Thrawn"}}]
    finally:
        srv.stop()


def test_get_arrivals_reviewer_mode_lists_proposal_arrivals(tmp_path):
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, lib_run)
    core.arrivals.record("a1", "ready", title_hint="Thrawn")
    core._dossiers["a1"] = make_dossier("a1", candidates=[2])
    submitted = core.intents.submit(lib_run, attach_intent("a1", 2), direct_ctx_factory(core, lib_run))
    assert submitted["status"] == PROPOSED_I

    reviewer_run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
    core._run = reviewer_run
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/arrivals", token="revtok")
        assert status == 200
        # `submit` already moved the arrival to "proposed" -- see app/intents.py
        assert payload == [{"key": "a1", "state": "proposed", "untrusted": {"title_hint": "Thrawn"}}]
    finally:
        srv.stop()


# --- GET /arrivals/{key} -----------------------------------------------------


def test_get_arrival_returns_dossier_history_and_records_seen_ids(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core.arrivals.record("a1", "ready", title_hint="Thrawn")
    core.arrivals.record("a1", "answered", human_answer={"choice": "adult"})
    core._dossiers["a1"] = make_dossier("a1", candidates=[2, 5])
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/arrivals/a1", token="tok")
        assert status == 200
        assert payload["dossier"]["key"] == "a1"
        # Controller ruling: history is file/tag-derived and human_answer is
        # the user's own text -- both live under "untrusted", not top-level.
        assert payload["untrusted"]["human_answer"] == {"choice": "adult"}
        assert len(payload["untrusted"]["history"]) == 2
        assert payload["untrusted"]["history"][-1]["state"] == "answered"
        assert run.seen_ids["a1"] == {2, 5}
    finally:
        srv.stop()


def test_get_arrival_outside_run_keys_is_403(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/arrivals/not-mine", token="tok")
        assert status == 403
        assert payload["error"] == "forbidden"
    finally:
        srv.stop()


def test_get_arrival_missing_dossier_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/arrivals/a1", token="tok")
        assert status == 404
    finally:
        srv.stop()


def test_arrival_key_with_colon_and_slash_is_url_quoted(tmp_path):
    key = "manual:foo/bar baz"
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=[key])
    core = FakeCore(tmp_path, run)
    core._dossiers[key] = make_dossier(key)
    from urllib.parse import quote
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", f"/arrivals/{quote(key, safe='')}", token="tok")
        assert status == 200
        assert payload["dossier"]["key"] == key
    finally:
        srv.stop()


# --- GET /books/search --------------------------------------------------------


def test_books_search_records_seen_ids_and_requires_visible_arrival(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/search?q=Book+Two&arrival=a1", token="tok")
        assert status == 200
        assert any(b["id"] == 2 for b in payload)
        assert 2 in run.seen_ids["a1"]

        status, payload = request(port, "GET", "/books/search?q=x&arrival=not-mine", token="tok")
        assert status == 403
    finally:
        srv.stop()


def test_books_search_missing_arrival_is_400(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/books/search?q=x", token="tok")
        assert status == 400
    finally:
        srv.stop()


# --- GET /books/{id} ----------------------------------------------------------


def test_get_book_by_id_records_seen_id(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/2?arrival=a1", token="tok")
        assert status == 200
        assert payload["id"] == 2
        assert run.seen_ids["a1"] == {2}
    finally:
        srv.stop()


def test_get_book_not_found_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/books/999?arrival=a1", token="tok")
        assert status == 404
    finally:
        srv.stop()


# --- guard 1 integration: seen id passes, unseen id fails -------------------


def test_attach_to_seen_id_passes_guard_unseen_id_fails(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[])
    srv, port = start(core)
    try:
        # 1) surface book 2 to this run via GET /books/2?arrival=a1
        status, _ = request(port, "GET", "/books/2?arrival=a1", token="tok")
        assert status == 200

        # 2) attach to book 5 -- never surfaced, never a candidate -- fails guard 1
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body=attach_intent("a1", 5))
        assert status == 200
        assert payload["status"] == "guard-rejected"
        assert "not a candidate" in payload["reason"] or "not found" in payload["reason"]

        # 3) attach to book 2 -- seen this run -- passes guard 1 and is accepted
        #    (the guard-rejected attempt above must NOT have claimed the arrival)
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body=attach_intent("a1", 2))
        assert status == 200
        assert payload["status"] == PROPOSED_I
    finally:
        srv.stop()


def test_post_intent_missing_dossier_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "POST", "/intents", token="tok",
                                    body=attach_intent("a1", 2))
        assert status == 404
    finally:
        srv.stop()


def test_post_intent_arrival_outside_run_is_403(tmp_path):
    """Fix round 1, C1: a run with arrival_keys=["a1"] must not be able to
    file an intent against an unrelated arrival "b8" just by naming it in
    the body -- previously nothing checked intent["arrival"] against the
    run's visible arrivals at all, so this posted 200 proposed and moved
    "b8"'s state despite the run never having been handed that key."""
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core._dossiers["b8"] = make_dossier("b8", primary_kind="epub", candidates=[2])
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body=attach_intent("b8", 2))
        assert status == 403
        assert payload["error"] == "forbidden"
        # must not have been recorded or moved at all
        assert core.arrivals.get("b8") is None
        assert core.intents.store.all() == []
    finally:
        srv.stop()


def test_post_intent_missing_arrival_field_is_403(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body={"kind": "attach", "book_id": 2, "reason": "x"})
        assert status == 403
        assert payload["error"] == "forbidden"
    finally:
        srv.stop()


# --- GET /proposals + POST /reviews ------------------------------------------


def _submit_via_api(port, token, arrival, book_id):
    return request(port, "POST", "/intents", token=token, body=attach_intent(arrival, book_id))


def test_proposals_and_review_flow_and_double_review_is_409(tmp_path):
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, lib_run)
    core._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    srv, port = start(core)
    try:
        status, submitted = _submit_via_api(port, "libtok", "a1", 2)
        assert status == 200 and submitted["status"] == PROPOSED_I
        intent_id = submitted["intent_id"]

        reviewer_run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
        core._run = reviewer_run

        status, proposals = request(port, "GET", "/proposals", token="revtok")
        assert status == 200
        assert len(proposals) == 1
        assert proposals[0]["arrival"] == "a1"

        status, result = request(port, "POST", "/reviews", token="revtok",
                                  body={"intent_id": intent_id, "verdict": "approve", "argument": "looks right"})
        assert status == 200
        assert result["status"] == "approved"

        status, result = request(port, "POST", "/reviews", token="revtok",
                                  body={"intent_id": intent_id, "verdict": "approve", "argument": "again"})
        assert status == 409
        assert result["error"] == "conflict"
    finally:
        srv.stop()


def test_review_unknown_intent_id_is_404(tmp_path):
    reviewer_run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
    core = FakeCore(tmp_path, reviewer_run)
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/reviews", token="revtok",
                                   body={"intent_id": "nope:1", "verdict": "approve", "argument": "x"})
        assert status == 404
        assert payload["error"] == "not_found"
    finally:
        srv.stop()


def test_review_wrong_review_of_run_is_403(tmp_path):
    """Fix round 1, C2: a reviewer must only rule on intents belonging to
    the run it was assigned to review (`run.review_of`) -- previously
    nothing checked this, so a reviewer with review_of="OTHER" could
    approve/reject an intent from an unrelated run "lib1" it was never
    handed."""
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, lib_run)
    core._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    srv, port = start(core)
    try:
        status, submitted = _submit_via_api(port, "libtok", "a1", 2)
        assert status == 200
        intent_id = submitted["intent_id"]

        other_reviewer = Run(run_id="rev-other", token="othertok", mode="reviewer",
                              arrival_keys=[], review_of="OTHER")
        core._run = other_reviewer

        status, payload = request(port, "POST", "/reviews", token="othertok",
                                   body={"intent_id": intent_id, "verdict": "approve", "argument": "x"})
        assert status == 403
        assert payload["error"] == "forbidden"
        # must not have been touched
        assert core.intents.store.get(intent_id)["state"] == PROPOSED_I
    finally:
        srv.stop()


def test_run_closed_between_auth_and_post_intent_is_409(tmp_path):
    """Fix round 1, I1: the run authorized at request start may have
    already been closed by the service (e.g. runner killed claude on
    timeout) by the time the locked section that would record the intent
    actually runs. `ctx_factory` re-checks `core.current_run() is run`
    inside `IntentBook.submit`'s own lock and must reject with 409 rather
    than record the intent against a run that's no longer open."""
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    inner = FakeCore(tmp_path, run)
    inner._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    core = ClosingCoreProxy(inner, run, close_after=1)  # open for auth, closed for ctx_factory
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/intents", token="tok",
                                   body=attach_intent("a1", 2))
        assert status == 409
        assert payload["error"] == "conflict"
        assert inner.intents.store.all() == []  # nothing was recorded
    finally:
        srv.stop()


def test_run_closed_between_auth_and_apply_review_is_409(tmp_path):
    """Fix round 1, I1: same race as above, for POST /reviews -- the
    `precheck` callback passed into `IntentBook.apply_review` re-checks
    `core.current_run() is run` inside `apply_review`'s own lock."""
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1"])
    inner = FakeCore(tmp_path, lib_run)
    inner._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    submitted = inner.intents.submit(lib_run, attach_intent("a1", 2), direct_ctx_factory(inner, lib_run))
    intent_id = submitted["intent_id"]

    reviewer_run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
    core = ClosingCoreProxy(inner, reviewer_run, close_after=1)  # open for auth, closed for precheck
    srv, port = start(core)
    try:
        status, payload = request(port, "POST", "/reviews", token="revtok",
                                   body={"intent_id": intent_id, "verdict": "approve", "argument": "x"})
        assert status == 409
        assert payload["error"] == "conflict"
        assert inner.intents.store.get(intent_id)["state"] == PROPOSED_I  # untouched
    finally:
        srv.stop()


def test_review_bad_verdict_is_400(tmp_path):
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, lib_run)
    core._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    srv, port = start(core)
    try:
        status, submitted = _submit_via_api(port, "libtok", "a1", 2)
        assert status == 200
        intent_id = submitted["intent_id"]

        reviewer_run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
        core._run = reviewer_run
        status, payload = request(port, "POST", "/reviews", token="revtok",
                                   body={"intent_id": intent_id, "verdict": "maybe", "argument": "x"})
        assert status == 400
        assert payload["error"] == "bad_request"
    finally:
        srv.stop()


# --- GET /books/{id}/search ----------------------------------------------------


def test_book_search_finds_hit_in_plain_epub_not_readalong(tmp_path, epub_root):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/3/search?q=dragon", token="tok")
        assert status == 200
        assert len(payload) == 1
        assert "dragon" in payload[0]["snippet"]
    finally:
        srv.stop()


def test_book_search_no_hits_returns_empty_list(tmp_path, epub_root):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/3/search?q=nonexistentword", token="tok")
        assert status == 200
        assert payload == []
    finally:
        srv.stop()


def test_book_search_unknown_book_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/books/999/search?q=x", token="tok")
        assert status == 404
    finally:
        srv.stop()


def test_book_search_no_plain_epub_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        # book 2 only has an m4b file -- no epub at all
        status, _payload = request(port, "GET", "/books/2/search?q=x", token="tok")
        assert status == 404
    finally:
        srv.stop()


def test_book_search_path_escaping_local_root_is_rejected(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/books/6/search?q=x", token="tok")
        assert status == 404
    finally:
        srv.stop()


# --- body limits -------------------------------------------------------------


def test_oversized_body_is_413(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        big = {"kind": "attach", "arrival": "a1", "book_id": 2, "reason": "x" * (70 * 1024)}
        status, payload = request(port, "POST", "/intents", token="tok", body=big)
        assert status == 413
        assert payload["error"] == "payload_too_large"
    finally:
        srv.stop()


def test_invalid_json_body_is_400(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/intents", body=b"not json", headers={
            "Authorization": "Bearer tok", "Content-Type": "application/json",
        })
        resp = conn.getresponse()
        data = json.loads(resp.read())
        conn.close()
        assert resp.status == 400
        assert data["error"] == "bad_request"
    finally:
        srv.stop()


def test_unknown_route_is_404(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, _payload = request(port, "GET", "/nope", token="tok")
        assert status == 404
    finally:
        srv.stop()


# --- fix round 1, I2: Content-Length / Transfer-Encoding hardening -----------


def test_negative_content_length_is_400(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        resp = raw_request(port, (
            b"POST /intents HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer tok\r\n"
            b"Content-Length: -5\r\n"
            b"Connection: close\r\n\r\n"
        ))
        assert status_of(resp) == 400
        assert json_body_of(resp)["error"] == "bad_request"
    finally:
        srv.stop()


def test_non_numeric_content_length_is_400(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        resp = raw_request(port, (
            b"POST /intents HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer tok\r\n"
            b"Content-Length: not-a-number\r\n"
            b"Connection: close\r\n\r\n"
        ))
        assert status_of(resp) == 400
        assert json_body_of(resp)["error"] == "bad_request"
    finally:
        srv.stop()


def test_transfer_encoding_is_411(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        resp = raw_request(port, (
            b"POST /intents HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer tok\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Connection: close\r\n\r\n"
            b"0\r\n\r\n"
        ))
        assert status_of(resp) == 411
        assert json_body_of(resp)["error"] == "length_required"
    finally:
        srv.stop()


# --- fix round 1, M2: non-ASCII bearer token must not 500 --------------------


def test_non_ascii_bearer_token_is_401_not_500(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        resp = raw_request(port, (
            b"GET /arrivals HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer t\xffk\r\n"
            b"Connection: close\r\n\r\n"
        ))
        assert status_of(resp) == 401
    finally:
        srv.stop()


# --- fix round 1, M3: internal errors are logged, not just swallowed --------


def test_internal_error_logs_traceback_and_returns_generic_500(tmp_path, caplog):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    core.arrivals = _BoomArrivals()
    srv, port = start(core)
    try:
        with caplog.at_level(logging.ERROR, logger="app.api"):
            status, payload = request(port, "GET", "/arrivals", token="tok")
        assert status == 500
        assert payload == {"error": "internal_error"}
        assert caplog.records
        assert any(r.exc_info for r in caplog.records)
    finally:
        srv.stop()


# --- fix round 1, M4: unsupported methods / malformed requests / bad UTF-8 --


def test_unsupported_methods_return_405_json(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            status, payload = request(port, method, "/arrivals", token="tok")
            assert status == 405, method
            assert payload["error"] == "method_not_allowed"
    finally:
        srv.stop()


def test_head_returns_405_with_no_body(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("HEAD", "/arrivals")
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        assert resp.status == 405
        assert data == b""
    finally:
        srv.stop()


def test_malformed_request_line_returns_json_400(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        resp = raw_request(port, b"GARBAGE\r\n\r\n")
        assert status_of(resp) == 400
        assert json_body_of(resp)["error"] == "bad_request"
    finally:
        srv.stop()


def test_invalid_utf8_body_is_400_not_500(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        bad = b"\xff\xfe\xfa"
        resp = raw_request(port, (
            b"POST /intents HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer tok\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(bad)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + bad
        ))
        assert status_of(resp) == 400
        assert json_body_of(resp)["error"] == "bad_request"
    finally:
        srv.stop()


# --- final review I1: reviewer sees and rules on filings only ------------------


def test_reviewer_cannot_see_or_rule_on_escalations(tmp_path):
    lib_run = Run(run_id="lib1", token="libtok", mode="librarian", arrival_keys=["a1", "a2"])
    core = FakeCore(tmp_path, lib_run)
    core._dossiers["a1"] = make_dossier("a1", primary_kind="epub", candidates=[2])
    core._dossiers["a2"] = make_dossier("a2")
    srv, port = start(core)
    try:
        status, filing = _submit_via_api(port, "libtok", "a1", 2)
        assert status == 200 and filing["status"] == PROPOSED_I
        status, esc = request(port, "POST", "/intents", token="libtok", body={
            "kind": "escalate", "arrival": "a2", "question": "which?",
            "options": [{"label": "a"}, {"label": "b"}], "recommendation": "a"})
        assert status == 200 and esc["status"] == PROPOSED_I, esc

        core._run = Run(run_id="rev1", token="revtok", mode="reviewer", arrival_keys=[], review_of="lib1")
        status, proposals = request(port, "GET", "/proposals", token="revtok")
        assert status == 200
        assert [p["intent_id"] for p in proposals] == [filing["intent_id"]]
        status, arrivals = request(port, "GET", "/arrivals", token="revtok")
        assert [a["key"] for a in arrivals] == ["a1"]

        status, result = request(port, "POST", "/reviews", token="revtok",
                                  body={"intent_id": esc["intent_id"], "verdict": "reject", "argument": "no"})
        assert status == 409, result
        assert core.intents.store.get(esc["intent_id"])["state"] == PROPOSED_I
    finally:
        srv.stop()


# --- final review minor 13: unreadable EPUB is a 404, not a 500 --------------


def test_book_search_missing_epub_file_is_404_json(tmp_path):
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)          # no epub_root fixture: the file does not exist
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/3/search?q=dragon", token="tok")
        assert status == 404
        assert payload["error"] == "not_found"
    finally:
        srv.stop()


def test_book_search_corrupt_epub_is_404_json(tmp_path):
    d = tmp_path / "media" / "books" / "Library" / "Author Three" / "Book Three"
    os.makedirs(d, exist_ok=True)
    (d / "book3.epub").write_bytes(b"this is not a zip file")
    run = Run(run_id="r1", token="tok", mode="librarian", arrival_keys=["a1"])
    core = FakeCore(tmp_path, run)
    srv, port = start(core)
    try:
        status, payload = request(port, "GET", "/books/3/search?q=dragon", token="tok")
        assert status == 404
        assert payload["error"] == "not_found"
    finally:
        srv.stop()
