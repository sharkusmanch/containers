"""app/vikunja.py: the Vikunja REST client (Plan 2 Task 6), against a fake
in-memory Vikunja -- never the real one."""
import logging

import pytest

from app.store import Store
from app.vikunja import PREFIX, Vikunja, VikunjaError, html_to_text, text_to_html

BASE = "http://vikunja.tools.svc.cluster.local:3456/api/v1"
TOKEN = "tk_secret_token_value"
PUBLIC = "https://vikunja.example.com"


class FakeResponse:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeVikunjaSession:
    """An in-memory Vikunja: project 5 exists; tasks and comments get
    increasing ids. POST /tasks/{id} REPLACES the task with the body (like
    Vikunja, which blanks fields a partial update omits)."""

    def __init__(self, project_id=5):
        self.project_id = project_id
        self.tasks = {}
        self.comments = {}          # task_id -> [comment]
        self.next_task = 100
        self.next_comment = 1000
        self.calls = []             # (method, path, json)
        self.fail = None            # "raise" | int status for every call

    def add_comment(self, task_id, text, username="marcus", author_id=1):
        self.next_comment += 1
        c = {"id": self.next_comment, "comment": text, "created": "2026-09-22T10:00:00Z",
             "author": {"id": author_id, "username": username}}
        if author_id is None:
            del c["author"]
        self.comments.setdefault(task_id, []).append(c)
        return c

    def request(self, method, url, headers=None, json=None, timeout=None):
        assert url.startswith(BASE)
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert timeout
        path = url[len(BASE):]
        self.calls.append((method, path, json))
        if self.fail == "raise":
            raise ConnectionError(f"cannot connect to {url} with {TOKEN}")
        if isinstance(self.fail, int):
            return FakeResponse(self.fail, {"message": "nope"})
        parts = path.strip("/").split("/")
        if parts == ["user"] and method == "GET":
            return FakeResponse(200, {"id": 1, "username": "marcus"})
        if parts[0] == "projects":
            pid = int(parts[1])
            if pid != self.project_id:
                return FakeResponse(404, {"message": "not found"})
            if len(parts) == 2 and method == "GET":
                return FakeResponse(200, {"id": pid, "title": "Librarian"})
            if len(parts) == 3 and parts[2] == "tasks" and method == "PUT":
                self.next_task += 1
                t = {"id": self.next_task, "title": json["title"], "description": json["description"],
                     "done": False, "project_id": pid}
                self.tasks[t["id"]] = t
                return FakeResponse(201, dict(t))
        if parts[0] == "tasks":
            tid = int(parts[1])
            if tid not in self.tasks:
                return FakeResponse(404, {"message": "not found"})
            if len(parts) == 2 and method == "GET":
                return FakeResponse(200, dict(self.tasks[tid]))
            if len(parts) == 2 and method == "POST":
                self.tasks[tid] = {**json, "id": tid}
                return FakeResponse(200, dict(self.tasks[tid]))
            if len(parts) == 3 and parts[2] == "comments" and method == "GET":
                return FakeResponse(200, [dict(c) if isinstance(c, dict) else c
                                            for c in self.comments.get(tid, [])])
            if len(parts) == 3 and parts[2] == "comments" and method == "PUT":
                c = self.add_comment(tid, json["comment"], username="marcus")
                return FakeResponse(201, dict(c))
        return FakeResponse(400, {"message": "unexpected"})


@pytest.fixture
def fake():
    return FakeVikunjaSession()


def make(tmp_path, session, project_id=5):
    store = Store(str(tmp_path / "vikunja.jsonl"), "comment_id", frozenset({"ours"}))
    return Vikunja(BASE, TOKEN, project_id, PUBLIC, store, session=session)


# --- html helpers ------------------------------------------------------------


def test_text_to_html_escapes_and_wraps_paragraphs():
    out = text_to_html("a <b> & c\n\nsecond line")
    assert out == "<p>a &lt;b&gt; &amp; c</p><p>second line</p>"


