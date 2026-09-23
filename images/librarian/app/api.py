"""Internal loopback HTTP API: the only surface a sandboxed `claude -p` (via
the MCP shim, app/mcp_shim.py, Task 10) can reach.

Strictly scoped per run and per mode. `ApiServer(core, host="127.0.0.1",
port=0)` wraps a `ThreadingHTTPServer` bound to loopback only -- Claude Code
issues MCP tool calls in parallel, so the handler must be safe under
concurrent requests (see the module docstrings of app/store.py and
app/intents.py for the locking rules this module leans on).

`core` satisfies the Global `Core` protocol (implemented for real by
app/service.py's `Service`, Task 12): `current_run() -> Run|None`,
`arrivals: Store`, `intents: IntentBook`, `index: LibraryIndex`,
`lists: KidsLists`, `load_dossier(key) -> dict|None`, `lock: threading.Lock`.

Every request needs `Authorization: Bearer <run token>` -- wrong/absent
token, or no open run at all, is 401 (never 403; 403 is reserved for "you
have a valid token but this endpoint/arrival is not for you"). The run's
`mode` ("librarian" | "reviewer") gates which endpoints are reachable at
all; a handful of read endpoints are further scoped to the run's own
arrivals via `run.seen_ids`/`run.arrival_keys` -- this is what lets
`app.policy.check_intent`'s guard 1 trust an attach's `book_id` (a
hallucinated id the LLM never actually saw a real response for is rejected
there, not here; this module's job is only to make sure `seen_ids` is a
truthful record of what the run was actually shown). The same scoping
applies to the write endpoints: `POST /intents` 403s unless the intent's
own `arrival` field is one this run may see, and `POST /reviews` 403s
unless the target intent belongs to the run this reviewer was assigned
(`intent.run_id == run.review_of`) -- a reviewer only ever rules on the
run it was actually asked to review.

Run lifecycle (fix round 1, I1): `core.current_run()` can change -- or go
to `None` -- at any moment, independent of any in-flight request: the
service closes a run when `claude -p` exits, including a timeout kill.
A request is authorized once, against whichever run was open when it
arrived; but a WRITE handler (`POST /intents`, `POST /reviews`) re-checks
`core.current_run() is run` again, a second time, inside the very locked
section that performs the mutation -- `POST /intents`' `ctx_factory` raises
`_RunClosed` (caught here, mapped to 409) before `IntentBook.submit` ever
computes an intent id, and `POST /reviews` passes a `precheck` callback
into `IntentBook.apply_review` that runs first thing inside `apply_review`'s
own `with self.lock:`. **This guarantee only holds if the service closes or
replaces a run while ALSO holding `core.lock`** -- the same lock
`IntentBook.submit`/`apply_review` already hold from guard-check to record
(see app/intents.py's module docstring). A close performed without that
lock can still race a request that already passed its precheck a moment
before the close and is now proceeding to mutate state.
"""
import hmac
import http.server
import json
import logging
import os
import threading
from http import HTTPStatus
from urllib.parse import parse_qs, unquote, urlparse

from app.media import search_epub
from app.policy import GuardContext

logger = logging.getLogger(__name__)

_MAX_BODY_BYTES = 64 * 1024


class _DossierMissing(Exception):
    """Raised by the `POST /intents` ctx_factory when `core.load_dossier`
    returns None -- caught by the handler and turned into a 404, never let
    to propagate into `IntentBook.submit`'s guard machinery."""


class _RunClosed(Exception):
    """Raised by the `POST /intents` ctx_factory when the run that was
    authorized at request start is no longer the open run by the time the
    locked section runs (see the module docstring, fix round 1 I1) --
    caught by the handler and turned into a 409."""


# --- small pure helpers, kept free of the handler for easy testing ----------


def _dossier_candidate_ids(dossier: dict) -> set:
    ids = set()
    for c in (dossier.get("candidates") or []):
        bid = (c.get("book") or {}).get("id")
        if bid is not None:
            ids.add(bid)
    return ids


