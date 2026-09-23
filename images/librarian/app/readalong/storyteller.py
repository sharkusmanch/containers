"""Minimal Storyteller v2-API client (urllib only). `transport` is injectable.

Gotchas carried over from the 2026-09-21 v2 pilot:
- POST /api/v2/books takes importMode PER REQUEST (default "reference" — which
  would rewrite the source EPUB 2 in place). Always send copy + replace.
- With epub2Strategy omitted and importMode != copy the route returns
  {"epub2Detected": true} instead of importing; we always send it, and refuse
  that shape anyway.
- Status lives under book["readaloud"] on v2; v3 may rename it — status_of()
  accepts both and returns UNKNOWN otherwise (never guesses).
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


FLUSH_EVERY = 64 << 20


def _stream_to_file(read, path, flush_every=FLUSH_EVERY):
    """vendored + (2026-09-23): write `read(size)` chunks to `path`, fsync'ing
    and dropping the page cache every `flush_every` bytes -- the destination is
    NFS, whose dirty pages count against the pod's memory limit (an 800 MB
    buffered write OOM-killed a 512Mi pod). Returns the bytes written."""
    n = since = 0
    with open(path, "wb") as fh:
        while True:
            chunk = read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
            n += len(chunk)
            since += len(chunk)
            if since >= flush_every:
                fh.flush()
                os.fsync(fh.fileno())
                os.posix_fadvise(fh.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
                since = 0
        fh.flush()
        os.fsync(fh.fileno())
    return n


def _http(method, url, body, headers, stream_to=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            if stream_to is not None:
                return r.status, _stream_to_file(r.read, stream_to)
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@dataclass(frozen=True)
class Status:
    status: str
    stage: str
    progress: float


def status_of(book):
    for key in ("readaloud", "processingStatus"):
        d = book.get(key)
        if isinstance(d, dict) and d.get("status"):
            return Status(str(d["status"]), str(d.get("currentStage") or d.get("currentTask") or ""),
                          float(d.get("stageProgress") or d.get("progress") or 0.0))
    return Status("UNKNOWN", "", 0.0)


def parse_action_id(html):
    """Find the Next.js Server Action id bound to InitForm in the RSC flight payload.

    beta.38's /init has no hidden form field at all (confirmed live 2026-09-22
    — see /tmp/st-init.html): the id lives in the flight payload embedded in
    the page as `{"id":"<40-42 hex chars>","bound":null}`, JSON-encoded inside
    a JS string so the quotes are backslash-escaped in the served HTML. The
    optional `\\?` before each quote matches both the escaped form (as served)
    and a plain/unescaped form, in case a future build stops escaping it.

    The flight payload can carry OTHER unbound server action references
    before InitForm's (nav, locale switcher, theme toggle, ...), each with
    the same `{"id":"...","bound":null}` shape — a bare `re.search` over the
    whole payload can silently return one of those instead, and init_admin
    would then invoke the wrong action with InitForm's argument shape. So we
    anchor the search to the text at/after the literal `InitForm` marker
    (confirmed live to precede its action id — see the fixture in
    test_storyteller.py), falling back to the whole payload only if that
    marker isn't present at all (e.g. a build that renames the component).
    """
    idx = html.find("InitForm")
    search_space = html[idx:] if idx != -1 else html
    m = re.search(r'\\?"id\\?":\\?"([0-9a-f]{40,42})\\?",\\?"bound\\?":null', search_space)
    if not m:
        raise RuntimeError("no server-action id found near InitForm on /init — instance already initialised?")
    return m.group(1)


def init_admin(base_url, username, password, email, transport=_http):
    """One-time /init: invoke the InitForm Next.js Server Action directly over HTTP.

    The browser doesn't submit a normal HTML form here — react-hook-form
    calls the bound server action, which the framework ships as a POST to
    the SAME /init URL carrying a `Next-Action: <action id>` header and a
    JSON-array body of the action's positional arguments (one arg: the form
    data as an object). `Origin` must be set — the action reads it for
    cookie settings.

    Success isn't reliably detectable from this response alone: on success
    the action calls redirect(...), which Next encodes in-band as a flight
    payload for the NEW page (confirmed live 2026-09-22: a successful call's
    body renders /login's component tree, no 3xx involved — urllib follows
    redirects transparently anyway); on failure the action returns the
    literal string "failed" as its own flight row, still HTTP 200.

    That row is `<n>:"failed"` on its own line — NOT a bare substring check.
    A live response body confirmed this the hard way: the success case's
    body includes the app's full i18n bundle, which contains an unrelated
    key `"failed":"Could not set cover colors"` — `b"failed" in raw` flags
    that as failure on every successful call. We only treat an explicit
    standalone "failed" row or an HTTP error as failure here — callers
    should verify success the reliable way, by logging in afterward.
    """
    st, html = transport("GET", f"{base_url}/init", None, {})
    aid = parse_action_id(html.decode(errors="ignore"))
    payload = [{"email": email, "fullName": "Admin", "username": username, "password": password}]
    body = json.dumps(payload).encode()
    st, raw = transport("POST", f"{base_url}/init", body, {
        "Next-Action": aid,
        "Content-Type": "text/plain;charset=UTF-8",
        "Accept": "text/x-component",
        "Origin": base_url,
    })
    if st >= 400:
        raise RuntimeError(f"/init returned {st}")
    if re.search(rb'(?m)^\d+:"failed"\s*$', raw):
        raise RuntimeError(f"/init action reported failure: {raw[:300]!r}")


class StorytellerClient:
    def __init__(self, base_url, token=None, transport=None):
        self.base = base_url.rstrip("/")
        self.token = token
        self._t = transport or _http
        self._username = None
        self._password = None

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        h.update(extra or {})
        return h

    def _json(self, method, path, payload=None, ok=(200, 201)):
        body = json.dumps(payload).encode() if payload is not None else None
        st, raw = self._t(method, self.base + path, body,
                          self._headers({"Content-Type": "application/json"} if body else None))
        if st not in ok:
            raise RuntimeError(f"{method} {path} -> {st}: {raw[:300]!r}")
        return json.loads(raw) if raw else {}

    def login(self, username, password):
        body = urllib.parse.urlencode({"usernameOrEmail": username, "password": password}).encode()
        st, raw = self._t("POST", self.base + "/api/v2/token", body,
                          {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
        if st != 200:
            raise RuntimeError(f"token -> {st}: {raw[:200]!r}")
        self.token = json.loads(raw)["access_token"]
        # Captured so relogin() can re-authenticate unattended after a token
        # expiry during the 12h wait_all poll. Never logged.
        self._username, self._password = username, password
        return self.token

    def relogin(self):
        """Re-run login() with the credentials captured on the first login()
        call. Used by wait_all when a poll fails with a 401. Never logs the
        credentials."""
        if self._username is None or self._password is None:
            raise RuntimeError("relogin() called before any successful login()")
        return self.login(self._username, self._password)

    def create_book(self, epub_path, audio_path):
        r = self._json("POST", "/api/v2/books",
                       {"paths": [epub_path, audio_path], "importMode": "copy", "epub2Strategy": "replace"})
        if r.get("epub2Detected"):
            raise RuntimeError(f"epub2Detected probe response — importMode/epub2Strategy not honoured: {r}")
        uuid = r.get("uuid")
        if not uuid:
            raise RuntimeError(f"no uuid in create response: {r}")
        return uuid

    def process(self, uuid, restart=None, config=None):
        q = f"?restart={restart}" if restart else ""
        self._json("POST", f"/api/v2/books/{uuid}/process{q}",
                   {"config": config} if config else None, ok=(200, 201, 202, 204))

    def book(self, uuid):
        return self._json("GET", f"/api/v2/books/{uuid}")

    def books(self):
        return self._json("GET", "/api/v2/books")

    def status(self, uuid):
        return status_of(self.book(uuid))

    def alignment_report(self, uuid):
        st, raw = self._t("GET", f"{self.base}/api/v2/books/{uuid}/alignment-report", None, self._headers())
        if st == 404:
            return None
        if st != 200:
            raise RuntimeError(f"alignment-report -> {st}: {raw[:200]!r}")
        return json.loads(raw)

    def delete_book(self, uuid):
        """vendored + (2026-09-23). 404 = already gone."""
        st, raw = self._t("DELETE", f"{self.base}/api/v2/books/{uuid}", None, self._headers())
        if st not in (200, 202, 204, 404):
            raise RuntimeError(f"delete {uuid} -> {st}: {raw[:200]!r}")

    def download_readaloud(self, uuid, dest_path):
        st, n = self._t("GET", f"{self.base}/api/v2/books/{uuid}/files?format=readaloud", None,
                        self._headers({"Accept": "*/*"}), stream_to=dest_path)
        if st != 200:
            raise RuntimeError(f"download -> {st}")
        return n
