"""Vendored BookOrbit client + read-only library index.

Vendored from /config/books scripts/bookorbit/client.py @ 0340bdd -- copied
verbatim except: `secret_value()`/kubectl removed (the service takes
BOOKORBIT_USER/BOOKORBIT_PASS from Settings, never kubectl), `cookie_path` is
now a required constructor argument (the service passes
`<state_dir>/bookorbit-cookies.txt`), `patch`/`put`/`delete` are deleted, and
`post()` is restricted to the three paths this plan actually needs -- writes
arrive as a separate, reviewed change in Plan 2. DRY_RUN is hard-wired for
this plan (see global constraints): nothing in this module may write.

`LibraryIndex` is this service's ONLY view of the BookOrbit library. It pages
`/books/query` for the id/updatedAt of every book, fetches full detail only
for ids that are new or whose `updatedAt` changed, and persists the resulting
cache to disk so a restart does not require re-fetching every book detail.
Ranking for `candidates()` lives here (not in the LLM) so it is testable --
the LLM still sees every candidate and reasons about them itself.
"""
import http.cookiejar
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

from app.titles import surnames, title_keys

RELOGIN_AFTER_SECONDS = 600  # access token lives 900s

# post() is read-adjacent only: /books/query is a search (POST because the
# filter body doesn't fit a query string), and the two auth endpoints are
# inherently POST. Every other write verb (patch/put/delete, and any other
# post path) is deleted/blocked -- see module docstring.
_ALLOWED_POST_PATHS = frozenset({"/books/query", "/auth/login", "/auth/refresh"})

REFRESH_INTERVAL_SECONDS = 15 * 60
FULL_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60
QUERY_PAGE_SIZE = 100


class BookorbitClient:
    def __init__(self, base_url, username, password, transport=None, cookie_path=None):
        self.base_url = base_url.rstrip("/")
        self._username = username
        self._password = password
        self._token = None
        self._token_obtained_at = 0.0

        if not cookie_path:
            raise ValueError("cookie_path is required")
        self._cookie_path = pathlib.Path(cookie_path)
        self._jar = http.cookiejar.MozillaCookieJar(str(self._cookie_path))
        if self._cookie_path.exists():
            try:
                self._jar.load(ignore_discard=True, ignore_expires=True)
            except Exception:
                pass  # a corrupt jar is not fatal; we fall back to login
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar))
        self._transport = transport or self._http

    # --- transport -------------------------------------------------------
    def _http(self, method, url, body, headers):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=60) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def _call(self, method, path, payload=None, authorized=True):
        headers = {"Content-Type": "application/json"}
        if authorized:
            if not self._token:
                raise RuntimeError("not authenticated: call authenticate() first")
            headers["Authorization"] = "Bearer " + self._token
        body = json.dumps(payload).encode() if payload is not None else None
        status, text = self._transport(method, self.base_url + path, body, headers)
        if status >= 400:
            raise RuntimeError(f"{method} {path} -> HTTP {status}: {text[:400]}")
        return json.loads(text) if text else {}

    # --- auth ------------------------------------------------------------
    @property
    def token_age_seconds(self):
        return time.time() - self._token_obtained_at

    def has_refresh_credential(self):
        """True if a stored refresh_token cookie is available to trade in."""
        return any(c.name == "refresh_token" for c in self._jar)

    def _save_cookies(self):
        try:
            self._cookie_path.parent.mkdir(parents=True, exist_ok=True)
            self._jar.save(ignore_discard=True, ignore_expires=True)
            os.chmod(self._cookie_path, 0o600)   # a 7-day credential on disk
        except Exception:
            pass  # persistence is an optimisation, never a hard failure

    def _accept_token(self, data):
        self._token = data["accessToken"]
        self._token_obtained_at = time.time()
        self._save_cookies()

    def login(self):
        self._accept_token(self._call(
            "POST", "/auth/login",
            {"username": self._username, "password": self._password}, authorized=False))

    def refresh(self):
        """Trade the stored cookie for a new access token. Unthrottled."""
        self._accept_token(self._call("POST", "/auth/refresh", {}, authorized=False))

    def authenticate(self):
        """Prefer the unthrottled refresh endpoint; fall back to login."""
        if self.has_refresh_credential():
            try:
                self.refresh()
                return
            except RuntimeError:
                pass  # expired or revoked — fall through
        self.login()

    def _ensure_fresh(self):
        if self._token and self.token_age_seconds >= RELOGIN_AFTER_SECONDS:
            self.authenticate()

    # --- verbs -----------------------------------------------------------
    def get(self, path):
        self._ensure_fresh()
        return self._call("GET", path)

    def post(self, path, payload):
        if path not in _ALLOWED_POST_PATHS:
            raise PermissionError(
                f"POST {path} is not permitted: this client is read-only "
                f"(writes ship in a later plan)")
        self._ensure_fresh()
        return self._call("POST", path, payload)


