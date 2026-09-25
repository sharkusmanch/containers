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
import re
import time
import urllib.error
import urllib.request

from app import umbrella
from app.titles import surnames, title_keys

RELOGIN_AFTER_SECONDS = 600  # access token lives 900s
# BookOrbit login is throttled 5/min, shared with every other client. After a
# failed login no new login is attempted for this long (final review I5):
# callers get a clear error instead, rather than every request re-trying.
AUTH_RETRY_SECONDS = 300

# post() is read-adjacent only: /books/query is a search (POST because the
# filter body doesn't fit a query string), and the two auth endpoints are
# inherently POST. Every other write verb (patch/put/delete, and any other
# post path) is deleted/blocked -- see module docstring.
_ALLOWED_POST_PATHS = frozenset({"/books/query", "/auth/login", "/auth/refresh"})

REFRESH_INTERVAL_SECONDS = 15 * 60
FULL_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60
QUERY_PAGE_SIZE = 100


class BookorbitClient:
    def __init__(self, base_url, username, password, transport=None, cookie_path=None,
                 clock=time.time, writable: bool = False):
        self.base_url = base_url.rstrip("/")
        self._username = username
        self._password = password
        self._token = None
        self._token_obtained_at = 0.0
        self._clock = clock
        self._login_blocked_until = 0.0
        # Fix round 1 (Important #6): a plain BookorbitClient is read-only by
        # default -- _write() refuses regardless of path unless this is set.
        # Only the executor constructs a writable=True instance; the P1
        # read-only index client must never be able to reach _write at all.
        self._writable = writable

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
        return self._clock() - self._token_obtained_at

    @property
    def writable(self):
        return self._writable

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
        self._token_obtained_at = self._clock()
        self._save_cookies()

    def login(self):
        now = self._clock()
        if now < self._login_blocked_until:
            raise RuntimeError(
                f"BookOrbit login in cooldown after a failed attempt; next attempt allowed in "
                f"{int(self._login_blocked_until - now) + 1}s")
        try:
            data = self._call(
                "POST", "/auth/login",
                {"username": self._username, "password": self._password}, authorized=False)
        except Exception:
            self._login_blocked_until = self._clock() + AUTH_RETRY_SECONDS
            raise
        self._accept_token(data)

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

    # --- writes (Plan 2) --------------------------------------------------
    # Used ONLY by BookorbitWriter, a separate instance constructed by the
    # executor. get()/post() above are untouched -- the P1 read-only client
    # stays read-only. Every write goes through this one chokepoint so the
    # allowlist below is the single place that can ever mutate BookOrbit.
    def _write(self, method, path, payload=None):
        # Fix round 1 (Important #6): refuse outright unless this instance
        # was constructed with writable=True -- checked BEFORE the allowlist
        # so a stray writer bug can never fall through to "allowed path,
        # wrong client".
        if not self._writable:
            raise PermissionError(
                "this BookorbitClient was constructed without writable=True: "
                "writes are only permitted on the executor's dedicated writer "
                "client, never the P1 read-only index client")
        if not _write_path_allowed(method, path):
            raise PermissionError(
                f"{method} {path} is not permitted: not in the writer allowlist")
        self._ensure_fresh()
        if not self._token:
            raise RuntimeError("not authenticated: call authenticate() first")
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self._token,
        }
        body = json.dumps(payload).encode() if payload is not None else None
        status, text = self._transport(method, self.base_url + path, body, headers)
        if status >= 400:
            # Distinguishable from _call()'s RuntimeError so callers (namely
            # BookorbitWriter.scan()) can special-case 409 "scan already
            # running" without string-matching the body.
            raise BookorbitHTTPError(method, path, status, text)
        return json.loads(text) if text else {}


