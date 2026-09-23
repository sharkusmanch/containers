"""Vikunja REST client for escalations (Plan 2 Task 6).

Every arrival that needs a human decision becomes one Vikunja task in the
hand-made Librarian project (`VIKUNJA_PROJECT_ID`); the human answers by
commenting on it, and the core closes the task with the outcome
(app/escalations.py drives this; this module is only the HTTP client).

The API token is a user token -- it acts AS the user -- so a comment the
librarian posts is indistinguishable, by author, from one the user typed.
The core therefore records the id of every comment it posts in its own
Store (`<state>/vikunja.jsonl`, key `comment_id`, state `ours`) and treats
only UNRECORDED comments as replies. Every comment it posts also starts
with `PREFIX` ("🤖 Librarian: "), and `replies()` drops prefixed comments
even when unrecorded -- a crash between posting a comment and recording
its id must never turn the librarian's own words into a "human" answer.

Comments posted through vikunja-mcp by Claude sessions (which use the same
user's token) are NOT recorded here and do not carry the prefix, so they
count as replies exactly like one typed in the Vikunja UI -- by design: a
Claude session the user asked to answer an escalation answers it.

Vikunja stores descriptions and comments as HTML: outgoing text is sent as
`<p>` paragraphs with `<`, `>`, `&` (and quotes) escaped -- escalation
questions/labels are LLM-authored, untrusted text -- and incoming comments
are reduced back to plain text (`html_to_text`). Titles are plain text in
Vikunja (rendered as text, not HTML); they only lose control characters
and angle brackets.

Errors: every non-2xx or transport failure raises `VikunjaError`, whose
message names the method, path and status only -- never the token (it
travels in a header) nor a transport exception's own message.
"""
import html
import logging
import re
from html.parser import HTMLParser

logger = logging.getLogger(__name__)

PREFIX = "🤖 Librarian: "
OURS = "ours"
STORE_STATES = frozenset({OURS})
TIMEOUT = 15

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_BLOCK_TAGS = frozenset({"p", "br", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3",
                         "h4", "h5", "h6", "pre", "tr"})


class VikunjaError(Exception):
    """A Vikunja call failed (transport error, non-2xx, or a malformed
    response). Safe to log: never contains the token."""


def text_to_html(text: str) -> str:
    """Plain text -> Vikunja HTML: one escaped `<p>` per non-blank line."""
    lines = [ln.strip() for ln in str(text or "").split("\n")]
    return "".join(f"<p>{html.escape(ln)}</p>" for ln in lines if ln)


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


def html_to_text(value) -> str:
    """A Vikunja comment (HTML from the editor, or plain text from an API
    client such as vikunja-mcp) -> plain text: tags dropped, entities
    unescaped, one line per block, blank lines removed."""
    if not isinstance(value, str):
        return ""
    p = _TextExtractor()
    p.feed(value)
    p.close()
    lines = [ln.strip() for ln in "".join(p.parts).split("\n")]
    return "\n".join(ln for ln in lines if ln)


def _plain_title(title: str) -> str:
    return _CONTROL.sub("", str(title or "")).replace("<", "").replace(">", "").strip()


def _int_id(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class Vikunja:
    def __init__(self, base_url: str, token: str, project_id: int, public_url: str, store,
                 session=None):
        self.base_url = str(base_url).rstrip("/")
        self._token = token
        self.project_id = int(project_id)
        self.public_url = str(public_url).rstrip("/")
        self.store = store
        self._session = session
        self._verify_logged = False

    def __repr__(self):   # never the token
        return f"Vikunja({self.base_url!r}, project_id={self.project_id})"

    @property
    def session(self):
        if self._session is None:
            import requests  # local import: tests always inject a fake
            self._session = requests
        return self._session

    # --- transport ---------------------------------------------------------------

    def _call(self, method: str, path: str, body=None):
        try:
            resp = self.session.request(
                method, f"{self.base_url}{path}",
                headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
                json=body, timeout=TIMEOUT)
        except Exception as e:
            # never str(e): a transport error's message can embed the URL
            raise VikunjaError(f"{method} {path}: request failed: {type(e).__name__}") from None
        status = getattr(resp, "status_code", None)
        if not isinstance(status, int) or not 200 <= status < 300:
            raise VikunjaError(f"{method} {path}: HTTP {status}")
        try:
            return resp.json()
        except Exception:
            raise VikunjaError(f"{method} {path}: response is not JSON") from None

    # --- API ------------------------------------------------------------------------

    def verify(self) -> bool:
        """The configured project exists and the token can read it. Logs
        the first failure only (it is re-checked by callers, not spammed)."""
        try:
            self._call("GET", f"/projects/{self.project_id}")
            return True
        except VikunjaError as e:
            if not self._verify_logged:
                self._verify_logged = True
                logger.error("Vikunja project %s is not reachable: %s", self.project_id, e)
            return False

    def create_task(self, title: str, description: str) -> tuple[int, str]:
        """Create a task in the project; returns (task id, public task URL).
        `description` is plain text (escaped into `<p>` paragraphs here)."""
        body = {"title": _plain_title(title), "description": text_to_html(description)}
        task = self._call("PUT", f"/projects/{self.project_id}/tasks", body)
        tid = _int_id(task.get("id")) if isinstance(task, dict) else None
        if tid is None:
            raise VikunjaError("PUT task: response has no task id")
        return tid, f"{self.public_url}/tasks/{tid}"

    def comment(self, task_id: int, text: str) -> int:
        """Post `PREFIX + text` on the task and record its id as ours."""
        c = self._call("PUT", f"/tasks/{int(task_id)}/comments",
                       {"comment": text_to_html(PREFIX + str(text or ""))})
        cid = _int_id(c.get("id")) if isinstance(c, dict) else None
        if cid is None:
            raise VikunjaError("PUT comment: response has no comment id")
        self.store.record(str(cid), OURS, task_id=int(task_id))
        return cid

    def replies(self, task_id: int, after_id) -> list[dict]:
        """Human replies on the task: comments not recorded as ours and not
        carrying our prefix, with id > `after_id` (None = all), oldest
        first, as `{id, text, created, author}` (text is plain)."""
        raw = self._call("GET", f"/tasks/{int(task_id)}/comments")
        if not isinstance(raw, list):
            raise VikunjaError("GET comments: response is not a list")
        after = _int_id(after_id)
        out = []
        for c in raw:
            if not isinstance(c, dict):
                continue
            cid = _int_id(c.get("id"))
            if cid is None or (after is not None and cid <= after):
                continue
            if self.store.get(str(cid)) is not None:
                continue
            text = html_to_text(c.get("comment"))
            if not text or text.startswith(PREFIX.strip()):
                continue
            author = c.get("author") if isinstance(c.get("author"), dict) else {}
            out.append({"id": cid, "text": text, "created": c.get("created"),
                        "author": author.get("username")})
        out.sort(key=lambda r: r["id"])
        return out

    def close(self, task_id: int, text: str) -> bool:
        """Comment the outcome and mark the task done. Vikunja's
        `POST /tasks/{id}` replaces the task (omitted fields are blanked),
        so the current task is fetched and posted back with done=true.
        A task that is already done is left alone (returns False) -- a
        retry after a crash never double-comments a closed task."""
        tid = int(task_id)
        task = self._call("GET", f"/tasks/{tid}")
        if not isinstance(task, dict):
            raise VikunjaError("GET task: response is not an object")
        if task.get("done"):
            return False
        self.comment(tid, text)
        task["done"] = True
        self._call("POST", f"/tasks/{tid}", task)
        return True
