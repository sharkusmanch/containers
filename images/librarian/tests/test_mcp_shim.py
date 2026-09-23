"""Tests for the stdio MCP shim (app/mcp_shim.py).

The shim itself is a thin FastMCP wrapper: every tool is one stdlib-urllib
HTTP call to the internal loopback API (app/api.py). These tests stand up a
real `http.server.ThreadingHTTPServer` stub (not a mock of urllib) so the
actual request line, headers, and body the shim sends are exercised, and
drive tools the same way Claude Code would: `asyncio.run(server.call_tool(...))`.
"""
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.mcp_shim import build_mcp_config, build_server

BOTH_TOOLS = {"list_arrivals", "get_arrival", "search_books", "get_book", "search_in_book"}
LIBRARIAN_ONLY = {"attach", "create_book", "escalate", "defer"}
REVIEWER_ONLY = {"list_proposals", "review"}


def _tool_names(server):
    tools = asyncio.run(server.list_tools())
    return {t.name for t in tools}


def _call(server, name, args):
    """For tools whose HTTP route returns a JSON *object* (get_arrival,
    get_book, attach, create_book, escalate, defer, review): FastMCP
    serializes a dict return as exactly one TextContent block."""
    result = asyncio.run(server.call_tool(name, args))
    assert len(result) == 1
    return json.loads(result[0].text)


def _call_list(server, name, args):
    """For tools whose HTTP route returns a JSON *array* (list_arrivals,
    search_books, search_in_book, list_proposals): FastMCP splits a list
    return into one TextContent block per element, so reassemble it."""
    result = asyncio.run(server.call_tool(name, args))
    return [json.loads(block.text) for block in result]


class _StubHandler(BaseHTTPRequestHandler):
    """Records the last request it saw and replies with whatever
    `self.server.responses` has queued for (method, path)."""

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature, keep tests quiet
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self.server.requests.append({
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers.items()),
            "body": json.loads(raw) if raw else None,
        })
        status, payload = self.server.responses.get(
            (self.command, self.path.split("?")[0]), (200, {}),
        )
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()


@pytest.fixture
def stub_api():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    httpd.requests = []
    httpd.responses = {}
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _api_url(httpd):
    return f"http://127.0.0.1:{httpd.server_address[1]}"


# --- mode-scoped tool registration -------------------------------------


def test_reviewer_mode_registers_only_shared_and_reviewer_tools(stub_api):
    server = build_server("reviewer", _api_url(stub_api), "tok")
    assert _tool_names(server) == BOTH_TOOLS | REVIEWER_ONLY


def test_librarian_mode_registers_only_shared_and_librarian_tools(stub_api):
    server = build_server("librarian", _api_url(stub_api), "tok")
    assert _tool_names(server) == BOTH_TOOLS | LIBRARIAN_ONLY


def test_librarian_mode_excludes_review_and_list_proposals(stub_api):
    server = build_server("librarian", _api_url(stub_api), "tok")
    names = _tool_names(server)
    assert "review" not in names
    assert "list_proposals" not in names


def test_reviewer_mode_excludes_librarian_only_tools(stub_api):
    server = build_server("reviewer", _api_url(stub_api), "tok")
    names = _tool_names(server)
    assert not (LIBRARIAN_ONLY & names)


def test_importing_module_registers_nothing():
    """Importing app.mcp_shim must not create/register any tools as a
    side effect -- only calling build_server() does."""
    import app.mcp_shim as mod

    # No module-level FastMCP instance is exposed; build_server is a pure
    # factory, so two calls must produce two independent registrations.
    a = mod.build_server("reviewer", "http://x", "t")
    b = mod.build_server("librarian", "http://x", "t")
    assert _tool_names(a) != _tool_names(b)


def test_unknown_mode_registers_no_tools_and_raises():
    with pytest.raises(ValueError):
        build_server("bogus", "http://x", "t")


# --- HTTP forwarding -----------------------------------------------------


def test_list_arrivals_returns_stub_json(stub_api):
    stub_api.responses[("GET", "/arrivals")] = (200, [{"key": "a:1", "state": "ready"}])
    server = build_server("librarian", _api_url(stub_api), "sekrit")
    result = _call_list(server, "list_arrivals", {})
    assert result == [{"key": "a:1", "state": "ready"}]
    req = stub_api.requests[-1]
    assert req["headers"]["Authorization"] == "Bearer sekrit"


def test_get_arrival_quotes_key_with_colon_and_slash(stub_api):
    key = "manual:some/nested key"
    stub_api.responses[("GET", "/arrivals/manual%3Asome%2Fnested%20key")] = (
        200, {"dossier": {"key": key}},
    )
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call(server, "get_arrival", {"key": key})
    assert result == {"dossier": {"key": key}}


def test_search_books_passes_query_and_arrival(stub_api):
    stub_api.responses[("GET", "/books/search")] = (200, [{"id": 1}])
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call_list(server, "search_books", {"query": "dune", "arrival": "a:1"})
    assert result == [{"id": 1}]
    req = stub_api.requests[-1]
    assert req["path"].startswith("/books/search?")
    assert "q=dune" in req["path"]
    assert "arrival=a%3A1" in req["path"]


def test_get_book_passes_arrival(stub_api):
    stub_api.responses[("GET", "/books/7")] = (200, {"id": 7})
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call(server, "get_book", {"book_id": 7, "arrival": "a:1"})
    assert result == {"id": 7}
    assert "arrival=a" in stub_api.requests[-1]["path"]