# --- LibraryIndex ------------------------------------------------------------


def _names(entries):
    """`GET /books/{id}` returns `authors`/`narrators` as objects
    (`{"id", "name", "sortName"}`), not plain strings -- verified live
    2026-09-22, differs from the /books/query listing shape. Accept both so a
    caller never has to know which endpoint a cached record came from."""
    out = []
    for e in entries or []:
        if isinstance(e, dict):
            n = e.get("name")
            if n:
                out.append(n)
        elif e:
            out.append(e)
    return out


def _score(detail, *, audible_asin, kindle_asin, isbn, title_key_set, surname_set):
    """Return (score, reasons) for one candidate, or (0, []) for no match."""
    reasons = []
    score = 0

    if audible_asin and (detail.get("providerIds") or {}).get("audible") == audible_asin:
        reasons.append("audible-asin")
        score = max(score, 100)

    if kindle_asin and f"asin:{kindle_asin}" in (detail.get("tags") or []):
        reasons.append("kindle-asin")
        score = max(score, 100)

    if isbn and isbn in (detail.get("isbn13"), detail.get("isbn10")):
        reasons.append("isbn")
        score = max(score, 90)

    if title_key_set:
        cand_keys = title_keys(detail.get("title") or "", detail.get("subtitle"))
        overlap = title_key_set & cand_keys
        if overlap:
            cand_surnames = surnames(_names(detail.get("authors")))
            has_surname = bool(surname_set & cand_surnames)
            for k in sorted(overlap):
                reasons.append(f"title-key:{k}")
            if has_surname:
                for s in sorted(surname_set & cand_surnames):
                    reasons.append(f"surname:{s}")
                score = max(score, 60)
            else:
                score = max(score, 20)

    return score, reasons