def test_html_to_text_strips_tags_and_unescapes():
    assert html_to_text("<p>2</p>") == "2"
    assert html_to_text("<p>use &amp; <strong>book</strong> 3</p><p>thanks</p>") == "use & book 3\nthanks"
    assert html_to_text("plain text from mcp") == "plain text from mcp"
    assert html_to_text(None) == ""


# --- verify ------------------------------------------------------------------


def test_verify_true_when_project_exists(tmp_path, fake):
    v = make(tmp_path, fake)
    assert v.verify() is True
    assert fake.calls == [("GET", "/projects/5", None), ("GET", "/user", None)]
    assert v.owner_id == 1


def test_verify_false_and_logs_once_when_project_missing(tmp_path, fake, caplog):
    v = make(tmp_path, fake, project_id=9)
    caplog.set_level(logging.ERROR)
    assert v.verify() is False
    assert v.verify() is False
    errs = [r for r in caplog.records if "Vikunja" in r.getMessage()]
    assert len(errs) == 1
    assert TOKEN not in caplog.text


def test_verify_false_on_network_error_never_logs_the_token(tmp_path, fake, caplog):
    fake.fail = "raise"
    caplog.set_level(logging.DEBUG)
    assert make(tmp_path, fake).verify() is False
    assert TOKEN not in caplog.text


# --- create_task / comment ----------------------------------------------------