def test_search_in_book(stub_api):
    stub_api.responses[("GET", "/books/7/search")] = (200, [{"snippet": "x"}])
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call_list(server, "search_in_book", {"book_id": 7, "query": "hello"})
    assert result == [{"snippet": "x"}]


def test_attach_posts_flat_intent(stub_api):
    stub_api.responses[("POST", "/intents")] = (200, {"intent_id": "i1"})
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call(server, "attach", {
        "arrival": "a:1", "book_id": 7, "reason": "matches", "readalong": False,
    })
    assert result == {"intent_id": "i1"}
    body = stub_api.requests[-1]["body"]
    assert body == {
        "kind": "attach", "arrival": "a:1", "book_id": 7,
        "reason": "matches", "readalong": False,
    }


def test_attach_defaults_readalong_true(stub_api):
    stub_api.responses[("POST", "/intents")] = (200, {"intent_id": "i1"})
    server = build_server("librarian", _api_url(stub_api), "tok")
    _call(server, "attach", {"arrival": "a:1", "book_id": 7, "reason": "matches"})
    assert stub_api.requests[-1]["body"]["readalong"] is True


def test_create_book_posts_flat_intent(stub_api):
    stub_api.responses[("POST", "/intents")] = (200, {"intent_id": "i2"})
    server = build_server("librarian", _api_url(stub_api), "tok")
    metadata = {"title": "T", "authors": ["A"]}
    result = _call(server, "create_book", {
        "arrival": "a:1", "library": "adult", "metadata": metadata, "reason": "new",
    })
    assert result == {"intent_id": "i2"}
    body = stub_api.requests[-1]["body"]
    assert body == {
        "kind": "create_book", "arrival": "a:1", "library": "adult",
        "metadata": metadata, "reason": "new", "readalong": True,
    }


def test_escalate_posts_flat_intent(stub_api):
    stub_api.responses[("POST", "/intents")] = (200, {"intent_id": "i3"})
    server = build_server("librarian", _api_url(stub_api), "tok")
    options = [{"label": "A"}, {"label": "B"}]
    result = _call(server, "escalate", {
        "arrival": "a:1", "question": "which?", "options": options, "recommendation": "A",
    })
    assert result == {"intent_id": "i3"}
    body = stub_api.requests[-1]["body"]
    assert body == {
        "kind": "escalate", "arrival": "a:1", "question": "which?",
        "options": options, "recommendation": "A",
    }


def test_defer_posts_flat_intent(stub_api):
    stub_api.responses[("POST", "/intents")] = (200, {"intent_id": "i4"})
    server = build_server("librarian", _api_url(stub_api), "tok")
    result = _call(server, "defer", {
        "arrival": "a:1", "reason": "wait", "not_before_hours": 24,
    })
    assert result == {"intent_id": "i4"}
    body = stub_api.requests[-1]["body"]
    assert body == {
        "kind": "defer", "arrival": "a:1", "reason": "wait", "not_before_hours": 24,
    }


def test_list_proposals(stub_api):
    stub_api.responses[("GET", "/proposals")] = (200, [{"intent_id": "i1"}])
    server = build_server("reviewer", _api_url(stub_api), "tok")
    result = _call_list(server, "list_proposals", {})
    assert result == [{"intent_id": "i1"}]


def test_review_posts_body(stub_api):
    stub_api.responses[("POST", "/reviews")] = (200, {"ok": True})
    server = build_server("reviewer", _api_url(stub_api), "tok")
    result = _call(server, "review", {
        "intent_id": "i1", "verdict": "approve", "argument": "looks right",
    })
    assert result == {"ok": True}
    body = stub_api.requests[-1]["body"]
    assert body == {"intent_id": "i1", "verdict": "approve", "argument": "looks right"}


# --- error handling --------------------------------------------------------


def test_conflict_status_returns_error_dict_not_raise(stub_api):
    stub_api.responses[("POST", "/reviews")] = (
        409, {"error": "conflict", "reason": "run is no longer open"},
    )
    server = build_server("reviewer", _api_url(stub_api), "tok")
    result = _call(server, "review", {
        "intent_id": "i1", "verdict": "approve", "argument": "x",
    })
    assert result["error"] == "conflict"
    assert result["status"] == 409


def test_unauthorized_status_returns_error_dict(stub_api):
    stub_api.responses[("GET", "/arrivals")] = (401, {"error": "unauthorized"})
    server = build_server("librarian", _api_url(stub_api), "wrong-token")
    result = _call(server, "list_arrivals", {})
    assert result == {"error": "unauthorized", "status": 401}


def test_unreachable_api_returns_error_dict_without_raising():
    # Nothing listens on this port -- connection refused.
    server = build_server("librarian", "http://127.0.0.1:1", "tok")
    result = _call(server, "list_arrivals", {})
    assert result == {"error": "librarian API unreachable", "status": 0}


# --- build_mcp_config ------------------------------------------------------


def test_build_mcp_config_exact_shape():
    config = build_mcp_config("/usr/bin/python3", "http://127.0.0.1:9000", "tok123", "librarian")
    assert config == {
        "mcpServers": {
            "librarian": {
                "command": "/usr/bin/python3",
                "args": ["-m", "app.mcp_shim"],
                "env": {
                    "LIBRARIAN_API": "http://127.0.0.1:9000",
                    "LIBRARIAN_RUN_TOKEN": "tok123",
                    "LIBRARIAN_MODE": "librarian",
                    "PYTHONPATH": "/app",
                },
            }
        }
    }