def _plain_epub_file(book: dict) -> dict | None:
    """The book's plain EPUB: format epub, filename not the read-along
    variant. Case-insensitive on both, matching app.policy's own
    `_has_conflicting_format` check for the same distinction."""
    for f in (book.get("files") or []):
        fmt = str(f.get("format") or "").casefold()
        filename = str(f.get("filename") or "").casefold()
        if fmt == "epub" and not filename.endswith("(readaloud).epub"):
            return f
    return None


def _visible_arrivals(core, run) -> list:
    """The arrival keys this run may see. Librarian mode: the run's own
    `arrival_keys`. Reviewer mode: the arrivals of the proposals it is
    reviewing (`core.intents.proposals(run.review_of)`) -- a reviewer run's
    own `arrival_keys` is not what gates its reads (controller ruling).

    `IntentBook.proposals` reads the intents `Store` via `Store.all()`,
    which snapshots under the store's own lock (app/store.py, fix round 1
    M1) -- safe to call here without any additional locking even while a
    concurrent review is being recorded.
    """
    if run.mode == "reviewer":
        seen: list = []
        for p in core.intents.proposals(run.review_of):
            arrival = p.get("arrival")
            if arrival is not None and arrival not in seen:
                seen.append(arrival)
        return seen
    return list(run.arrival_keys)


def _history_for_key(store, key: str, limit: int = 20) -> list:
    """The last `limit` store records for `key`. `Store` keeps no in-memory
    history (see app/store.py's docstring: "the JSONL file IS the
    history") -- so this reads the JSONL file directly, tolerating a
    missing file and skipping any unparseable line (this is a read-only
    convenience endpoint, not the store's own crash-recovery path)."""
    if not os.path.exists(store.path):
        return []
    records = []
    with open(store.path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict) and rec.get(store.key_field) == key:
                records.append(rec)
    return records[-limit:]


def _error_status(error: str) -> int:
    return {"bad_request": 400, "not_found": 404, "conflict": 409}.get(error, 400)


# --- handler ------------------------------------------------------------


