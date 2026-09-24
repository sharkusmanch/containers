"""Test doubles for the read-along worker: a BookOrbit library over a tmp tree
whose scanner behaves like BookOrbit 3.0.0's -- a file is matched by PATH
first (a known path keeps its record, which is rewritten with whatever inode
now sits there), then by inode for a path it does not know (only when the
record's old path is gone), else it gets a new record. A record whose path
vanished and was not matched is pruned. The read-along (an EPUB whose content
starts with OVERLAY) becomes the primary, as selectPrimaryFile does."""
import copy
import os
import zipfile

from app.readalong.job import BookGone

OVERLAY = b"OVERLAY"


class FakeLibrary:
    def __init__(self, root, books_prefix="/books"):
        self.root = str(root)                  # this pod's view of BookOrbit's /books
        self.prefix = books_prefix
        self._books = {}
        self._next_id = 1000
        self.scans = 0
        self.running_scans = 0                 # scan_running() answers True this many times
        self.scan_fails = False
        self.hook_before_scan = None           # callable(fake) -> None, e.g. a concurrent change
        self.sync_pending = 0                  # detail() reports read-along sync "pending" this many times
        self.lock_fails = False                # lock_all() raises (BookOrbit down)
        self.lock_calls = []                   # (book id, the folder's file names at that moment)

    # setup -------------------------------------------------------------------
    def add_book(self, bid, rel_folder, files, library_id=7, **extra):
        """files: [(file_id, name, content_bytes)]; writes them to disk."""
        folder = os.path.join(self.root, rel_folder)
        os.makedirs(folder, exist_ok=True)
        recs = []
        for fid, name, data in files:
            p = os.path.join(folder, name)
            with open(p, "wb") as fh:
                fh.write(data)
            recs.append(self._record(fid, p))
        self._books[bid] = {"id": bid, "libraryId": library_id,
                           "folderPath": f"{self.prefix}/{rel_folder}", "files": recs,
                           "lockedFields": [], **extra}
        self._derive(self._books[bid])
        self._books[bid]["_primary"] = self._primary_id(self._books[bid])

    def _record(self, fid, path):
        st = os.stat(path)
        with open(path, "rb") as fh:
            head = fh.read(len(OVERLAY))
        fmt = os.path.splitext(path)[1].lstrip(".").lower()
        overlay = fmt == "epub" and (head == OVERLAY or (
            zipfile.is_zipfile(path) and any(n.endswith(".smil") for n in zipfile.ZipFile(path).namelist())))
        return {"id": fid, "filename": os.path.basename(path), "format": fmt, "role": "content",
                "sizeBytes": st.st_size, "_ino": st.st_ino, "mediaOverlay": {"available": overlay}}

    def _local(self, folder_path):
        return os.path.join(self.root, folder_path[len(self.prefix) + 1:])

    # BookOrbit 3.0.0: when a NEW file becomes the primary, the scan writes the
    # file's embedded metadata into every UNLOCKED field and nulls what it
    # lacks (scanner.service.ts processCandidate -> persistBookMetadata).
    EMBEDDED = {"description": "EMBEDDED BLURB", "genres": [], "tags": [], "pageCount": None,
                "publisher": "Embedded House", "hardcoverId": None, "goodreadsId": None, "googleBooksId": None}

    @staticmethod
    def _primary_id(b):
        return next((f["id"] for f in b["files"] if f["role"] == "primary"), None)

    def _extract(self, b):
        locked = set(b.get("lockedFields") or ())
        for k, v in self.EMBEDDED.items():
            if k not in locked:
                b[k] = copy.deepcopy(v)

    def lock_all(self, book_id, *, audio=True):
        """The writer's lock_all: every field locked, existing locks kept."""
        from app.bookorbit import AUDIO_FIELDS, LOCK_FIELDS
        LOCK_ALL = set(LOCK_FIELDS) if audio else set(LOCK_FIELDS) - set(AUDIO_FIELDS)
        if book_id not in self._books:
            raise BookGone(book_id)
        b = self._books[book_id]
        folder = self._local(b["folderPath"])
        self.lock_calls.append((book_id, sorted(os.listdir(folder)) if os.path.isdir(folder) else []))
        if self.lock_fails:
            raise RuntimeError("PATCH /books/%d/metadata-and-locks -> HTTP 502: bad gateway" % book_id)
        if set(LOCK_ALL) <= set(b["lockedFields"]):
            return False
        b["lockedFields"] = sorted(set(b["lockedFields"]) | set(LOCK_ALL))
        return True

    def _derive(self, b):
        ra = [f for f in b["files"] if f["mediaOverlay"]["available"]]
        epubs = [f for f in b["files"] if f["format"] == "epub"]
        prim = (ra or epubs or b["files"] or [None])[0]
        for f in b["files"]:
            f["role"] = "primary" if f is prim else "content"
        b["readAloudSync"] = ({"overlayFileId": ra[0]["id"], "state": "enabled"} if len(ra) == 1
                              else {"overlayFileId": None, "state": "unavailable"})

    # the API the worker uses ---------------------------------------------------------
    FIELD_ID = 2

    @property
    def client(self):
        return self

    def get(self, path):
        assert path == "/custom-metadata/fields", path
        return [{"id": self.FIELD_ID, "key": "read_along", "archivedAt": None}]

    def books(self):
        """/books/query list records: no libraryId, no folderPath, no filenames."""
        out = []
        for b in self.books_by_id():
            d = self.detail(b["id"])
            out.append({"id": d["id"], "title": d.get("title"), "updatedAt": d.get("updatedAt"),
                        "tags": d.get("tags", []), "customMetadata": d.get("customMetadata", []),
                        "files": [{k: f[k] for k in ("id", "format", "role", "sizeBytes", "mediaOverlay")}
                                  for f in d["files"]]})
        return out

    def books_by_id(self):
        return [self._books[k] for k in sorted(self._books)]

    def set_flag(self, book_id, fid, value):
        if book_id not in self._books:
            raise BookGone(book_id)
        self._books[book_id]["customMetadata"] = [{"fieldId": fid, "key": "read_along", "value": value}]

    def remove_book(self, bid):
        del self._books[bid]

    def detail(self, bid):
        if bid not in self._books:
            raise BookGone(bid)                 # what the job's BookOrbit adapter raises on a 404
        b = copy.deepcopy(self._books[bid])
        b.pop("_primary", None)
        for f in b["files"]:
            f.pop("_ino", None)
        if self.sync_pending > 0 and b["readAloudSync"]["state"] == "enabled":
            self.sync_pending -= 1
            b["readAloudSync"]["state"] = "pending"
        return b

    def scan_running(self, library_id):
        if self.running_scans > 0:
            self.running_scans -= 1
            return True
        return False

    def scan(self, library_id):
        if self.hook_before_scan:
            hook, self.hook_before_scan = self.hook_before_scan, None
            hook(self)
        self.scan_attempts = getattr(self, "scan_attempts", 0) + 1
        if self.scan_fails:
            raise RuntimeError("scan failed")
        self.scans += 1
        for b in self._books.values():
            if b["libraryId"] != library_id:
                continue
            folder = self._local(b["folderPath"])
            on_disk = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
            by_name = {f["filename"]: f for f in b["files"]}
            by_ino = {f["_ino"]: f for f in b["files"]}
            kept, created = [], set()
            for name in on_disk:
                p = os.path.join(folder, name)
                if not os.path.isfile(p):            # a sub-folder is not one of the book's files
                    continue
                st = os.stat(p)
                rec = by_name.get(name)
                if rec is None:                      # unknown path: inode, if its old path is gone
                    old = by_ino.get(st.st_ino)
                    if old and not os.path.exists(os.path.join(folder, old["filename"])):
                        rec = old
                if rec is None:
                    self._next_id += 1
                    rec = {"id": self._next_id}
                    created.add(rec["id"])
                rec.update({k: v for k, v in self._record(rec["id"], p).items() if k != "id"})
                kept.append(rec)
            b["files"] = kept                        # anything unmatched is pruned
            before = b.get("_primary")
            self._derive(b)
            now = self._primary_id(b)
            if now is not None and (now != before or now in created):
                self._extract(b)                     # a new primary: embedded metadata over unlocked fields
            b["_primary"] = now