class LibraryIndex:
    """This service's only view of the BookOrbit library.

    `_books` maps str(book id) -> full `/books/{id}` detail dict (string keys
    because the cache round-trips through JSON, whose object keys are always
    strings); refresh bookkeeping (`_last_refresh`, `_last_full_refresh`) is
    persisted alongside it as separate top-level fields in the same file.
    """

    def __init__(self, client, state_path, path_prefix="/books", local_root="/media/books"):
        self._client = client
        self._state_path = str(state_path)
        self._path_prefix = path_prefix.rstrip("/")
        self._local_root = local_root.rstrip("/")
        self._books: dict[str, dict] = {}
        self._last_refresh: float | None = None
        self._last_full_refresh: float | None = None
        self._load()

    # --- persistence -------------------------------------------------------
    def _load(self):
        try:
            with open(self._state_path) as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return
        self._books = data.get("books", {})
        self._last_refresh = data.get("last_refresh")
        self._last_full_refresh = data.get("last_full_refresh")

    def _save(self):
        d = os.path.dirname(self._state_path) or "."
        os.makedirs(d, exist_ok=True)
        data = {
            "books": self._books,
            "last_refresh": self._last_refresh,
            "last_full_refresh": self._last_full_refresh,
        }
        tmp_path = f"{self._state_path}.tmp{os.getpid()}"
        with open(tmp_path, "w") as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, self._state_path)

    # --- refresh -------------------------------------------------------------
    def refresh(self, now=None, force=False):
        now = time.time() if now is None else now
        if not force and self._last_refresh is not None:
            if now - self._last_refresh < REFRESH_INTERVAL_SECONDS:
                return

        # `force` only bypasses the 15-min refresh-cadence throttle above; a
        # full detail re-fetch (regardless of updatedAt) runs on its own
        # independent 24h clock, per the brief -- otherwise every manual
        # force=True refresh would blow the incremental-fetch guarantee.
        full = self._last_full_refresh is None or (
            now - self._last_full_refresh >= FULL_REFRESH_INTERVAL_SECONDS)

        listing = self._page_all()
        seen_ids = set()
        for item in listing:
            bid = str(item["id"])
            seen_ids.add(bid)
            cached = self._books.get(bid)
            needs_fetch = full or cached is None or cached.get("updatedAt") != item.get("updatedAt")
            if needs_fetch:
                self._books[bid] = self._client.get(f"/books/{bid}")

        # drop ids no longer listed
        for stale in set(self._books) - seen_ids:
            del self._books[stale]

        self._last_refresh = now
        if full:
            self._last_full_refresh = now
        self._save()

    def _page_all(self):
        items = []
        page = 0
        total = None
        while total is None or page * QUERY_PAGE_SIZE < total:
            resp = self._client.post(
                "/books/query", {"pagination": {"page": page, "size": QUERY_PAGE_SIZE}})
            items.extend(resp.get("items", []))
            total = resp.get("total", 0)
            page += 1
            if not resp.get("items"):
                break
        return items

    # --- accessors -----------------------------------------------------------
    def book(self, id):
        return self._books.get(str(id))

    def books(self):
        return list(self._books.values())

    def detail(self, id, fresh=True):
        """`fresh=True` (default) re-GETs the book, bypassing the cache
        freshness check -- the dossier uses this for its <= 8 candidates so
        dossiers never carry stale detail. `fresh=False` returns the cached
        copy when one exists, falling back to a live GET only if nothing is
        cached yet. Either way the cache is updated as a side effect."""
        if not fresh:
            cached = self.book(id)
            if cached is not None:
                return cached
        d = self._client.get(f"/books/{id}")
        self._books[str(id)] = d
        return d

    def local_path(self, bookorbit_path):
        if not bookorbit_path.startswith(self._path_prefix + "/") and bookorbit_path != self._path_prefix:
            raise ValueError(
                f"{bookorbit_path!r} is outside the BookOrbit path prefix {self._path_prefix!r}")
        suffix = bookorbit_path[len(self._path_prefix):]
        return self._local_root + suffix

    # --- candidates -----------------------------------------------------------
    def candidates(self, *, audible_asin=None, kindle_asin=None, isbn=None,
                    titles=(), authors=(), limit=8):
        title_key_set: set[str] = set()
        for t in titles:
            title_key_set |= title_keys(t)
        surname_set = surnames(list(authors))

        scored = []
        for detail in self._books.values():
            score, reasons = _score(
                detail, audible_asin=audible_asin, kindle_asin=kindle_asin, isbn=isbn,
                title_key_set=title_key_set, surname_set=surname_set)
            if score > 0:
                scored.append((score, detail, reasons))

        scored.sort(key=lambda t: t[0], reverse=True)
        return [(detail, reasons) for _score_val, detail, reasons in scored[:limit]]

    # --- summarize -----------------------------------------------------------
    def summarize(self, detail):
        formats = []
        for f in detail.get("files") or []:
            formats.append({
                "format": f.get("format"),
                "filename": f.get("filename"),
                "size": f.get("sizeBytes"),
                "duration_s": f.get("durationSeconds"),
            })
        return {
            "id": detail.get("id"),
            "library": detail.get("libraryName"),
            "title": detail.get("title"),
            "subtitle": detail.get("subtitle"),
            "authors": _names(detail.get("authors")),
            "series": detail.get("seriesName"),
            "series_index": detail.get("seriesIndex"),
            "year": detail.get("publishedYear"),
            # GET /books/{id} carries no top-level "narrators" -- verified
            # live 2026-09-22: it's nested under audioMetadata.narrators (as
            # objects) for audio books, and absent entirely for ebook-only
            # ones. The /books/query listing DOES have a top-level narrators
            # (plain strings), but LibraryIndex only ever caches full detail
            # payloads, so that shape is never what reaches here.
            "narrators": _names((detail.get("audioMetadata") or {}).get("narrators")
                                 or detail.get("narrators")),
            "audible": (detail.get("providerIds") or {}).get("audible"),
            "kindle_asin": next(
                (t.split(":", 1)[1] for t in (detail.get("tags") or []) if t.startswith("asin:")),
                None),
            "formats": formats,
            "readalong": (detail.get("readAloudSync") or {}).get("state"),
            "folder": detail.get("folderPath"),
        }
