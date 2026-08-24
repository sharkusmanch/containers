"""BookOrbit API client.

Reached pod-to-pod inside the media namespace. Every failure mode maps onto one
of the pipeline's four outcomes, because the caller must never have to guess
whether a thing is retryable, terminal, or a human decision.

The upload stage is the only one that is not naturally idempotent: writing the
ledger after the POST means an interrupted upload re-uploads, and an
additive-only pipeline cannot self-heal from a duplicate. So callers must
reconcile (find_by_asin) before every POST.
"""
import logging
import os
import requests

log = logging.getLogger("kindle-ingest")


class BookOrbitError(Exception):
    pass


class AuthExpired(BookOrbitError):
    """JWT expired mid-batch. Retryable: log in again and retry."""


class Duplicate(BookOrbitError):
    """The library already has this book. NOT a failure -- a human decision."""


class UploadRejected(BookOrbitError):
    """The server refused the artifact. Terminal; needs a human."""


class Transport(BookOrbitError):
    """5xx / connection fault. Retryable."""


class BookOrbit:
    def __init__(self, cfg, session=None):
        self.cfg = cfg
        self.base = cfg.bookorbit_url
        self.s = session or requests.Session()
        self._token: str | None = None
        self._upload_limit: int | None = None

    # --- auth -----------------------------------------------------------
    def login(self) -> str:
        r = self.s.post(
            f"{self.base}/api/v1/auth/login",
            json={"username": self.cfg.bookorbit_user, "password": self.cfg.bookorbit_pass},
            timeout=30,
        )
        if r.status_code >= 500:
            raise Transport(f"login {r.status_code}")
        if r.status_code != 200:
            raise BookOrbitError(f"login failed: {r.status_code}")
        tok = (r.json() or {}).get("accessToken") or (r.json() or {}).get("access_token")
        if not tok:
            raise BookOrbitError("login returned no access token")
        self._token = tok
        return tok

    def _headers(self) -> dict:
        if not self._token:
            self.login()
        return {"Authorization": f"Bearer {self._token}"}

    @staticmethod
    def _raise_for(status: int, body: str = "") -> None:
        if status == 401 or status == 403:
            raise AuthExpired(f"{status}")
        if status == 409:
            raise Duplicate(body[:200])
        if status >= 500:
            raise Transport(f"{status}")
        if status >= 400:
            raise UploadRejected(f"{status}: {body[:200]}")

    # --- queries --------------------------------------------------------
    def query_books(self, page: int = 0, size: int = 200) -> list[dict]:
        """One page. Pagination is NESTED: flat page/size params are silently
        replaced by zod defaults, which caps every query at the first 50 books.
        The envelope carries {items, page, size, total}."""
        r = self.s.post(
            f"{self.base}/api/v1/books/query",
            headers=self._headers(),
            json={"pagination": {"page": page, "size": size}},
            timeout=60,
        )
        self._raise_for(r.status_code, r.text)
        return (r.json() or {}).get("items", [])

    def iter_books(self, size: int = 200) -> list[dict]:
        """Every book, following `total` across pages.

        query_books alone returns one page, so a library larger than `size` left
        every book past the first page invisible to reconciliation -- observed
        live at total=205 with size=200.
        """
        out, page = [], 0
        while True:
            r = self.s.post(
                f"{self.base}/api/v1/books/query",
                headers=self._headers(),
                json={"pagination": {"page": page, "size": size}},
                timeout=60,
            )
            self._raise_for(r.status_code, r.text)
            body = r.json() or {}
            items = body.get("items") or []
            out.extend(items)
            total = body.get("total")
            if not items or total is None or len(out) >= total:
                return out
            page += 1

    @staticmethod
    def asin_tag(asin: str) -> str:
        return f"asin:{asin}"

    def set_metadata(self, book_id: int, title: str | None = None,
                     asin: str | None = None) -> None:
        """Give the book a readable title and a durable ASIN tag.

        BookOrbit derives a title from the uploaded filename, so `<ASIN>.<ext>`
        made every book display its ASIN. The tag is what reconciliation then
        matches on: it rides in the LIST response, so lookup stays one request
        per page, and unlike the title it survives metadata enrichment.
        """
        body: dict = {}
        if title:
            body["title"] = title
        if asin:
            body["tags"] = [self.asin_tag(asin)]
        if not body:
            return
        r = self.s.patch(f"{self.base}/api/v1/books/{book_id}/metadata",
                         headers=self._headers(), json=body, timeout=60)
        self._raise_for(r.status_code, r.text)

    def upload_limit_bytes(self) -> int:
        """The server's own upload ceiling, in bytes.

        max_upload_size_mb is an app setting stored in Postgres and editable in
        the UI, so a value compiled in here drifts the moment it is changed
        there -- which is exactly what happened: the pipeline assumed 500MB
        while the server had been raised to 2048MB. Ask the server instead.

        Cached for the life of this client, and any failure falls back to the
        configured value: a cosmetic lookup must never block an upload.
        """
        if self._upload_limit is not None:
            return self._upload_limit
        limit = self.cfg.max_upload_bytes
        try:
            r = self.s.get(f"{self.base}/api/v1/app-settings",
                           headers=self._headers(), timeout=30)
            self._raise_for(r.status_code, r.text)
            body = r.json()
            items = body if isinstance(body, list) else (
                body.get("items") or body.get("settings") or [])
            for it in items:
                if str(it.get("key")) == "max_upload_size_mb":
                    limit = int(str(it.get("value")).strip()) * 1024 * 1024
                    break
        except Exception as e:
            log.warning("could not read the server upload limit (%s); using %d",
                        str(e)[:80], limit)
        self._upload_limit = limit
        return limit

    def enrich(self, book_id: int) -> None:
        """Populate author/series/description and pull a cover off the file.

        Provider lookup keys off the title, so a book uploaded as <ASIN>.<ext>
        matched nothing and looked unfetched. Once set_metadata has given it a
        real title, a refresh finds it. The cover is separate: it is extracted
        from the file we just uploaded and needs no external service, so it is
        attempted even when the refresh fails.

        Both steps are cosmetic and independently best-effort: the book is
        already uploaded and verified before this runs.
        """
        for step in ("refresh-metadata", "re-extract-cover"):
            try:
                r = self.s.post(f"{self.base}/api/v1/books/{book_id}/{step}",
                                headers=self._headers(), json={}, timeout=180)
                self._raise_for(r.status_code, r.text)
            except Exception as e:
                log.warning("%s failed for #%s: %s", step, book_id, str(e)[:120])

    def find_by_asin(self, asin: str) -> dict | None:
        """Has this ASIN already been uploaded?

        This is the crash-recovery net for the window between a successful POST
        and the ledger write; the ledger is authoritative otherwise.

        Matching is on the title. The list endpoint returns files as
        {id, format, role, sizeBytes} with no filename, and carries no asin
        field, so neither is available here -- but we upload `<ASIN>.<ext>` and
        BookOrbit derives the title from the filename, so anything this pipeline
        uploaded is titled with the bare ASIN. Equality, not substring: a real
        book whose blurb mentions an ASIN must not count as a match. The
        filename/asin checks are kept in case the API starts returning them.

        Books uploaded by other means carry real titles and no ASIN anywhere,
        so they cannot be matched by any route -- for those the ledger, not
        this, is what prevents rework.
        """
        if not asin:
            return None
        tag = self.asin_tag(asin)
        for b in self.iter_books():
            if tag in (b.get("tags") or []):
                return b
            # Books uploaded before tagging are titled with the bare ASIN.
            if str(b.get("title") or "").strip() == asin:
                return b
            if asin in str(b.get("asin") or ""):
                return b
            for f in b.get("files") or []:
                if asin in str(f.get("filename") or ""):
                    return b
        return None

    def get_book(self, book_id: int) -> dict | None:
        r = self.s.get(f"{self.base}/api/v1/books/{book_id}", headers=self._headers(), timeout=30)
        if r.status_code == 404:
            return None
        self._raise_for(r.status_code, r.text)
        return r.json()

    # --- upload ---------------------------------------------------------
    def upload(self, path: str, library_id: int | None = None, folder_id: int | None = None) -> dict:
        lib = library_id if library_id is not None else self.cfg.library_id
        fol = folder_id if folder_id is not None else self.cfg.folder_id
        url = f"{self.base}/api/v1/libraries/{lib}/upload?folderId={fol}"
        with open(path, "rb") as fh:
            r = self.s.post(url, headers=self._headers(),
                            files={"file": (os.path.basename(path), fh)}, timeout=900)
        self._raise_for(r.status_code, r.text)
        return r.json()

    def verify(self, book_id: int, local_path: str) -> bool:
        """Condition 2 of the verification conjunction: the server holds a file
        whose size matches what we sent. Necessary, NOT sufficient -- the caller
        must also structurally check the artifact and the local archive."""
        b = self.get_book(book_id)
        if not b:
            return False
        files = b.get("files") or []
        if not files:
            return False
        want = os.path.getsize(local_path)
        return any((f.get("sizeBytes") or 0) == want for f in files)