class BookorbitHTTPError(RuntimeError):
    """Raised by BookorbitClient._write() on any HTTP status >= 400, with the
    status code available for callers that need to distinguish e.g. 409
    (scan already running) from a hard failure.

    Callers should log/report `str(e)` only -- it already includes the
    method, path and status and truncates the body to 400 chars. `.body` is
    kept for callers that specifically need the raw response (e.g. surfacing
    `errorMessage` from a JSON error body), but is NOT pre-sanitized and may
    contain arbitrary server-supplied content.
    """

    def __init__(self, method, path, status, body):
        super().__init__(f"{method} {path} -> HTTP {status}: {(body or '')[:400]}")
        self.method = method
        self.path = path
        self.status = status
        self.body = body


class ScanError(RuntimeError):
    """Raised by BookorbitWriter when a scan fails or does not complete
    within the bounded wait. `kind` lets callers (the executor's guard/
    escalation path) branch without string-matching the message:
    - "failed": BookOrbit itself reported the scan as failed, or refused a
      retriggered scan a second time (still 409 after we already waited).
    - "timeout": we gave up waiting within the bounded window.
    """

    def __init__(self, message, *, kind):
        assert kind in ("failed", "timeout"), f"invalid ScanError kind: {kind!r}"
        super().__init__(message)
        self.kind = kind


# Writer allowlist (Plan 2 review amendment): only these method+path
# combinations may ever go through BookorbitClient._write. Everything else --
# including refresh-metadata, the ABS migration adapter, and any patch/
# delete/post outside this list -- is rejected, per the global constraints.
# `[0-9]+` (not `\d+`) so a Unicode decimal digit outside ASCII can't sneak
# a path past the allowlist; `fullmatch` (not `match`) so a trailing
# newline, extra path segment, query string or slash can't either -- `match`
# would have let `$` match just before a trailing "\n" and call that a full
# match, which it is not.
_WRITE_PATHS = (
    ("POST", re.compile(r"^/scanner/libraries/(?:7|8)/scan$")),
    ("POST", re.compile(r"^/books/[0-9]+/rename-files$")),
    ("PATCH", re.compile(r"^/books/[0-9]+/metadata-and-locks$")),
)


def _write_path_allowed(method, path):
    return any(method == m and rx.fullmatch(path) for m, rx in _WRITE_PATHS)


# Scan-history status values that mean "not running any more" (a running
# scan is presumed to report something outside this set, e.g. "running" /
# "in_progress" -- never compare on that value, only on membership here).
_TERMINAL_SCAN_STATUSES = frozenset({"completed", "failed"})

_WRITER_LIBRARY_IDS = frozenset({7, 8})
SCAN_HISTORY_PAGE = 20


# BookOrbit 3.0.0 `BOOK_METADATA_LOCK_FIELDS` (@bookorbit/types src/metadata-lock.ts),
# verbatim, minus `rating`. When a NEW file becomes a book's primary (a
# read-along, or an EPUB attached to an audio-only book), BookOrbit's scan
# re-extracts that file's embedded metadata into EVERY unlocked field and nulls
# what the file lacks: provider ids, page count, genres, tags, description, the
# cover... (scanner.service.ts processCandidate -> metadata.service.ts
# persistBookMetadata). Locked fields are skipped; nothing else prevents it.
# `rating` stays unlocked: the web UI's star widget PATCHes /metadata {rating}
# and gets 409 on a locked rating (the extraction's rating is not the one shown).
LOCK_FIELDS = (
    "title", "subtitle", "authors", "description", "publisher", "publishedYear", "language", "pageCount",
    "seriesName", "seriesIndex", "isbn13", "isbn10", "genres", "tags", "communityRating",
    "narrators", "durationSeconds", "abridged", "googleBooksId", "goodreadsId", "amazonId", "hardcoverId",
    "hardcoverEditionId", "openLibraryId", "itunesId", "audibleId", "librofmId", "koboId", "comicvineId",
    "ranobedbId", "lubimyczytacId", "aladinId", "comicIssueNumber", "comicVolumeName", "comicStoryArcs",
    "comicPencillers", "comicInkers", "comicColorists", "comicLetterers", "comicCoverArtists",
    "comicCharacters", "comicTeams", "comicLocations", "cover",
)
# What an audio file itself fills in: left unlocked while a book has no audio
# yet, so a later m4b attach can still set them.
AUDIO_FIELDS = ("narrators", "durationSeconds", "abridged", "audibleId", "librofmId")