def test_create_task_puts_escaped_html_and_returns_id_and_public_url(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, url = v.create_task("Librarian: A & B", "Which <book>?\n1. attach")
    assert tid == 101
    assert url == f"{PUBLIC}/tasks/101"
    method, path, body = fake.calls[-1]
    assert (method, path) == ("PUT", "/projects/5/tasks")
    assert body["title"] == "Librarian: A & B"
    assert body["description"] == "<p>Which &lt;book&gt;?</p><p>1. attach</p>"


def test_create_task_strips_angle_brackets_and_control_chars_from_title(tmp_path, fake):
    v = make(tmp_path, fake)
    v.create_task("Librarian: <img src=x>\x07bad", "q")
    assert fake.calls[-1][2]["title"] == "Librarian: img src=xbad"


def test_create_task_public_url_has_no_double_slash(tmp_path, fake):
    store = Store(str(tmp_path / "v.jsonl"), "comment_id", frozenset({"ours"}))
    v = Vikunja(BASE + "/", TOKEN, 5, PUBLIC + "/", store, session=fake)
    _, url = v.create_task("t", "d")
    assert url == f"{PUBLIC}/tasks/101"


def test_comment_prefixes_escapes_and_records_its_id(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    cid = v.comment(tid, "filed <ok>")
    assert fake.comments[tid][0]["comment"] == f"<p>{PREFIX}filed &lt;ok&gt;</p>"
    assert v.store.get(str(cid))["state"] == "ours"
    assert v.store.get(str(cid))["task_id"] == tid


def test_http_error_raises_vikunja_error_without_token(tmp_path, fake):
    v = make(tmp_path, fake)
    fake.fail = 500
    with pytest.raises(VikunjaError) as e:
        v.create_task("t", "d")
    assert "500" in str(e.value)
    assert TOKEN not in str(e.value)
    fake.fail = "raise"
    with pytest.raises(VikunjaError) as e:
        v.comment(1, "x")
    assert TOKEN not in str(e.value)


def test_create_task_without_an_id_in_the_response_raises(tmp_path, fake):
    v = make(tmp_path, fake)
    fake.request = lambda *a, **kw: FakeResponse(200, {"title": "no id"})
    with pytest.raises(VikunjaError):
        v.create_task("t", "d")


# --- replies -------------------------------------------------------------------


def test_replies_excludes_our_own_comments_oldest_first(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    v.comment(tid, "question again")
    r1 = fake.add_comment(tid, "<p>2</p>")
    r2 = fake.add_comment(tid, "<p>actually 1</p>")
    out = v.replies(tid, None)
    assert [r["id"] for r in out] == [r1["id"], r2["id"]]
    assert out[0]["text"] == "2"
    assert out[0]["author"] == "marcus"


def test_replies_after_id_filters_older(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    r1 = fake.add_comment(tid, "1")
    r2 = fake.add_comment(tid, "2")
    assert [r["id"] for r in v.replies(tid, r1["id"])] == [r2["id"]]
    assert v.replies(tid, r2["id"]) == []


def test_replies_ignores_prefixed_comments_even_when_unrecorded(tmp_path, fake):
    """A crash between posting a comment and recording its id must never
    turn the librarian's own comment into a 'human' reply."""
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.add_comment(tid, f"<p>{PREFIX}Filed into book 2</p>")
    assert v.replies(tid, None) == []


def test_replies_include_comments_posted_via_vikunja_mcp(tmp_path, fake):
    """Claude sessions post through vikunja-mcp as the same user: plain
    (non-HTML) text, no librarian prefix -- they count as replies."""
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.add_comment(tid, "1 - attach it")
    assert [r["text"] for r in v.replies(tid, None)] == ["1 - attach it"]


def test_replies_skip_malformed_comments(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.comments[tid] = [{"id": "x", "comment": "2"}, {"id": True, "comment": "2"}, "junk",
                          {"id": 5, "comment": "  "}]
    assert v.replies(tid, None) == []


def test_replies_non_list_response_raises(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.request = lambda *a, **kw: FakeResponse(200, {"oops": 1})
    with pytest.raises(VikunjaError):
        v.replies(tid, None)


# --- close ---------------------------------------------------------------------


def test_close_comments_then_marks_done_keeping_the_title(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("Librarian: X", "desc")
    assert v.close(tid, "Filed into book 2") is True
    t = fake.tasks[tid]
    assert t["done"] is True
    assert t["title"] == "Librarian: X"
    assert t["description"] == "<p>desc</p>"
    assert fake.comments[tid][-1]["comment"] == f"<p>{PREFIX}Filed into book 2</p>"


def test_close_already_done_task_posts_nothing(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.tasks[tid]["done"] = True
    assert v.close(tid, "again") is False
    assert fake.comments.get(tid) is None


# --- fix round 1 -----------------------------------------------------------------------


def test_replies_only_from_the_token_owner(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.add_comment(tid, "1", username="guest", author_id=2)
    mine = fake.add_comment(tid, "2")
    assert [r["id"] for r in v.replies(tid, None)] == [mine["id"]]   # owner looked up lazily


def test_replies_without_author_are_ignored_and_logged_once(tmp_path, fake, caplog):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.add_comment(tid, "1", author_id=None)
    caplog.set_level(logging.WARNING)
    assert v.replies(tid, None) == []
    assert v.replies(tid, None) == []
    assert caplog.text.count("no author") == 1


def test_replies_fail_closed_when_owner_unknown(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    fake.add_comment(tid, "1")
    real = fake.request

    def no_user(method, url, **kw):
        if url.endswith("/user"):
            return FakeResponse(500, {})
        return real(method, url, **kw)
    fake.request = no_user
    with pytest.raises(VikunjaError):
        v.replies(tid, None)


def test_task_state_open_done_gone(tmp_path, fake):
    v = make(tmp_path, fake)
    tid, _ = v.create_task("t", "d")
    assert v.task_state(tid) == "open"
    fake.tasks[tid]["done"] = True
    assert v.task_state(tid) == "done"
    del fake.tasks[tid]
    assert v.task_state(tid) == "gone"


def test_vikunja_error_carries_status_and_transport(tmp_path, fake):
    v = make(tmp_path, fake)
    fake.fail = 500
    with pytest.raises(VikunjaError) as e:
        v.create_task("t", "d")
    assert e.value.status == 500 and e.value.transport is False
    fake.fail = "raise"
    with pytest.raises(VikunjaError) as e:
        v.create_task("t", "d")
    assert e.value.status is None and e.value.transport is True
