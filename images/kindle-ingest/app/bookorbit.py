"""BookOrbit API client.

Reached pod-to-pod inside the media namespace. Every failure mode maps onto one
of the pipeline's four outcomes, because the caller must never have to guess
whether a thing is retryable, terminal, or a human decision.

The upload stage is the only one that is not naturally idempotent: writing the
ledger after the POST means an interrupted upload re-uploads, and an
additive-only pipeline cannot self-heal from a duplicate. So callers must
reconcile (find_by_asin) before every POST.
"""
import os
import requests


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
        """Pagination is NESTED. Flat page/size params are silently replaced by
        zod defaults, which silently caps every query at the first 50 books."""
        r = self.s.post(
            f"{self.base}/api/v1/books/query",
            headers=self._headers(),
            json={"pagination": {"page": page, "size": size}},
            timeout=60,
        )
        self._raise_for(r.status_code, r.text)
        return (r.json() or {}).get("items", [])

    def find_by_asin(self, asin: str) -> dict | None:
        """Reconciliation key. Title matching is unusable: Amazon retitles books,
        so a retitled book would not match and would upload as a duplicate."""
        for b in self.query_books():
            if asin and asin in str(b.get("asin") or ""):
                return b
            for f in b.get("files") or []:
                if asin and asin in str(f.get("filename") or ""):
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