class BookorbitWriter:
    """Tightly allowlisted write path for the executor (Task 2). Wraps an
    authenticated BookorbitClient instance that is separate from the P1
    read-only index client -- construct one only in the executor.
    """

    def __init__(self, client):
        # Fix round 1 (Important #6): construction-time guard, so a caller
        # can't accidentally wrap the P1 read-only client and only discover
        # the mistake at the first _write() call.
        if not getattr(client, "writable", False):
            raise ValueError(
                "BookorbitWriter requires a BookorbitClient constructed with "
                "writable=True (the executor's dedicated writer instance) -- "
                "the P1 read-only index client must never reach here")
        self._client = client

    def _check_library(self, library_id):
        if library_id not in _WRITER_LIBRARY_IDS:
            raise ValueError(
                f"library_id must be one of {sorted(_WRITER_LIBRARY_IDS)}: {library_id!r}")

    def _scan_history(self, library_id):
        # Task 9c (e): the default page is the newest 5 (scanner.controller.js
        # `DefaultValuePipe(5)`); BookOrbit 3.0.0 clamps `limit` to its
        # SCAN_HISTORY_LIMIT (10, scanner.service.js). Ids are global and the
        # list is newest-first, so a bigger page keeps our own scan visible
        # while other scans of the library finish.
        return self._client.get(f"/scanner/libraries/{library_id}/scan-history?limit={SCAN_HISTORY_PAGE}")

    def _max_history_id(self, library_id):
        history = self._scan_history(library_id)
        return max((h["id"] for h in history), default=0)

    def scan_running(self, library_id):
        self._check_library(library_id)
        history = self._scan_history(library_id)
        if not history:
            return False
        latest = max(history, key=lambda h: h["id"])
        return latest["status"] not in _TERMINAL_SCAN_STATUSES

    def _wait_until_idle(self, library_id, deadline, sleep, clock):
        """Poll until scan_running() is False, or raise ScanError once
        `clock()` reaches `deadline`. `deadline` (not a fresh `timeout`) is
        passed in so scan() can share ONE deadline across both of its
        potential waits -- see the fix-round-1 shared-deadline note there."""
        while self.scan_running(library_id):
            if clock() >= deadline:
                raise ScanError(
                    f"library {library_id} scan did not finish before the deadline",
                    kind="timeout")
            sleep(5)

    def wait_scan(self, library_id, after_id, timeout=1200, sleep=time.sleep,
                  clock=time.monotonic):
        """Wait for the first scan-history entry with id > after_id to reach
        a terminal status, and return it. Raises ScanError if it fails, or
        if none appears within `timeout` seconds. Never compares timestamps
        (clock skew) -- only ids and status."""
        self._check_library(library_id)
        deadline = clock() + timeout
        while True:
            history = self._scan_history(library_id)
            candidates = [
                h for h in history
                if h["id"] > after_id and h["status"] in _TERMINAL_SCAN_STATUSES
            ]
            if candidates:
                entry = min(candidates, key=lambda h: h["id"])
                if entry["status"] == "failed":
                    raise ScanError(
                        f"library {library_id} scan {entry['id']} failed: "
                        f"{entry.get('errorMessage')}", kind="failed")
                return entry
            if clock() >= deadline:
                raise ScanError(
                    f"library {library_id} scan did not complete within {timeout}s",
                    kind="timeout")
            sleep(5)

    def scan(self, library_id, timeout=1200, sleep=time.sleep, clock=time.monotonic):
        """Trigger a scan of `library_id`, returning the max scan-history id
        recorded immediately before the successful trigger (pass this as
        `after_id` to wait_scan() to wait for completion).

        If a scan is already running -- caught either up front via
        scan_running() or reactively via a 409 on the POST -- waits for it
        to finish, THEN records the max id and triggers.

        `timeout` bounds the WHOLE call, not each wait separately: both
        potential waits below share one `deadline` computed once at entry
        (fix round 1 #3) -- a proactive wait followed by a raced 409 can
        together wait at most `timeout` seconds, never up to 2x.
        """
        self._check_library(library_id)
        deadline = clock() + timeout
        scan_path = f"/scanner/libraries/{library_id}/scan"
        if self.scan_running(library_id):
            self._wait_until_idle(library_id, deadline, sleep, clock)
        max_id = self._max_history_id(library_id)
        try:
            self._client._write("POST", scan_path, {})
        except BookorbitHTTPError as e:
            if e.status != 409:
                raise
            self._wait_until_idle(library_id, deadline, sleep, clock)
            max_id = self._max_history_id(library_id)
            try:
                self._client._write("POST", scan_path, {})
            except BookorbitHTTPError as e2:
                # Fix round 1 #4: a second 409 here means BookOrbit is still
                # refusing to scan even after we waited out the first
                # running scan -- that's not something the caller can
                # retry its way out of, so surface it as ScanError like any
                # other scan failure rather than leaking a raw HTTP error.
                if e2.status == 409:
                    raise ScanError(
                        f"library {library_id} still refuses to scan (409) "
                        f"even after waiting for the previously-running scan "
                        f"to finish", kind="failed") from e2
                raise
        return max_id

    def rename_files(self, book_id):
        if type(book_id) is not int:
            raise TypeError(f"book_id must be an int, got {book_id!r}")
        return self._client._write("POST", f"/books/{book_id}/rename-files", {})

    def patch_metadata(self, book_id, metadata, locked):
        """PATCH /books/{id}/metadata-and-locks. NOTE (Task 9b probe): when
        `metadata` carries title/authors/seriesName/seriesIndex/publishedYear,
        BookOrbit (fileRenameEnabled) moves the book to its rendered pattern
        ~3 s AFTER this returns -- the response still shows the old path. The
        executor runs guard 8 before calling this and polls afterwards.

        lockedFields REPLACES the
        whole lock set server-side, so this always sends a fresh GET's
        current lockedFields unioned with the newly requested ones -- never
        drops an existing lock (e.g. a Kindle 'tags' lock).

        Fix round 1 (Important #1): a missing/null lockedFields on the fresh
        GET must NOT be silently treated as an empty list -- that would
        merge to just `locked` and the PATCH would replace-and-drop every
        existing lock. Refuse instead: no GET-shaped response, no PATCH.
        """
        if type(book_id) is not int:
            raise TypeError(f"book_id must be an int, got {book_id!r}")
        current = self._client.get(f"/books/{book_id}")
        current_locks = current.get("lockedFields")
        if not isinstance(current_locks, list):
            raise RuntimeError(
                f"refusing to PATCH metadata for book {book_id}: GET /books/{book_id} "
                f"returned lockedFields={current_locks!r} (not a list) -- patching "
                f"now would replace the whole lock set and could silently drop an "
                f"existing lock")
        merged = sorted(set(current_locks) | set(locked))
        return self._client._write(
            "PATCH", f"/books/{book_id}/metadata-and-locks",
            {"metadata": metadata, "lockedFields": merged})

    def lock_all(self, book_id, *, audio=True):
        """Lock every metadata field of `book_id` (keeping its current locks)
        BEFORE an import touches the book's folder -- see LOCK_FIELDS for why.
        `audio=False` leaves AUDIO_FIELDS alone (a book with no audio yet, or an
        m4b about to be attached: BookOrbit fills them from it). The locks
        stay: a curated book keeps its metadata through any later file change
        (editing a field in BookOrbit then means unlocking it first). Sends no
        metadata (the PATCH is strictly partial) and verifies with a fresh GET.
        True when it locked something, False when all were locked. Refuses,
        like patch_metadata, when the GET has no lock list."""
        if type(book_id) is not int:
            raise TypeError(f"book_id must be an int, got {book_id!r}")
        want = set(LOCK_FIELDS) if audio else set(LOCK_FIELDS) - set(AUDIO_FIELDS)
        current = self._client.get(f"/books/{book_id}").get("lockedFields")
        if not isinstance(current, list):
            raise RuntimeError(
                f"refusing to lock book {book_id}: GET /books/{book_id} returned "
                f"lockedFields={current!r} (not a list) -- the PATCH replaces the whole lock set")
        if want <= set(current):
            return False
        self._client._write("PATCH", f"/books/{book_id}/metadata-and-locks",
                            {"lockedFields": sorted(set(current) | want)})
        after = self._client.get(f"/books/{book_id}").get("lockedFields")
        missing = sorted((want | set(current)) - set(after if isinstance(after, list) else ()))
        if missing:                      # a requested lock, or one the book already had
            raise RuntimeError(f"book {book_id}: metadata locks did not take (missing {', '.join(missing[:6])})")
        return True


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