def _build_handler(core):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
            pass  # keep test/CI output quiet; nothing here is user-facing

        # --- response helpers ------------------------------------------------

        def _send_json(self, status: int, payload) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _error(self, status: int, error: str, reason: str | None = None) -> None:
            payload = {"error": error}
            if reason:
                payload["reason"] = reason
            self._send_json(status, payload)

        def send_error(self, code, message=None, explain=None):
            """Override the stdlib's default HTML error page -- used for
            request-line/header parse failures the framework catches
            before any `do_*` method even runs (fix round 1, M4) -- so a
            malformed request gets the same JSON shape as every other
            error path here.

            A request line so broken `parse_request()` bails before ever
            determining the real HTTP version leaves `self.request_version`
            at the class default `"HTTP/0.9"` -- and `send_response`/
            `send_header`/`end_headers` all silently no-op under
            `HTTP/0.9` (correctly: that version has no headers at all).
            Force it to this server's real protocol version first, or
            `_send_json` would write a bare body with no status line.
            """
            self.close_connection = True
            if self.request_version == "HTTP/0.9":
                self.request_version = self.protocol_version
            try:
                error = "bad_request" if int(code) < 500 else "internal_error"
                self._error(int(code), error, str(message) if message else None)
            except Exception:
                pass

        # --- auth --------------------------------------------------------

        def _authorize(self):
            run = core.current_run()
            if run is None:
                return None
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return None
            token = auth[len("Bearer "):]
            try:
                # fix round 1, M2: hmac.compare_digest raises TypeError on
                # non-ASCII str input rather than just comparing unequal.
                if not hmac.compare_digest(token, run.token):
                    return None
            except TypeError:
                return None
            return run

        # --- dispatch ------------------------------------------------------

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def _reject_method(self) -> None:
            """PUT/DELETE/PATCH/OPTIONS/HEAD: none of this API's endpoints
            use them (fix round 1, M4). Still drain any declared body so a
            reused keep-alive connection isn't left with stale bytes."""
            self.close_connection = True
            length_hdr = self.headers.get("Content-Length")
            try:
                length = int(length_hdr) if length_hdr is not None else 0
            except ValueError:
                length = 0
            if length > 0:
                try:
                    self.rfile.read(min(length, _MAX_BODY_BYTES))
                except Exception:
                    pass
            self._error(405, "method_not_allowed")

        def do_PUT(self):
            self._reject_method()

        def do_DELETE(self):
            self._reject_method()

        def do_PATCH(self):
            self._reject_method()

        def do_OPTIONS(self):
            self._reject_method()

        def do_HEAD(self):
            self._reject_method()

        def _handle(self, method: str) -> None:
            try:
                # fix round 1, I2: a chunked/Transfer-Encoding body has no
                # Content-Length to trust -- refuse it outright rather than
                # silently treating it as a zero-length body.
                if "Transfer-Encoding" in self.headers:
                    self.close_connection = True
                    self._error(HTTPStatus.LENGTH_REQUIRED, "length_required",
                                "chunked/Transfer-Encoding request bodies are not supported")
                    return

                length_hdr = self.headers.get("Content-Length")
                length = 0
                if length_hdr is not None:
                    try:
                        length = int(length_hdr)
                    except ValueError:
                        self.close_connection = True
                        self._error(400, "bad_request", "invalid Content-Length")
                        return
                    if length < 0:
                        self.close_connection = True
                        self._error(400, "bad_request", "invalid Content-Length")
                        return

                if length > _MAX_BODY_BYTES:
                    # Don't bother draining a hostile Content-Length -- just
                    # close the connection after responding.
                    self.close_connection = True
                    self._error(413, "payload_too_large")
                    return

                raw = self.rfile.read(length) if length else b""

                run = self._authorize()
                if run is None:
                    self._error(401, "unauthorized")
                    return

                body = None
                if method == "POST":
                    if raw:
                        try:
                            body = json.loads(raw)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            self._error(400, "bad_request", "invalid JSON")
                            return
                    else:
                        body = {}

                parsed = urlparse(self.path)
                segments = [s for s in parsed.path.split("/") if s]
                qs = parse_qs(parsed.query)
                self._route(method, segments, qs, body, run)
            except Exception:  # never let a bug wedge the whole server
                logger.exception("unhandled error handling %s %s", method, self.path)
                try:
                    self._error(500, "internal_error")
                except Exception:
                    pass

        def _route(self, method, segments, qs, body, run) -> None:
            if method == "GET" and segments == ["arrivals"]:
                return self._get_arrivals(run)
            if method == "GET" and len(segments) == 2 and segments[0] == "arrivals":
                return self._get_arrival(run, unquote(segments[1]))
            if method == "GET" and segments == ["books", "search"]:
                return self._get_books_search(run, qs)
            if method == "GET" and len(segments) == 3 and segments[0] == "books" and segments[2] == "search":
                return self._get_book_search_in_book(run, segments[1], qs)
            if method == "GET" and len(segments) == 2 and segments[0] == "books":
                return self._get_book(run, segments[1], qs)
            if method == "POST" and segments == ["intents"]:
                return self._post_intent(run, body)
            if method == "GET" and segments == ["proposals"]:
                return self._get_proposals(run)
            if method == "POST" and segments == ["reviews"]:
                return self._post_review(run, body)
            return self._error(404, "not_found")

        # --- GET /arrivals -------------------------------------------------

        def _get_arrivals(self, run) -> None:
            out = []
            for key in _visible_arrivals(core, run):
                rec = core.arrivals.get(key) or {}
                out.append({
                    "key": key,
                    "state": rec.get("state"),
                    "untrusted": {"title_hint": rec.get("title_hint")},
                })
            self._send_json(200, out)

        # --- GET /arrivals/{key} --------------------------------------------

        def _get_arrival(self, run, key: str) -> None:
            if key not in _visible_arrivals(core, run):
                return self._error(403, "forbidden")
            dossier = core.load_dossier(key)
            if dossier is None:
                return self._error(404, "not_found")

            ids = _dossier_candidate_ids(dossier)
            with core.lock:
                run.seen_ids.setdefault(key, set()).update(ids)

            history = _history_for_key(core.arrivals, key)
            arrival_rec = core.arrivals.get(key) or {}
            self._send_json(200, {
                "dossier": dossier,
                "untrusted": {
                    "history": history,
                    "human_answer": arrival_rec.get("human_answer"),
                },
            })

        # --- GET /books/search -----------------------------------------------

        def _get_books_search(self, run, qs) -> None:
            arrival = (qs.get("arrival") or [None])[0]
            if not arrival:
                return self._error(400, "bad_request", "arrival is required")
            if arrival not in _visible_arrivals(core, run):
                return self._error(403, "forbidden")

            q = (qs.get("q") or [""])[0]
            results = core.index.candidates(titles=[q], limit=10)
            summaries = [core.index.summarize(detail) for detail, _reasons in results]

            ids = {s["id"] for s in summaries if s.get("id") is not None}
            with core.lock:
                run.seen_ids.setdefault(arrival, set()).update(ids)

            self._send_json(200, summaries)

        # --- GET /books/{id} -------------------------------------------------

        def _get_book(self, run, raw_id: str, qs) -> None:
            arrival = (qs.get("arrival") or [None])[0]
            if not arrival:
                return self._error(400, "bad_request", "arrival is required")
            if arrival not in _visible_arrivals(core, run):
                return self._error(403, "forbidden")

            book_id = self._parse_id(raw_id)
            if book_id is None:
                return self._error(400, "bad_request", "id must be an integer")

            book = core.index.book(book_id)
            if book is None:
                return self._error(404, "not_found")

            summary = core.index.summarize(book)
            with core.lock:
                run.seen_ids.setdefault(arrival, set()).add(book_id)

            self._send_json(200, summary)

        # --- GET /books/{id}/search --------------------------------------------

        def _get_book_search_in_book(self, run, raw_id: str, qs) -> None:
            book_id = self._parse_id(raw_id)
            if book_id is None:
                return self._error(400, "bad_request", "id must be an integer")

            book = core.index.book(book_id)
            if book is None:
                return self._error(404, "not_found")

            epub_file = _plain_epub_file(book)
            if epub_file is None:
                return self._error(404, "not_found", "no plain EPUB for this book")

            absolute_path = epub_file.get("absolutePath")
            if not absolute_path:
                return self._error(404, "not_found", "no plain EPUB for this book")

            try:
                local_path = core.index.local_path(absolute_path)
            except ValueError:
                return self._error(404, "not_found", "no plain EPUB for this book")

            local_root = os.path.realpath(getattr(core.index, "_local_root", "/media/books"))
            real = os.path.realpath(local_path)
            if real != local_root and not real.startswith(local_root + os.sep):
                return self._error(404, "not_found", "no plain EPUB for this book")

            q = (qs.get("q") or [""])[0]
            try:
                hits = search_epub(real, q)
            except Exception as e:  # missing/corrupt EPUB: a 404, not a 500
                logger.warning("search in book %s failed: %s", book_id, type(e).__name__)
                return self._error(404, "not_found", "EPUB is missing or unreadable")
            self._send_json(200, hits)

        # --- POST /intents -----------------------------------------------------

        def _post_intent(self, run, body) -> None:
            if run.mode != "librarian":
                return self._error(403, "forbidden")
            if not isinstance(body, dict):
                return self._error(400, "bad_request", "body must be a JSON object")

            # fix round 1, C1: an intent's own `arrival` must be one this
            # run may actually see -- otherwise a librarian run could file
            # against (and move the state of) an arrival it was never
            # handed, just by guessing/enumerating a key.
            arrival = body.get("arrival")
            if not isinstance(arrival, str) or arrival not in _visible_arrivals(core, run):
                return self._error(403, "forbidden", "arrival is not visible to this run")

            def ctx_factory(key):
                # fix round 1, I1: re-check inside the same locked section
                # IntentBook.submit is about to record into.
                if core.current_run() is not run:
                    raise _RunClosed()
                dossier = core.load_dossier(key)
                if dossier is None:
                    raise _DossierMissing()
                arrival_rec = core.arrivals.get(key) or {}
                return GuardContext(
                    dossier=dossier,
                    index=core.index,
                    seen_ids=run.seen_ids.get(key, set()),
                    run_claims=run.claims,
                    lists=core.lists,
                    human_answer=arrival_rec.get("human_answer"),
                )

            try:
                result = core.intents.submit(run, body, ctx_factory)
            except _DossierMissing:
                return self._error(404, "not_found")
            except _RunClosed:
                return self._error(409, "conflict", "run is no longer open")

            self._send_json(200, result)

        # --- GET /proposals -------------------------------------------------

        def _get_proposals(self, run) -> None:
            if run.mode != "reviewer":
                return self._error(403, "forbidden")
            self._send_json(200, core.intents.proposals(run.review_of))

        # --- POST /reviews -----------------------------------------------------

        def _post_review(self, run, body) -> None:
            if run.mode != "reviewer":
                return self._error(403, "forbidden")
            if not isinstance(body, dict):
                return self._error(400, "bad_request", "body must be a JSON object")

            intent_id = body.get("intent_id")
            verdict = body.get("verdict")
            argument = body.get("argument", "")
            if not isinstance(intent_id, str) or not intent_id:
                return self._error(400, "bad_request", "intent_id must be a non-empty string")
            if not isinstance(verdict, str):
                return self._error(400, "bad_request", "verdict must be a string")

            # fix round 1, C2: this reviewer may only rule on intents from
            # the run it was actually assigned to review -- read-only check
            # against an immutable field (an intent's run_id never changes
            # after creation), so no lock is needed for this alone.
            rec = core.intents.store.get(intent_id)
            if rec is None:
                return self._error(404, "not_found")
            if rec.get("run_id") != run.review_of:
                return self._error(403, "forbidden")

            def precheck():
                # fix round 1, I1: re-checked again inside apply_review's
                # own locked section, same rationale as ctx_factory above.
                if core.current_run() is not run:
                    return False, "run is no longer open"
                return True, None

            result = core.intents.apply_review(run, intent_id, verdict, argument, precheck=precheck)
            if "error" in result:
                return self._error(_error_status(result["error"]), result["error"], result.get("reason"))
            self._send_json(200, result)

        # --- misc ------------------------------------------------------------

        @staticmethod
        def _parse_id(raw_id: str):
            try:
                return int(unquote(raw_id))
            except ValueError:
                return None

    return Handler


class ApiServer:
    """`.start()` binds a `ThreadingHTTPServer` to loopback and returns the
    bound port; `.stop()` shuts it down. Bind address is hard-locked to
    `127.0.0.1` -- this is the only surface a sandboxed `claude -p` reaches,
    and it must never be reachable from anywhere else on the pod's network
    namespace, let alone the cluster."""

    def __init__(self, core, host: str = "127.0.0.1", port: int = 0):
        if host != "127.0.0.1":
            raise ValueError("ApiServer must bind to 127.0.0.1 only")
        self._core = core
        self._host = host
        self._port = port
        self._httpd: http.server.ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> int:
        handler = _build_handler(self._core)
        self._httpd = http.server.ThreadingHTTPServer((self._host, self._port), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self._httpd.server_address[1]

    @property
    def bound_host(self) -> str | None:
        return self._httpd.server_address[0] if self._httpd else None

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