# BookOrbit's rename pattern prefixes a series index ("1. Thrawn.epub").
_FILE_INDEX_PREFIX_RE = re.compile(r"^\s*\d+(?:\.\d+)?\.\s+")


def _file_title_keys(detail) -> set[str]:
    """Title keys from the book's own file names. A book whose metadata
    title is a placeholder ("New James S. A. Corey Novella #1") often still
    carries the real title in its file name ("The Sins of Our Fathers (The
    Expanse) (2022).epub"); without these keys neither the dossier's
    candidate search nor `search_books` can ever surface it (Task 13 eval
    `sins-placeholder-title`)."""
    keys: set[str] = set()
    for f in detail.get("files") or []:
        name = f.get("filename") if isinstance(f, dict) else None
        if not isinstance(name, str) or not name:
            continue
        stem = os.path.splitext(os.path.basename(name))[0]
        stem = _FILE_INDEX_PREFIX_RE.sub("", stem)
        keys |= title_keys(stem)
    return keys


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
        # keys found only in the book's file names are reported separately
        # ("file-key:") so the model can weigh them as weaker evidence
        file_overlap = (title_key_set & _file_title_keys(detail)) - overlap
        if overlap or file_overlap:
            cand_surnames = surnames(_names(detail.get("authors")))
            has_surname = bool(surname_set & cand_surnames)
            for k in sorted(overlap):
                reasons.append(f"title-key:{k}")
            for k in sorted(file_overlap):
                reasons.append(f"file-key:{k}")
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

    def naming_settings(self, library_id):
        """Reads (Task 9c fix round 1) of what BookOrbit's renamer depends on:
        GET /libraries/{id} (fileNamingPattern, fileRenameEnabled,
        organizationMode) and GET /app-settings/cross-platform-path-
        sanitization ({"enabled": bool}, app-settings.controller.js)."""
        return {"library": self._client.get(f"/libraries/{int(library_id)}"),
                "sanitization": self._client.get("/app-settings/cross-platform-path-sanitization")}

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

        # Controller ruling: a title-key-only match (score 20, "kept only if
        # nothing better") is GLOBAL suppression -- if any candidate in the
        # full result set scores >=60 (title+surname, ISBN, or ASIN), every
        # score-20 candidate is dropped entirely, not merely outranked.
        if any(score >= 60 for score, _detail, _reasons in scored):
            scored = [t for t in scored if t[0] != 20]

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
            # every series the book is in, primary first (= series/series_index);
            # the others are extras such as an umbrella (The Cosmere #6)
            "series_memberships": [{"series": n, "index": i} for n, i in umbrella.memberships(detail)],
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
