"""Executor tests: real LibraryIndex + real BookorbitWriter over a fake
BookOrbit transport, real filesystem moves on tmp_path roots.

The fake server simulates a library scan by walking the fake library root
(book-per-folder): a folder with files is one book; an existing book's file
list is re-synced, a new folder becomes a new book. It behaves the way the
Task 9b live probe showed BookOrbit 3.0.0 does:
  * the scan never renames;
  * a PATCH carrying a rename-relevant field schedules an ASYNC rename
    ~3 s later (debounced) -- the immediate read-back shows the old path;
  * a rename moves the folder to the rendered pattern (app.bo_render),
    renames the files, and removes the emptied old dir and its parent;
    a target folder/file that already exists makes it a silent no-op;
  * `rename-files` does the same rename synchronously and answers 204;
  * a scan that ADDS a book triggers a provider metadata fetch ~7 s later
    that overwrites every UNLOCKED field in `fetch` (a bogus series).
Time is the FakeClock (advanced only by the executor's sleeps). Every
scenario snapshots the library tree first and asserts that no pre-existing
path was removed or modified.
"""
import errno
import hashlib
import json
import os

import pytest

from app import bo_render
from app import executor as executor_mod
from app import states
from app.bookorbit import BookorbitClient, BookorbitWriter, LibraryIndex
from app.config import Settings
from app.executor import ExecResult, Executor, sha12
from app.store import Store

LIB_NAMES = {7: "Library", 8: "Kids Audiobooks"}


class Crash(BaseException):
    """Simulated process death: not an Exception, so nothing in the executor
    may swallow it."""


# --- fake BookOrbit -----------------------------------------------------------


class FakeBookorbit:
    def __init__(self, books_root):
        self.books_root = str(books_root)
        self.books = {}
        self.history = {7: [], 8: []}
        self.next_hist = 100
        self.next_book = 1000
        self.calls = []
        self.running_polls = {7: 0, 8: 0}   # pre-existing foreign scan: N polls "running"
        self.scan_polls_to_finish = 1       # our scan completes after this many history GETs
        self.scan_never_finishes = False
        self.scan_enabled = True             # False: scan completes but indexes nothing
        self.on_scan = None                  # hook(fake, library_id) after indexing
        self.clock = None                    # FakeClock; None = scheduled work is due at once
        self.auto_rename = True              # PATCH with a rename-relevant field -> async rename
        self.rename_delay = 3.0
        self.rename_noop = False             # every rename silently does nothing (204)
        self.fetch = {"seriesName": "The Arcanaeum", "seriesIndex": "3", "publishedYear": 1999}
        self.fetch_delay = 7.0
        self._due = []                       # [(due, kind, book_id)]
        self.rename_log = []                 # (book_id, "moved"|"skipped"|"unchanged", why)
        self.patch_bodies = []               # (time, book_id, body)
        self.renamed_away = set()            # dirs a rename moved or emptied
        # BookOrbit naming settings the executor checks before any PATCH/rename
        self.libraries = {lid: {"id": lid, "name": name, "fileRenameEnabled": True,
                                "fileNamingPattern": bo_render.PATTERN,
                                "organizationMode": "book_per_folder"}
                          for lid, name in LIB_NAMES.items()}
        self.sanitize = True
        self.fetch_log = []                  # (time, book_id)
        self.crash_on = {}                   # (method, path-suffix) -> exception to raise
        self.on_idle = None                  # hook(fake) when a foreign running scan ends
        self.on_patch = None                 # hook(fake, book) after a PATCH is applied
        self._pending = {}                   # hist id -> polls left

    # helpers --------------------------------------------------------------
    def add_book(self, bid, library_id, rel_folder, title, authors, files=(), **extra):
        lib = LIB_NAMES[library_id]
        folder = os.path.join(self.books_root, lib, rel_folder)
        os.makedirs(folder, exist_ok=True)
        entries = []
        for name, data in files:
            p = os.path.join(folder, name)
            with open(p, "wb") as f:
                f.write(data)
            entries.append(self._file_entry(p))
        b = {
            "id": bid, "libraryName": lib, "libraryId": library_id,
            "title": title, "subtitle": None,
            "authors": [{"id": i, "name": a, "sortName": a} for i, a in enumerate(authors)],
            "seriesName": None, "seriesIndex": None, "publishedYear": None, "language": "en",
            "providerIds": {"audible": None}, "tags": [], "lockedFields": [],
            "folderPath": f"/books/{lib}/{rel_folder}", "files": entries, "updatedAt": "u0",
        }
        b.update(extra)
        self.books[bid] = b
        return b

    @staticmethod
    def _file_entry(path):
        name = os.path.basename(path)
        return {"filename": name, "sizeBytes": os.path.getsize(path),
                "format": os.path.splitext(name)[1].lstrip(".").lower()}

    def _touch(self, b):
        b["updatedAt"] = f"u{self.next_hist}-{len(self.calls)}"

    def _local(self, folder_path):
        return self.books_root + folder_path[len("/books"):]

    def _index_library(self, library_id):
        if not self.scan_enabled:
            return
        lib = LIB_NAMES[library_id]
        root = os.path.join(self.books_root, lib)
        known = {self._local(b["folderPath"]): b for b in self.books.values()
                 if b["libraryName"] == lib}
        for dirpath, dirnames, filenames in os.walk(root):
            files = sorted(f for f in filenames)
            if not files:
                continue
            entries = [self._file_entry(os.path.join(dirpath, f)) for f in files]
            b = known.get(dirpath)
            if b is not None:
                if b["files"] != entries:
                    b["files"] = entries
                    self._touch(b)
                continue
            self.next_book += 1
            rel = os.path.relpath(dirpath, root)
            author = rel.split(os.sep)[0]
            stem = os.path.splitext(files[0])[0]
            self.books[self.next_book] = {
                "id": self.next_book, "libraryName": lib, "libraryId": library_id,
                "title": stem, "subtitle": None,
                "authors": [{"id": 1, "name": author, "sortName": author}],
                "seriesName": None, "seriesIndex": None, "publishedYear": None, "language": None,
                "providerIds": {"audible": None}, "tags": ["from-file"], "lockedFields": [],
                "folderPath": f"/books/{lib}/{rel}", "files": entries, "updatedAt": "new",
            }
            if self.fetch:
                self._schedule("fetch", self.next_book, self.fetch_delay)
        if self.on_scan:
            self.on_scan(self, library_id)

    def _now(self):
        return self.clock() if self.clock is not None else 0.0

    def _schedule(self, kind, bid, delay):
        self._due = [d for d in self._due if not (d[1] == kind and d[2] == bid)]   # debounce
        self._due.append((self._now() + delay, kind, bid))

    def _tick(self):
        now = self._now()
        due = sorted(d for d in self._due if self.clock is None or d[0] <= now)
        self._due = [d for d in self._due if d not in due]
        for _t, kind, bid in due:
            if bid not in self.books:
                continue
            if kind == "rename":
                self._rename_files(bid)
            elif kind == "fetch":
                b = self.books[bid]
                for k, v in self.fetch.items():
                    if k not in b["lockedFields"]:
                        b[k] = v
                self._touch(b)
                self.fetch_log.append((now, bid))

    def _try_rmdir(self, d):
        try:
            if not os.listdir(d):
                os.rmdir(d)
                self.renamed_away.add(d)
        except OSError:
            pass

    def _rename_files(self, bid):
        """BookOrbit's performRenameLocked, reduced to what the probe saw."""
        b = self.books[bid]
        lib = b["libraryName"]
        root = os.path.join(self.books_root, lib)
        authors = [a["name"] for a in b["authors"]]

        def render(f):
            stem, ext = os.path.splitext(f["filename"])
            return bo_render.render_book_path(authors, b.get("seriesName"), b.get("seriesIndex"),
                                              b["title"], ext, stem)
        primary = b["files"][0]
        rel = render(primary)
        old = self._local(b["folderPath"])
        new = os.path.normpath(os.path.join(root, os.path.dirname(rel)))
        names = {f["filename"]: os.path.basename(render(f)) for f in b["files"]}
        if len({n.lower() for n in names.values()}) != len(names):    # internal collision
            names = {f["filename"]: f["filename"] for f in b["files"]}
            names[primary["filename"]] = os.path.basename(rel)
        if new == old and all(k == v for k, v in names.items()):
            self.rename_log.append((bid, "unchanged", ""))
            return
        if self.rename_noop:
            self.rename_log.append((bid, "skipped", "rename_noop"))
            return
        if new != old and os.path.lexists(new):
            self.rename_log.append((bid, "skipped", "target folder exists"))
            return
        if new == old and any(k != v and os.path.lexists(os.path.join(old, v)) for k, v in names.items()):
            self.rename_log.append((bid, "skipped", "target file exists"))
            return
        if new != old:
            os.makedirs(os.path.dirname(new), exist_ok=True)
            os.rename(old, new)
            self.renamed_away.add(old)
        for k, v in names.items():
            if k != v:
                os.rename(os.path.join(new, k), os.path.join(new, v))
        if new != old:
            self._try_rmdir(old)
            self._try_rmdir(os.path.dirname(old))
        b["files"] = [self._file_entry(os.path.join(new, names[f["filename"]])) for f in b["files"]]
        b["folderPath"] = "/books/" + lib + "/" + os.path.relpath(new, root)
        self._touch(b)
        self.rename_log.append((bid, "moved", ""))

    # transport ------------------------------------------------------------
    def transport(self, method, url, body, headers):
        path = url.split("/api/v1", 1)[1]
        self.calls.append((method, path))
        self._tick()
        for (m, suffix), exc in list(self.crash_on.items()):
            if m == method and path.endswith(suffix):
                del self.crash_on[(m, suffix)]
                raise exc
        payload = json.loads(body) if body else None
        if path == "/auth/login":
            return 200, json.dumps({"accessToken": "tok"})
        if path == "/books/query":
            page = payload["pagination"]["page"]
            items = ([{"id": i, "updatedAt": b["updatedAt"]} for i, b in self.books.items()]
                     if page == 0 else [])
            return 200, json.dumps({"items": items, "total": len(self.books)})
        if path == "/app-settings/cross-platform-path-sanitization" and method == "GET":
            return 200, json.dumps({"enabled": self.sanitize})
        if path.startswith("/libraries/") and method == "GET":
            return 200, json.dumps(self.libraries[int(path.split("/")[2])])
        if path.startswith("/scanner/libraries/"):
            lib = int(path.split("?")[0].split("/")[3])
            if "/scan-history" in path:
                return 200, json.dumps(self._history(lib))
            if path.endswith("/scan") and method == "POST":
                if any(h["status"] == "running" for h in self.history[lib]):
                    return 409, "running"
                self.next_hist += 1
                self.history[lib].append({"id": self.next_hist, "status": "running"})
                self._pending[self.next_hist] = self.scan_polls_to_finish
                return 200, "{}"
        if path.startswith("/books/"):
            parts = path.split("/")
            bid = int(parts[2])
            if len(parts) == 3 and method == "GET":
                if bid not in self.books:
                    return 404, "nope"
                return 200, json.dumps(self.books[bid])
            if parts[3] == "rename-files" and method == "POST":
                self._rename_files(bid)
                return 204, ""
            if parts[3] == "metadata-and-locks" and method == "PATCH":
                b = self.books[bid]
                self.patch_bodies.append((self._now(), bid, payload))
                for k, v in payload["metadata"].items():
                    if k == "authors":
                        b["authors"] = [{"id": i, "name": n, "sortName": n} for i, n in enumerate(v)]
                    elif k == "audibleId":
                        b["providerIds"] = {"audible": v}
                    else:
                        b[k] = v
                b["lockedFields"] = list(payload["lockedFields"])
                if self.on_patch:
                    self.on_patch(self, b)
                self._touch(b)
                if self.auto_rename and any(k in payload["metadata"]
                                            for k in bo_render.RENAME_RELEVANT_FIELDS):
                    self._schedule("rename", bid, self.rename_delay)
                return 200, json.dumps(b)
        return 500, f"unhandled {method} {path}"

    def _history(self, lib):
        if self.running_polls[lib] > 0:
            self.running_polls[lib] -= 1
            if self.running_polls[lib] == 0 and self.on_idle:
                self.on_idle(self)
            return self.history[lib] + [{"id": 1, "status": "running"}]
        for h in self.history[lib]:
            if h["status"] == "running" and not self.scan_never_finishes:
                self._pending[h["id"]] -= 1
                if self._pending[h["id"]] <= 0:
                    self._index_library(lib)
                    h["status"] = "completed"
        return list(self.history[lib])

    def patches(self):
        return [c for c in self.calls if c[0] == "PATCH"]

    def renames(self):
        return [c for c in self.calls if c[1].endswith("/rename-files")]

    def scans(self):
        return [c for c in self.calls if c[0] == "POST" and c[1].endswith("/scan")]


class FakeClock:
    def __init__(self):
        self.t = 1_000_000.0
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


# --- harness ------------------------------------------------------------------


class Env:
    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.books_root = tmp_path / "books"
        self.intake = tmp_path / "intake"
        for d in ("libation", "kindle", "manual"):
            (self.intake / d).mkdir(parents=True)
        (self.books_root / "Library").mkdir(parents=True)
        (self.books_root / "Kids Audiobooks").mkdir(parents=True)
        (self.books_root / "Comics").mkdir(parents=True)
        (self.books_root / "Comics" / "keep.cbz").write_bytes(b"comic")
        self.fake = FakeBookorbit(self.books_root)
        self.clock = FakeClock()
        self.fake.clock = self.clock
        self.beats = 0
        self.stop = False
        self.settings = Settings(bookorbit_url="http://b/api/v1", bookorbit_user="u",
                                 bookorbit_pass="p", intake_root=str(self.intake),
                                 local_books_root=str(self.books_root), state_dir=str(tmp_path / "state"))
        self.arrivals = Store(str(tmp_path / "state" / "arrivals.jsonl"), "key", states.ARRIVAL_STATES)
        self._before = None

    def _beat(self):
        self.beats += 1

    def executor(self):
        ro = BookorbitClient("http://b/api/v1", "u", "p", transport=self.fake.transport,
                             cookie_path=str(self.tmp / "ro.txt"), clock=self.clock)
        ro.authenticate()
        wc = BookorbitClient("http://b/api/v1", "u", "p", transport=self.fake.transport,
                             cookie_path=str(self.tmp / "w.txt"), clock=self.clock, writable=True)
        wc.authenticate()
        index = LibraryIndex(ro, str(self.tmp / "state" / "idx.json"), path_prefix="/books",
                             local_root=str(self.books_root))
        index.refresh(now=self.clock(), force=True)
        return Executor(self.settings, BookorbitWriter(wc), index, self.arrivals,
                        clock=self.clock, sleep=self.clock.sleep, beat=self._beat,
                        stopping=lambda: self.stop)

    # arrivals ------------------------------------------------------------------
    def libation(self, asin="B0LIBATION", title="Some Book", extra=()):
        folder = self.intake / "libation" / f"{title} [{asin}]"
        folder.mkdir()
        (folder / f"{title}.m4b").write_bytes(b"A" * 5000)
        (folder / "cover.jpg").write_bytes(b"jpg")
        (folder / f"{title}.cue").write_bytes(b"cue")
        (folder / "meta.json").write_bytes(b"{}")
        (folder / "Guide.pdf").write_bytes(b"pdf")
        for name, data in extra:
            (folder / name).write_bytes(data)
        return self._arrival("libation", asin, folder, folder / f"{title}.m4b")

    def kindle(self, asin="B0KINDLE01"):
        k = self.intake / "kindle"
        (k / f"{asin}.epub").write_bytes(b"E" * 3000)
        sha = hashlib.sha256(b"E" * 3000).hexdigest()
        (k / f"{asin}.json").write_text(json.dumps({"asin": asin, "sha256": sha}))
        return self._arrival("kindle", asin, k / f"{asin}.epub", k / f"{asin}.epub")

    def _arrival(self, source, sid, path, primary):
        sha = hashlib.sha256(open(primary, "rb").read()).hexdigest()
        key = f"{source}:{sid}:{sha[:12]}"
        return self.arrivals.record(key, states.READY, source=source, source_id=sid,
                                    path=str(path), primary=str(primary), sha256=sha)

    # tree ------------------------------------------------------------------------
    def snapshot_tree(self):
        self._before = self._tree()

    def _tree(self):
        out = {}
        for dirpath, dirnames, filenames in os.walk(self.books_root):
            out[dirpath] = ("dir",)
            for f in filenames:
                p = os.path.join(dirpath, f)
                st = os.stat(p)
                out[p] = ("file", st.st_ino, st.st_size, st.st_mtime_ns)
        return out

    def assert_library_intact(self):
        """No pre-existing path removed or modified -- except by BookOrbit's
        own rename (the fake's), which may move a file (same inode, size and
        mtime, somewhere under the library) and drop the dirs it emptied."""
        assert self._before is not None
        after = self._tree()
        moved_sigs = {sig for sig in after.values() if sig[0] == "file"}
        for p, sig in self._before.items():
            if p not in after:
                if sig[0] == "file" and sig in moved_sigs:
                    continue
                if sig[0] == "dir" and p in self.fake.renamed_away:
                    continue
            assert p in after, f"pre-existing library path removed: {p}"
            assert after[p] == sig, f"pre-existing library path modified: {p}"


@pytest.fixture
def env(tmp_path):
    e = Env(tmp_path)
    yield e
    e.assert_library_intact()


def intent_attach(arrival, book_id, iid="r1:1"):
    return {"intent_id": iid, "kind": "attach", "arrival": arrival["key"],
            "payload": {"kind": "attach", "arrival": arrival["key"], "book_id": book_id, "reason": "x"}}


def intent_update_metadata(arrival, book_id, iid="r1:1", metadata=None, lock=None):
    md = metadata if metadata is not None else {"title": "Corrected Title"}
    lk = lock if lock is not None else ["title"]
    return {"intent_id": iid, "kind": "update_metadata", "arrival": arrival["key"],
            "payload": {"kind": "update_metadata", "arrival": arrival["key"], "book_id": book_id,
                        "metadata": md, "lock": lk, "reason": "correcting the series"}}


def intent_create(arrival, library="adult", iid="r1:1", **meta):
    md = {"title": "New Book", "authors": ["Jane Author"], "series": "Saga", "seriesIndex": 2,
          "publishedYear": 2020, "language": "en"}
    md.update(meta)
    return {"intent_id": iid, "kind": "create_book", "arrival": arrival["key"],
            "payload": {"kind": "create_book", "arrival": arrival["key"], "library": library,
                        "metadata": md, "reason": "x"}}


def attach_target(env, bid=7001, rel="Martha Wells/Artificial Condition", title="Artificial Condition",
                  files=(("Artificial Condition.epub", b"epub-bytes"),), **extra):
    return env.fake.add_book(bid, 7, rel, title, ["Martha Wells"], files=files, **extra)


def mark_filed(env, arr, book_id):
    """Fix round 1, Minor #2: execute_update now refuses to PATCH anything
    unless the arrival's own exec journal already shows a successful
    filing to `book_id` -- this stands that journal up directly (a real
    `ex.execute()` attach run is exercised elsewhere; this keeps
    execute_update's own tests focused on execute_update)."""
    env.arrivals.record(arr["key"], states.EXECUTING, exec={"outcome": {"state": "filed", "book_id": book_id}})
    return env.arrivals.get(arr["key"])


# --- states -------------------------------------------------------------------


def test_new_states_exist():
    assert states.EXECUTING == "executing" and states.EXECUTING in states.ARRIVAL_STATES
    assert states.EXECUTED == "executed" and states.EXECUTED in states.INTENT_STATES
    assert states.EXEC_FAILED == "exec-failed" and states.EXEC_FAILED in states.INTENT_STATES


# --- execute_update (Plan 2 Task 3) --------------------------------------------


def test_execute_update_patches_metadata_and_merges_locks(env):
    attach_target(env, lockedFields=["tags"])
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    intent = intent_update_metadata(arr, 7001, metadata={
        "title": "Artificial Condition (Fixed)", "series": "Murderbot Diaries", "seriesIndex": 2,
    }, lock=["title"])
    r = ex.execute_update(intent, arr, 7001)

    assert r.ok and r.state == "updated" and r.book_id == 7001, r.detail
    b = env.fake.books[7001]
    assert b["title"] == "Artificial Condition (Fixed)"
    assert b["seriesName"] == "Murderbot Diaries" and b["seriesIndex"] == "2"
    # merged, not replaced; every identity field written is locked (Task 9c)
    assert set(b["lockedFields"]) == {"tags", "title", "seriesName", "seriesIndex"}
    assert len(env.fake.patches()) == 1
    assert env.fake.scans() == [] and r.moves == []        # no file moves


def test_execute_update_waits_for_running_scan_before_patching(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()
    env.fake.running_polls[7] = 3

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001)

    assert r.ok, r.detail
    assert env.clock.sleeps.count(15) >= 3
    assert len(env.fake.patches()) == 1


def test_execute_update_rejects_non_filing_library_target(env):
    env.fake.books[9] = {
        "id": 9, "libraryName": "Comics", "libraryId": 3, "title": "Comic", "subtitle": None,
        "authors": [{"id": 1, "name": "X", "sortName": "X"}],
        "seriesName": None, "seriesIndex": None, "publishedYear": None, "language": None,
        "providerIds": {"audible": None}, "tags": [], "lockedFields": [],
        "folderPath": "/books/Comics/x", "files": [], "updatedAt": "u0",
    }
    arr = env.libation(title="Whatever")
    arr = mark_filed(env, arr, 9)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 9), arr, 9)

    assert not r.ok and r.state == "failed"
    assert "Comics" in r.detail
    assert env.fake.patches() == []


def test_execute_update_rejects_mismatched_book_id(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    # the arrival really did file to 9999 (matching the caller's argument);
    # the payload itself is stale and still names 7001
    arr = mark_filed(env, arr, 9999)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 9999)

    assert not r.ok and r.state == "failed"
    assert "book_id" in r.detail
    assert env.fake.patches() == []


def test_execute_update_no_writable_fields_fails(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    # defense in depth: policy.validate_shape now REJECTS narrators-only
    # metadata outright (fix round 1, Important), so this shape should
    # never reach the executor in practice -- it must still refuse to
    # PATCH rather than send an empty/no-op write if it somehow does.
    intent = intent_update_metadata(arr, 7001, metadata={"narrators": ["N"]}, lock=[])
    r = ex.execute_update(intent, arr, 7001)

    assert not r.ok and r.state == "failed"
    assert env.fake.patches() == []


def test_execute_update_read_back_mismatch_fails(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    def clobber(fake, b):
        b["title"] = "Something The PATCH Never Asked For"
    env.fake.on_patch = clobber

    intent = intent_update_metadata(arr, 7001, metadata={"title": "Intended Title"}, lock=[])
    r = ex.execute_update(intent, arr, 7001)

    assert not r.ok and r.state == "failed"
    assert "mismatch" in r.detail


# --- execute_update fix round 1: guard against a not-yet-filed / --
# --- wrong-book / wrong-kind caller (Minor #2) ---------------------------


def test_execute_update_rejects_wrong_kind(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    intent = intent_update_metadata(arr, 7001)
    intent["kind"] = "attach"   # not update_metadata -- the payload still is
    r = ex.execute_update(intent, arr, 7001)

    assert not r.ok and r.state == "failed"
    assert env.fake.patches() == []


def test_execute_update_rejects_payload_arrival_mismatch(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    other = env.kindle(asin="B0OTHERONE")
    arr = mark_filed(env, arr, 7001)
    mark_filed(env, other, 7001)
    ex = env.executor()
    env.snapshot_tree()

    intent = intent_update_metadata(other, 7001)   # payload.arrival = other's key
    r = ex.execute_update(intent, arr, 7001)        # but arrival_rec = arr

    assert not r.ok and r.state == "failed"
    assert env.fake.patches() == []


def test_execute_update_rejects_no_exec_journal(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")   # never marked filed
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001)

    assert not r.ok and r.state == "failed"
    assert "exec journal" in r.detail
    assert env.fake.patches() == []


def test_execute_update_rejects_non_filed_outcome(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    env.arrivals.record(arr["key"], states.EXECUTING,
                        exec={"outcome": {"state": "retryable", "book_id": 7001}})
    arr = env.arrivals.get(arr["key"])
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001)

    assert not r.ok and r.state == "failed"
    assert env.fake.patches() == []


def test_execute_update_rejects_journal_for_a_different_book(env):
    attach_target(env)
    attach_target(env, bid=7002, rel="Martha Wells/Other Book", title="Other Book",
                  files=(("Other Book.epub", b"e"),))
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7002)   # journal says a DIFFERENT book filed
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001)

    assert not r.ok and r.state == "failed"
    assert env.fake.patches() == []


# --- execute_update fix round 1: audibleId in the read-back (Minor #3) ---


def test_execute_update_audible_id_written_and_verified(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    intent = intent_update_metadata(arr, 7001, metadata={"audibleId": "B0CORRECT12"}, lock=[])
    r = ex.execute_update(intent, arr, 7001)

    assert r.ok and r.state == "updated", r.detail
    assert env.fake.books[7001]["providerIds"]["audible"] == "B0CORRECT12"


def test_execute_update_audible_id_read_back_mismatch_fails(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    def clobber(fake, b):
        b["providerIds"] = {"audible": "WRONGID0000"}
    env.fake.on_patch = clobber

    intent = intent_update_metadata(arr, 7001, metadata={"audibleId": "B0CORRECT12"}, lock=[])
    r = ex.execute_update(intent, arr, 7001)

    assert not r.ok and r.state == "failed"
    assert "audibleId" in r.detail


# --- attach -------------------------------------------------------------------


def test_attach_happy_path_files_scans_renames_and_cleans(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition", extra=(("Bonus.m4b", b"B" * 10),))
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert isinstance(r, ExecResult)
    assert r.ok and r.state == "filed" and r.book_id == 7001, r.detail
    folder = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    assert (folder / "Artificial Condition.m4b").stat().st_size == 5000
    assert r.moves == [(arr["primary"], str(folder / "Artificial Condition.m4b"), 5000)]
    assert len(env.fake.scans()) == 1 and len(env.fake.renames()) == 1
    assert env.fake.patches() == []            # nothing changed -> no guard-9 write
    # intake: arrival folder gone, staging gone, deletables deleted, rest supplemented
    assert not os.path.exists(arr["path"])
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))
    supp = env.intake / "_supplements" / "B0LIBATION"
    assert sorted(os.listdir(supp)) == ["Bonus.m4b", "Guide.pdf"]
    assert "Bonus.m4b" in r.detail and "Guide.pdf" in r.detail
    j = env.arrivals.get(arr["key"])
    assert j["state"] == states.EXECUTING and j["exec"]["step"] == "cleaned"
    assert j["exec"]["open"] is False and j["exec"]["outcome"]["state"] == "filed"
    assert env.beats > 0


def test_staged_primary_symlink_is_refused_and_never_linked(env):
    """Final review M2: the staged primary must itself be a regular file
    (lstat) -- a symlink in the intake could otherwise have its TARGET
    hard-linked into the library."""
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    outside = env.tmp / "outside.m4b"
    os.rename(arr["primary"], outside)
    os.symlink(outside, arr["primary"])              # same bytes, via a symlink
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "failed", r.detail
    assert "regular file" in r.detail
    folder = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    assert not (folder / "Artificial Condition.m4b").exists()
    assert os.path.islink(arr["primary"])            # restored to the intake
    assert env.fake.scans() == []


def test_link_into_the_library_never_follows_symlinks(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    seen = []
    real = os.link

    def link(src, dst, **kw):
        seen.append(kw)
        return real(src, dst, **kw)
    monkeypatch.setattr(executor_mod.os, "link", link)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed", r.detail
    assert seen and seen[0].get("follow_symlinks") is False


def test_attach_destination_collision_fails_without_moving(env):
    attach_target(env, files=(("Artificial Condition.epub", b"e"), ("Artificial Condition.m4b", b"old")))
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert not r.ok and r.state == "failed"
    assert "exists" in r.detail
    assert os.path.isfile(arr["primary"])          # arrival restored to where it was
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))
    assert env.fake.scans() == [] and r.moves == []


def test_attach_exdev_fails_and_never_copies(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    def boom(src, dst, *a, **k):
        raise OSError(errno.EXDEV, "Invalid cross-device link")
    monkeypatch.setattr(executor_mod.os, "link", boom)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "failed" and "EXDEV" in r.detail
    assert not (env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
                / "Artificial Condition.m4b").exists()
    assert os.path.isfile(arr["primary"])
    assert env.fake.scans() == []


def test_attach_waits_out_a_running_scan_then_proceeds(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.running_polls[7] = 3

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed", r.detail
    assert env.clock.sleeps.count(15) >= 3


def test_attach_scan_running_too_long_is_retryable_and_nothing_moves(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.running_polls[7] = 10_000

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "retryable" and not r.ok
    assert os.path.isfile(arr["primary"]) and r.moves == []
    assert sum(env.clock.sleeps) >= 600
    assert env.fake.scans() == []


def test_attach_sha_mismatch_fails(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    with open(arr["primary"], "ab") as f:
        f.write(b"tampered")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "failed" and "sha256" in r.detail
    assert os.path.isfile(arr["primary"])


def test_guard9_restores_identity_fields_changed_by_scan(env):
    attach_target(env, lockedFields=["tags"], seriesName="Murderbot Diaries", seriesIndex="2",
                  rel="Martha Wells/Murderbot Diaries/02. Artificial Condition",
                  files=(("02. Artificial Condition.epub", b"e"),))

    def clobber(fake, lib):
        b = fake.books[7001]
        b["title"] = "Artificial Condition (Unabridged)"
        b["seriesIndex"] = "7"
    env.fake.on_scan = clobber
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed", r.detail
    b = env.fake.books[7001]
    assert b["title"] == "Artificial Condition" and b["seriesIndex"] == "2"
    assert set(b["lockedFields"]) >= {"tags", "title", "subtitle", "description"}
    assert len(env.fake.patches()) == 1
    assert "restored" in r.detail


def test_after_move_errors_retry_four_times_then_fail_on_fifth(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.scan_enabled = False
    intent = intent_attach(arr, 7001)
    dst = env.books_root / "Library" / "Martha Wells" / "Artificial Condition" / "Artificial Condition.m4b"

    r = ex.execute(intent, arr, {})
    assert r.state == "retryable" and str(dst) in r.detail
    links = []
    real_link = os.link
    monkeypatch.setattr(executor_mod.os, "link", lambda *a, **k: links.append(a) or real_link(*a, **k))
    results = [r]
    for _ in range(4):
        env.arrivals.record(arr["key"], states.RETRYABLE)
        results.append(ex.execute(intent, env.arrivals.get(arr["key"]), {}))

    assert [x.state for x in results] == ["retryable"] * 4 + ["failed"]
    j = env.arrivals.get(arr["key"])["exec"]
    assert j["attempts"] == 5 and j["open"] is False
    assert links == [] and len(env.fake.scans()) == 1         # nothing moved or scanned again
    assert dst.is_file()                                     # never auto-moved back
    staging = env.intake / ".executing" / sha12(arr["key"])
    assert (staging / "cover.jpg").is_file()                 # no cleanup without verify
    assert env.fake.renames() == []


def test_rename_skipped_on_local_collision_and_escalated(env):
    # the target book lives in a non-canonical folder; the rendered folder
    # already exists on disk (some other, unindexed directory) -> skip rename
    attach_target(env, rel="Martha Wells/odd folder")
    other = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    other.mkdir(parents=True)
    (other / "stray.txt").write_bytes(b"x")
    env.fake.scan_enabled = True
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    # the stray folder is now "known" to the fake after the next scan; keep it out
    env.fake.on_scan = lambda fake, lib: [fake.books.pop(i) for i in list(fake.books)
                                          if fake.books[i]["folderPath"].endswith("/Artificial Condition")]
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed" and r.ok, r.detail
    assert r.escalate and "rename" in r.escalate
    assert env.fake.renames() == []
    assert (env.books_root / "Library" / "Martha Wells" / "odd folder" / "Artificial Condition.m4b").is_file()


def test_stop_flag_before_start_is_retryable_and_touches_nothing(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.stop = True

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "retryable"
    assert os.path.isfile(arr["primary"])
    assert env.fake.scans() == []


# --- create_book --------------------------------------------------------------


def test_create_book_locates_patches_and_renames(env):
    env.fake.add_book(50, 7, "Other Author/Other Book", "Other Book", ["Other Author"],
                      files=(("Other Book.epub", b"o"),))
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed", r.detail
    b = env.fake.books[r.book_id]
    assert b["title"] == "New Book" and b["seriesName"] == "Saga" and b["seriesIndex"] == "2"
    assert b["publishedYear"] == 2020 and b["language"] == "en"
    assert b["providerIds"]["audible"] == "B0NEWBOOK1"
    assert set(b["lockedFields"]) >= {"title", "subtitle", "description", "seriesName", "seriesIndex"}
    # BookOrbit's own async rename (after the PATCH) moved it into the pattern
    assert env.fake.renames() == []
    assert b["folderPath"] == "/books/Library/Jane Author/Saga/02. New Book"
    assert (env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b").is_file()
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    final = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b"
    assert r.moves == [(arr["primary"], str(final), 5000)]
    assert not made.exists()                      # our emptied [lib-] dir removed after rename
    patch = env.fake.patches()
    assert len(patch) == 1


def test_create_book_kindle_tags_asin_and_locks_tags_and_removes_sidecar(env):
    arr = env.kindle(asin="B0KINDLE01")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, title="Kindle Book", series=None, seriesIndex=None), arr, {})

    assert r.state == "filed", r.detail
    b = env.fake.books[r.book_id]
    assert "asin:B0KINDLE01" in b["tags"] and "from-file" in b["tags"]
    assert "tags" in b["lockedFields"]
    assert not (env.intake / "kindle" / "B0KINDLE01.json").exists()
    assert not (env.intake / "kindle" / "B0KINDLE01.epub").exists()
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))


def test_create_book_refuses_author_dir_that_is_a_book_folder(env):
    env.fake.add_book(60, 7, "Jane Author", "Loose Book", ["Jane Author"], files=(("x.epub", b"x"),))
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "failed" and "book folder" in r.detail
    assert os.path.isfile(arr["primary"])
    assert os.listdir(env.books_root / "Library" / "Jane Author") == ["x.epub"]


def test_create_book_kids_library(env):
    arr = env.libation(asin="B0KIDS0001", title="Kid Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, library="kids", title="Kid Book", series=None, seriesIndex=None),
                   arr, {})

    assert r.state == "filed", r.detail
    assert env.fake.books[r.book_id]["libraryName"] == "Kids Audiobooks"
    assert [c for c in env.fake.scans() if "/libraries/8/" in c[1]]


# --- crash-safe journal + resume ------------------------------------------------


def _crash_unlink_of(monkeypatch, needle):
    real = os.unlink

    def unlink(p, *a, **k):
        if needle in str(p):
            raise Crash()
        return real(p, *a, **k)
    monkeypatch.setattr(executor_mod.os, "unlink", unlink)


def _crash_between_link_and_unlink(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    _crash_unlink_of(monkeypatch, ".executing")
    with pytest.raises(Crash):
        ex.execute(intent_attach(arr, 7001), arr, {})
    monkeypatch.undo()
    rec = env.arrivals.get(arr["key"])
    assert rec["state"] == states.EXECUTING and rec["exec"]["step"] == "unlinked"
    return arr, rec


def test_resume_after_link_before_unlink_same_inode_completes_the_move(env, monkeypatch):
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    ex = env.executor()
    links = []
    real_link = os.link
    monkeypatch.setattr(executor_mod.os, "link", lambda *a, **k: links.append(a) or real_link(*a, **k))

    r = ex.resume(rec)

    assert r.state == "filed", r.detail
    assert [a for a in links if str(env.books_root) in str(a[1])] == []   # no second link into the library
    assert len(env.fake.scans()) == 1
    assert not os.path.exists(rec["exec"]["src"])
    assert os.path.isfile(r.moves[0][1])


def test_resume_after_link_before_unlink_different_inode_fails(env, monkeypatch):
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    dst = rec["exec"]["dst"]
    data = open(dst, "rb").read()
    os.unlink(dst)                        # test setup: replace with an unrelated copy
    with open(dst, "wb") as f:
        f.write(data)

    r = env.executor().resume(rec)

    assert r.state == "failed"
    assert rec["exec"]["src"] in r.detail and dst in r.detail
    assert os.path.isfile(rec["exec"]["src"]) and os.path.isfile(dst)
    assert env.fake.scans() == []


def _unlinks_recorded(monkeypatch):
    real = os.unlink
    calls = []

    def unlink(p, *a, **k):
        calls.append(str(p))
        return real(p, *a, **k)
    monkeypatch.setattr(executor_mod.os, "unlink", unlink)
    return calls


def test_resume_symlink_at_dst_pointing_to_src_fails_and_unlinks_nothing(env, monkeypatch):
    """Final review C1: os.path.samefile follows symlinks, so a symlink at
    dst pointing at src read as "our own hard link" and src -- the only
    real copy -- was unlinked. lstat identity + regular files only."""
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    src, dst = rec["exec"]["src"], rec["exec"]["dst"]
    os.unlink(dst)
    os.symlink(src, dst)
    calls = _unlinks_recorded(monkeypatch)

    r = env.executor().resume(rec)

    assert r.state == "failed", r.detail
    assert calls == []
    assert os.path.isfile(src) and not os.path.islink(src)
    assert os.path.islink(dst)
    assert env.fake.scans() == []


def test_resume_symlink_at_src_pointing_to_dst_fails_and_unlinks_nothing(env, monkeypatch):
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    src, dst = rec["exec"]["src"], rec["exec"]["dst"]
    os.unlink(src)
    os.symlink(dst, src)
    calls = _unlinks_recorded(monkeypatch)

    r = env.executor().resume(rec)

    assert r.state == "failed", r.detail
    assert calls == []
    assert os.path.islink(src) and os.path.isfile(dst)
    assert env.fake.scans() == []


def test_resume_same_inode_with_changed_content_fails_before_unlink(env, monkeypatch):
    """Same inode but the bytes are no longer the arrival's: re-hash dst
    against arrival.sha256 before the irreversible unlink."""
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    src, dst = rec["exec"]["src"], rec["exec"]["dst"]
    with open(dst, "ab") as f:
        f.write(b"tampered")
    calls = _unlinks_recorded(monkeypatch)

    r = env.executor().resume(rec)

    assert r.state == "failed", r.detail
    assert "sha256" in r.detail
    assert calls == []
    assert os.path.isfile(src) and os.path.isfile(dst)
    assert env.fake.scans() == []


def test_resume_dst_symlink_with_src_gone_fails(env, monkeypatch):
    """src absent, dst a symlink to a file with the arrival's bytes: never
    treated as a completed move (dst must be a regular file)."""
    arr, rec = _crash_between_link_and_unlink(env, monkeypatch)
    src, dst = rec["exec"]["src"], rec["exec"]["dst"]
    elsewhere = env.tmp / "elsewhere.m4b"
    os.link(dst, elsewhere)
    os.unlink(dst)
    os.unlink(src)
    os.symlink(elsewhere, dst)

    r = env.executor().resume(rec)

    assert r.state == "failed", r.detail
    assert os.path.islink(dst) and elsewhere.exists()
    assert env.fake.scans() == []


def test_resume_before_link_is_retryable_and_restores_arrival(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    def crash_link(*a, **k):
        raise Crash()
    monkeypatch.setattr(executor_mod.os, "link", crash_link)
    with pytest.raises(Crash):
        ex.execute(intent_create(arr), arr, {})
    monkeypatch.undo()

    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "linked"
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert made.is_dir()
    r = env.executor().resume(rec)

    assert r.state == "retryable"
    assert os.path.isfile(arr["primary"])        # back in the intake
    assert not made.exists()                     # own empty [lib-] dir removed


def test_resume_after_unlink_before_scan_continues_to_filed(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.crash_on[("POST", "/libraries/7/scan")] = Crash()
    with pytest.raises(Crash):
        ex.execute(intent_attach(arr, 7001), arr, {})

    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "scanned"
    r = env.executor().resume(rec)

    assert r.state == "filed" and r.book_id == 7001, r.detail
    assert r.moves and r.moves[0][2] == 5000
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))


def test_resume_after_scan_before_metadata_continues_create(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.crash_on[("PATCH", "/metadata-and-locks")] = Crash()
    with pytest.raises(Crash):
        ex.execute(intent_create(arr), arr, {})

    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "metadata" and rec["exec"]["book_id"]
    link_count = len([c for c in env.fake.scans()])
    r = env.executor().resume(rec)

    assert r.state == "filed", r.detail
    assert r.book_id == rec["exec"]["book_id"]
    assert env.fake.books[r.book_id]["title"] == "New Book"
    assert len(env.fake.scans()) == link_count     # no second scan, no second move
    assert len([b for b in env.fake.books.values() if b["title"] == "New Book"]) == 1


def test_scan_timeout_after_move_is_retryable_and_rescans_on_retry(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.scan_never_finishes = True

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "retryable" and r.moves
    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["open"] is True and rec["exec"]["step"] == "scanned"
    # the caller records RETRYABLE; a later retry of the same intent resumes
    env.arrivals.record(arr["key"], states.RETRYABLE)
    env.fake.scan_never_finishes = False
    ex2 = env.executor()
    r2 = ex2.execute(intent_attach(arr, 7001), env.arrivals.get(arr["key"]), {})

    assert r2.state == "filed", r2.detail
    assert r2.moves[0][0] == r.moves[0][0] and r2.moves[0][2] == r.moves[0][2]


def test_resume_of_closed_journal_returns_recorded_outcome(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    r = ex.execute(intent_attach(arr, 7001), arr, {})
    n = len(env.fake.calls)

    r2 = env.executor().resume(env.arrivals.get(arr["key"]))

    assert r2.state == r.state == "filed" and r2.book_id == 7001
    assert not [c for c in env.fake.calls[n:] if c[0] != "GET" and c[1] != "/books/query"
                and c[1] != "/auth/login"]


# --- more edges ----------------------------------------------------------------


def test_stop_after_move_leaves_open_journal_then_resume_files(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    real_scan = Executor._scan

    def scan_then_stop(self, ctx):
        real_scan(self, ctx)
        env.stop = True
    monkeypatch.setattr(Executor, "_scan", scan_then_stop)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "retryable" and r.moves
    rec = env.arrivals.get(arr["key"])
    # stop is honoured BEFORE the next step is journaled: the journal still
    # names the scan, so resume re-scans (harmless) rather than skipping it
    assert rec["exec"]["open"] is True and rec["exec"]["step"] == "scanned"
    monkeypatch.undo()
    env.stop = False
    r2 = env.executor().resume(rec)
    assert r2.state == "filed", r2.detail


def test_create_exdev_removes_own_empty_dir(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    monkeypatch.setattr(executor_mod.os, "link",
                        lambda *a, **k: (_ for _ in ()).throw(OSError(errno.EXDEV, "x")))

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "failed" and "EXDEV" in r.detail
    assert "empty author dir" in r.detail
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert not made.exists()
    assert os.path.isfile(arr["primary"])


def test_manual_folder_leftovers_go_to_supplements_nothing_deleted(env):
    folder = env.intake / "manual" / "My Upload"
    folder.mkdir()
    (folder / "book.epub").write_bytes(b"M" * 900)
    (folder / "notes.txt").write_bytes(b"n")
    (folder / "cover.jpg").write_bytes(b"j")
    arr = env._arrival("manual", "My Upload", folder, folder / "book.epub")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, title="Manual Book", series=None, seriesIndex=None), arr, {})

    assert r.state == "filed", r.detail
    supp = env.intake / "_supplements" / f"manual-{sha12(arr['key'])}"
    assert sorted(os.listdir(supp)) == ["cover.jpg", "notes.txt"]
    assert not folder.exists()


def test_execute_again_after_filed_replays_outcome(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    r = ex.execute(intent_attach(arr, 7001), arr, {})
    scans = len(env.fake.scans())

    r2 = ex.execute(intent_attach(arr, 7001), env.arrivals.get(arr["key"]), {})

    assert r2.state == "filed" and r2.book_id == r.book_id
    assert len(env.fake.scans()) == scans


def test_open_journal_for_another_intent_is_refused(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.scan_never_finishes = True
    assert ex.execute(intent_attach(arr, 7001), arr, {}).state == "retryable"

    r = ex.execute(intent_attach(arr, 7001, iid="r2:1"), env.arrivals.get(arr["key"]), {})

    assert r.state == "failed" and "open journal" in r.detail


def test_unlink_error_after_link_fails_without_unstaging(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    real = os.unlink

    def unlink(p, *a, **k):
        if ".executing" in str(p):
            raise PermissionError(errno.EACCES, "nope")
        return real(p, *a, **k)
    monkeypatch.setattr(executor_mod.os, "unlink", unlink)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "failed"
    j = env.arrivals.get(arr["key"])["exec"]
    assert os.path.isfile(j["src"]) and os.path.isfile(j["dst"])    # nothing restored
    assert j["src"] in r.detail and j["dst"] in r.detail
    assert not os.path.exists(arr["path"])
    assert env.fake.scans() == []


def test_partial_kindle_staging_is_restored(env, monkeypatch):
    arr = env.kindle(asin="B0KINDLE01")
    ex = env.executor()
    env.snapshot_tree()
    real = os.rename

    def rename(a, b, *x, **k):
        if str(a).endswith(".json"):
            raise PermissionError(errno.EACCES, "nope")
        return real(a, b, *x, **k)
    monkeypatch.setattr(executor_mod.os, "rename", rename)

    r = ex.execute(intent_create(arr, title="Kindle Book", series=None, seriesIndex=None), arr, {})

    monkeypatch.undo()
    assert r.state == "failed", r.detail          # EACCES is not transient
    assert (env.intake / "kindle" / "B0KINDLE01.epub").is_file()
    assert (env.intake / "kindle" / "B0KINDLE01.json").is_file()
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))


def test_execute_after_failed_post_move_replays_and_never_restages(env):
    attach_target(env)
    arr = env.kindle(asin="B0KINDLE01")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.scan_enabled = False
    intent = intent_attach(arr, 7001)
    intent["payload"]["book_id"] = 7001
    for _ in range(5):
        r = ex.execute(intent, env.arrivals.get(arr["key"]), {})
    assert r.state == "failed" and r.moves
    staged_side = env.intake / ".executing" / sha12(arr["key"]) / "B0KINDLE01.json"
    assert staged_side.is_file()

    r2 = ex.execute(intent, env.arrivals.get(arr["key"]), {})

    assert r2.state == "failed" and r2.detail == r.detail
    assert staged_side.is_file()
    assert not (env.intake / "kindle" / "B0KINDLE01.json").exists()


# --- fix round 1 ------------------------------------------------------------------


def test_normalised_readback_accepts_server_echo(env):
    def echo(fake, b):
        if b.get("title") == "New Book":
            b["title"] = " New Book "
        if b.get("seriesIndex") == "2":
            b["seriesIndex"] = "2.0"
    env.fake.on_patch = echo
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "filed", r.detail


def test_rename_skipped_when_it_would_nest_inside_another_book(env):
    env.fake.add_book(70, 7, "Frank Herbert/Dune", "Dune", ["Frank Herbert"],
                      files=(("Dune.epub", b"dune"),))
    arr = env.libation(asin="B0MESSIAH1", title="Dune Messiah")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, title="Dune Messiah", authors=["Frank Herbert"],
                                 series="Dune", seriesIndex=2), arr, {})

    assert r.state == "filed" and r.escalate and "book 70" in r.escalate, r.detail
    assert env.fake.renames() == []


def test_rename_skipped_when_another_book_would_nest_inside_ours(env):
    env.fake.add_book(71, 7, "Jane Author/Saga/02. New Book/Extras", "Extras", ["Jane Author"],
                      files=(("x.epub", b"x"),))
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "filed" and r.escalate and "book 71" in r.escalate, r.detail
    assert env.fake.renames() == []


def test_guard8_collision_from_index_data_only(env):
    attach_target(env, rel="Martha Wells/odd folder")
    # a differently-cased folder: absent on this case-sensitive disk at the
    # rendered path, so only the index comparison can catch it
    env.fake.add_book(72, 7, "martha wells/artificial condition/", "Other", ["x"],
                      files=(("o.epub", b"o"),))
    env.fake.books[72]["folderPath"] = "/books/Library/martha wells/artificial condition/"
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed" and r.escalate and "book 72" in r.escalate, r.detail
    assert env.fake.renames() == []


def test_locate_ambiguity_fails(env):
    def twin(fake, lib):
        new = [b for b in fake.books.values() if b["title"] == "New Book"]
        if new and 5555 not in fake.books:
            fake.books[5555] = dict(new[0], id=5555, folderPath="/books/Library/Elsewhere/Twin")
    env.fake.on_scan = twin
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "failed" and "exactly one" in r.detail
    assert env.fake.patches() == []


def _crash_at_scan_then_autorename(env, content=None):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.crash_on[("POST", "/libraries/7/scan")] = Crash()
    with pytest.raises(Crash):
        ex.execute(intent_attach(arr, 7001), arr, {})
    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "scanned"
    # BookOrbit's scan (fileRenameEnabled) renamed the file under us
    dst = rec["exec"]["dst"]
    renamed = os.path.join(os.path.dirname(dst), "AC renamed.m4b")
    os.rename(dst, renamed)
    if content is not None:
        with open(renamed, "wb") as f:
            f.write(content)
    env.fake._index_library(7)
    return arr, rec


def test_resume_at_scanned_with_both_paths_absent_locates_via_bookorbit(env):
    arr, rec = _crash_at_scan_then_autorename(env)
    scans = len(env.fake.scans())

    r = env.executor().resume(rec)

    assert r.state == "filed", r.detail
    assert len(env.fake.scans()) == scans            # verified via BookOrbit, no re-scan


def test_loose_locate_match_is_hash_verified(env):
    arr, rec = _crash_at_scan_then_autorename(env, content=b"Z" * 5000)   # same size, other bytes

    r = env.executor().resume(rec)

    assert r.state == "failed" and "sha256" in r.detail
    assert env.fake.renames() == []


def test_resume_at_renamed_step(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.crash_on[("POST", "/rename-files")] = Crash()
    with pytest.raises(Crash):
        ex.execute(intent_attach(arr, 7001), arr, {})
    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "renamed"

    r = env.executor().resume(rec)

    assert r.state == "filed", r.detail
    assert len(env.fake.scans()) == 1


def test_resume_at_cleaned_step(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    def crash(*a, **k):
        raise Crash()
    monkeypatch.setattr(executor_mod.fsops, "cleanup", crash)
    with pytest.raises(Crash):
        ex.execute(intent_attach(arr, 7001), arr, {})
    monkeypatch.undo()
    rec = env.arrivals.get(arr["key"])
    assert rec["exec"]["step"] == "cleaned"

    r = env.executor().resume(rec)

    assert r.state == "filed", r.detail
    assert not os.path.exists(env.intake / ".executing" / sha12(arr["key"]))
    assert len(env.fake.scans()) == 1 and len(env.fake.renames()) == 1


def test_execute_when_staging_dir_already_exists_fails_untouched(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    foreign = env.intake / ".executing" / sha12(arr["key"])
    foreign.mkdir(parents=True)
    (foreign / "leftover.bin").write_bytes(b"l")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "failed"
    assert os.path.isfile(arr["primary"])
    assert (foreign / "leftover.bin").read_bytes() == b"l"
    assert env.fake.scans() == []


def test_closed_moved_journal_refuses_a_different_intent_without_rewriting(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    ex.execute(intent_attach(arr, 7001), arr, {})
    before = env.arrivals.get(arr["key"])["exec"]

    r = ex.execute(intent_attach(arr, 7001, iid="r9:1"), env.arrivals.get(arr["key"]), {})

    assert r.state == "failed" and "refus" in r.detail
    assert env.arrivals.get(arr["key"])["exec"] == before


def test_cleanup_error_after_verified_filing_is_filed_with_escalation(env, monkeypatch):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    def boom(*a, **k):
        raise OSError(errno.EIO, "io")
    monkeypatch.setattr(executor_mod.fsops, "cleanup", boom)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed" and r.ok and r.escalate and "cleanup" in r.escalate


def test_enametoolong_before_move_is_failed(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    def mkdir(p, *a, **k):
        raise OSError(errno.ENAMETOOLONG, "File name too long")
    monkeypatch.setattr(executor_mod.os, "mkdir", mkdir)

    r = ex.execute(intent_create(arr), arr, {})

    monkeypatch.undo()
    assert r.state == "failed"
    assert os.path.isfile(arr["primary"])


def test_attach_snapshot_is_taken_after_the_guard2_wait(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.running_polls[7] = 2

    def human_edit(fake):
        fake.books[7001]["subtitle"] = "Murderbot 2"
        fake._touch(fake.books[7001])
    env.fake.on_idle = human_edit

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.state == "filed", r.detail
    assert env.fake.patches() == []                   # the human's edit is not reverted
    assert env.fake.books[7001]["subtitle"] == "Murderbot 2"


# --- final review M3: duplicate arrivals -------------------------------------------------------


def _duplicate(env, *, library_bytes=b"A" * 5000):
    attach_target(env, files=(("Artificial Condition.m4b", library_bytes),))
    arr = env.libation(title="Artificial Condition")          # m4b = b"A" * 5000
    rec = env.arrivals.record(arr["key"], states.DUPLICATE, book_id=7001)
    return rec


def test_duplicate_intake_copy_removed_after_library_copy_verified(env):
    rec = _duplicate(env)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.remove_duplicate(rec)

    assert r.state == "removed", r.detail
    assert not os.path.exists(rec["path"])
    assert not os.path.exists(env.intake / ".executing" / sha12(rec["key"]))
    assert sorted(os.listdir(env.intake / "_supplements" / "B0LIBATION")) == ["Guide.pdf"]
    assert env.fake.scans() == [] and env.fake.patches() == []
    # replay is a no-op
    env.arrivals.record(rec["key"], states.DUPLICATE, dup_removed=True)
    assert ex.remove_duplicate(env.arrivals.get(rec["key"])).state == "removed"


def test_duplicate_whose_library_file_differs_is_kept(env):
    rec = _duplicate(env, library_bytes=b"B" * 5000)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.remove_duplicate(rec)

    assert r.state == "failed", r.detail
    assert os.path.isfile(rec["primary"]) and os.path.isfile(os.path.join(rec["path"], "cover.jpg"))
    assert not os.path.exists(env.intake / ".executing" / sha12(rec["key"]))


def test_duplicate_whose_intake_copy_changed_is_kept(env):
    rec = _duplicate(env)
    with open(rec["primary"], "ab") as f:
        f.write(b"changed")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.remove_duplicate(rec)

    assert r.state == "failed", r.detail
    assert os.path.isfile(rec["primary"])
    assert not os.path.exists(env.intake / ".executing" / sha12(rec["key"]))


def test_duplicate_removal_resumes_a_staged_copy(env, monkeypatch):
    rec = _duplicate(env)
    ex = env.executor()
    env.snapshot_tree()
    _crash_unlink_of(monkeypatch, ".executing")
    with pytest.raises(Crash):
        ex.remove_duplicate(rec)
    monkeypatch.undo()
    assert os.path.isdir(env.intake / ".executing" / sha12(rec["key"]))

    r = env.executor().remove_duplicate(env.arrivals.get(rec["key"]))

    assert r.state == "removed", r.detail
    assert not os.path.exists(env.intake / ".executing" / sha12(rec["key"]))


# --- Task 9c: BookOrbit renames on PATCH; provider fetch after import ------------------

FULL_LOCKS = {"title", "subtitle", "description", "authors", "seriesName", "seriesIndex",
              "publishedYear", "language"}


def test_create_book_waits_for_the_provider_fetch_then_clears_and_locks_identity(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, series=None, seriesIndex=None, publishedYear=None), arr, {})

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    b = env.fake.books[r.book_id]
    # the fetch ran (bogus series) BEFORE our PATCH, which cleared it with nulls
    assert env.fake.fetch_log and env.fake.fetch_log[0][0] < env.fake.patch_bodies[0][0]
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert body["seriesName"] is None and body["seriesIndex"] is None
    assert b["seriesName"] is None and b["seriesIndex"] is None
    # Task 11: a year neither the intent nor the arrival's EPUB OPF supplies
    # is left out -- not nulled, not locked -- so the provider's year stands
    # (the ruling's accepted cost)
    assert "publishedYear" not in body and b["publishedYear"] == 1999
    assert set(b["lockedFields"]) >= FULL_LOCKS - {"publishedYear"}
    assert "publishedYear" not in b["lockedFields"]
    # BookOrbit's own async rename moved it; the executor never called rename-files
    assert env.fake.renames() == []
    final = env.books_root / "Library" / "Jane Author" / "New Book" / "New Book.m4b"
    assert final.is_file() and b["folderPath"] == "/books/Library/Jane Author/New Book"
    assert r.moves == [(arr["primary"], str(final), 5000)]
    assert not (env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]").exists()


def test_create_book_fetch_at_12s_lands_before_the_patch(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.fetch_delay = 12        # the slowest fetch the probe saw

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok, r.detail
    assert env.fake.fetch_log[0][0] < env.fake.patch_bodies[0][0]
    t_patch = env.fake.patch_bodies[0][0]
    assert t_patch - env.fake.fetch_log[0][0] >= 20            # waited out the quiet window
    assert env.fake.books[r.book_id]["seriesName"] == "Saga"


def test_a_fetch_after_the_patch_cannot_overwrite_locked_identity(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.fetch_delay = 200       # beyond FETCH_MAX: lands after our PATCH

    r = ex.execute(intent_create(arr), arr, {})
    assert r.ok and not r.escalate, r.detail
    env.clock.t += 300
    env.fake.transport("GET", f"http://b/api/v1/books/{r.book_id}", None, {})
    b = env.fake.books[r.book_id]
    assert env.fake.fetch_log                                  # it did run
    assert (b["seriesName"], b["seriesIndex"], b["publishedYear"]) == ("Saga", "2", 2020)


def test_create_book_collision_is_checked_before_any_patch(env):
    # an unindexed directory already sits at the folder BookOrbit would render
    stray = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book"
    stray.mkdir(parents=True)
    (stray / "stray.txt").write_bytes(b"x")
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.fake.on_scan = lambda fake, lib: [fake.books.pop(i) for i in list(fake.books)
                                          if fake.books[i]["folderPath"].endswith("/02. New Book")]
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and r.escalate, r.detail
    assert "02. New Book" in r.escalate and "not written" in r.escalate
    assert env.fake.patches() == [] and env.fake.renames() == []
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert (made / "New Book.m4b").is_file()          # left filed where it is


def test_create_book_nesting_collision_blocks_the_patch(env):
    env.fake.add_book(70, 7, "Frank Herbert/Dune", "Dune", ["Frank Herbert"],
                      files=(("Dune.epub", b"dune"),))
    arr = env.libation(asin="B0MESSIAH1", title="Dune Messiah")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, title="Dune Messiah", authors=["Frank Herbert"],
                                 series="Dune", seriesIndex=2), arr, {})

    assert r.state == "filed" and r.escalate and "book 70" in r.escalate, r.detail
    assert env.fake.patches() == [] and env.fake.renames() == []


def test_create_book_silent_rename_noop_is_attention(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.rename_noop = True

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and r.escalate, r.detail
    assert "Saga/02. New Book" in r.escalate
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert (made / "New Book.m4b").is_file()
    assert len(env.fake.patches()) == 1 and env.fake.renames() == []
    assert max(env.clock.sleeps) <= 5 and sum(s for s in env.clock.sleeps if s == 3) <= 93


def test_create_book_rename_slower_than_the_settle_window_is_attention(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.rename_delay = 500

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and r.escalate and "02. New Book" in r.escalate, r.detail


def test_create_book_waits_for_the_async_rename_to_settle(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.rename_delay = 40            # slow, but inside the 90 s window

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and not r.escalate, r.detail
    final = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b"
    assert final.is_file() and r.moves[0][1] == str(final)
    assert 3 in env.clock.sleeps


def test_create_book_stop_during_settle_is_retryable_then_resumes(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    def stop_after_patch(fake, b):
        env.stop = True
    env.fake.on_patch = stop_after_patch

    r = ex.execute(intent_create(arr), arr, {})
    assert r.state == "retryable", r.detail
    env.stop = False
    env.fake.on_patch = None
    rec = env.arrivals.get(arr["key"])
    r2 = ex.resume(rec)
    assert r2.ok and r2.state == "filed" and not r2.escalate, r2.detail
    final = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b"
    assert final.is_file()


def test_guard9_restore_locks_the_restored_fields_and_settles(env):
    attach_target(env, rel="Martha Wells/Murderbot Diaries/02. Artificial Condition",
                  seriesName="Murderbot Diaries", seriesIndex="2",
                  files=(("02. Artificial Condition.epub", b"e"),))

    def clobber(fake, lib):
        fake.books[7001]["seriesIndex"] = "7"
    env.fake.on_scan = clobber
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    b = env.fake.books[7001]
    assert b["seriesIndex"] == "2"
    assert set(b["lockedFields"]) >= {"seriesName", "seriesIndex", "title", "subtitle", "description"}
    folder = env.books_root / "Library" / "Martha Wells" / "Murderbot Diaries" / "02. Artificial Condition"
    assert (folder / "02. Artificial Condition.m4b").is_file()        # pattern name
    assert b["folderPath"].endswith("/02. Artificial Condition")


def test_guard9_restore_collision_skips_the_patch_and_rename(env):
    # the book sits in a non-canonical folder; restoring its title would make
    # BookOrbit move it onto an existing (unindexed) directory
    attach_target(env, rel="Martha Wells/odd folder")
    stray = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    stray.mkdir(parents=True)
    (stray / "stray.txt").write_bytes(b"x")

    def clobber(fake, lib):
        for i in [i for i in fake.books if fake.books[i]["folderPath"].endswith("/Artificial Condition")]:
            fake.books.pop(i)
        fake.books[7001]["title"] = "Artificial Condition (Unabridged)"
    env.fake.on_scan = clobber
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.ok and r.state == "filed" and r.escalate and "not written" in r.escalate, r.detail
    assert env.fake.patches() == [] and env.fake.renames() == []
    assert (env.books_root / "Library" / "Martha Wells" / "odd folder" / "Artificial Condition.m4b").is_file()


def test_attach_rename_files_that_does_nothing_is_attention(env):
    attach_target(env)
    src = env.intake / "manual" / "weird name.m4b"
    src.write_bytes(b"M" * 4000)
    arr = env._arrival("manual", "weird name", src, src)
    ex = env.executor()
    env.snapshot_tree()
    env.fake.rename_noop = True
    arr_name = "weird name.m4b"

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.ok and r.state == "filed" and r.escalate and "pattern" in r.escalate, r.detail
    assert len(env.fake.renames()) == 1
    folder = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    assert (folder / arr_name).is_file()


def test_attach_file_takes_the_pattern_name(env):
    attach_target(env)
    arr = env.intake / "manual" / "weird name.m4b"
    arr.write_bytes(b"M" * 4000)
    rec = env._arrival("manual", "weird name", arr, arr)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(rec, 7001), rec, {})

    assert r.ok and not r.escalate, r.detail
    folder = env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
    assert (folder / "Artificial Condition.m4b").stat().st_size == 4000
    assert r.moves[0][1] == str(folder / "Artificial Condition.m4b")


def test_execute_update_collision_refuses_to_patch(env):
    attach_target(env)
    env.fake.add_book(80, 7, "Martha Wells/Murderbot Diaries/02. Artificial Condition", "Other",
                      ["Martha Wells"], files=(("o.epub", b"o"),))
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(
        arr, 7001, metadata={"series": "Murderbot Diaries", "seriesIndex": 2}, lock=[]), arr, 7001)

    assert r.state == "failed" and "book 80" in r.detail and "not written" in r.detail, r.detail
    assert env.fake.patches() == []


def test_execute_update_locks_identity_it_sets_and_verifies_the_move(env):
    attach_target(env, lockedFields=["tags"])
    arr = env.libation(title="Artificial Condition")
    env.arrivals.record(arr["key"], states.EXECUTING, exec={"outcome": {
        "state": "filed", "book_id": 7001,
        "moves": [[arr["primary"], str(env.books_root / "Library" / "Martha Wells" / "Artificial Condition"
                                       / "Artificial Condition.epub"), 10]]}})
    arr = env.arrivals.get(arr["key"])
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(
        arr, 7001, metadata={"series": "Murderbot Diaries", "seriesIndex": 2}, lock=[]), arr, 7001)

    assert r.ok and r.state == "updated" and not r.escalate, r.detail
    b = env.fake.books[7001]
    assert set(b["lockedFields"]) >= {"tags", "seriesName", "seriesIndex"}
    assert b["folderPath"] == "/books/Library/Martha Wells/Murderbot Diaries/02. Artificial Condition"


def test_execute_update_rename_noop_is_updated_with_attention(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()
    env.fake.rename_noop = True

    r = ex.execute_update(intent_update_metadata(
        arr, 7001, metadata={"series": "Murderbot Diaries", "seriesIndex": 2}, lock=[]), arr, 7001)

    assert r.ok and r.state == "updated" and r.escalate and "02. Artificial Condition" in r.escalate


# --- Task 9c fix round 1 ------------------------------------------------------------------


def settings_gets(env):
    return [c for c in env.fake.calls if c[0] == "GET" and
            (c[1].startswith("/libraries/") or c[1].startswith("/app-settings/"))]


def test_changed_naming_pattern_pauses_the_create_patch(env, caplog):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.libraries[7]["fileNamingPattern"] = "{authors:first}/{title}"

    with caplog.at_level("WARNING"):
        r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and r.escalate, r.detail
    assert "naming settings changed" in r.escalate and "paused" in r.escalate
    assert env.fake.patches() == [] and env.fake.renames() == []
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert (made / "New Book.m4b").is_file()
    assert sum("naming settings changed" in m for m in caplog.messages) == 1


@pytest.mark.parametrize("change", [
    lambda f: f.libraries[7].update(fileRenameEnabled=False),
    lambda f: f.libraries[7].update(organizationMode="book_per_file"),
    lambda f: f.libraries[7].update(fileNamingPattern=None),
    lambda f: setattr(f, "sanitize", False),
])
def test_changed_naming_settings_refuse_the_attach_rename(env, change):
    attach_target(env)
    src = env.intake / "manual" / "weird name.m4b"
    src.write_bytes(b"M" * 4000)
    arr = env._arrival("manual", "weird name", src, src)
    ex = env.executor()
    env.snapshot_tree()
    change(env.fake)

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.ok and r.state == "filed" and r.escalate and "naming settings changed" in r.escalate
    assert env.fake.renames() == [] and env.fake.patches() == []
    assert (env.books_root / "Library" / "Martha Wells" / "Artificial Condition" / "weird name.m4b").is_file()


def test_changed_naming_settings_fail_execute_update_without_patching(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()
    env.fake.sanitize = False

    r = ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001)

    assert r.state == "failed" and "naming settings changed" in r.detail
    assert env.fake.patches() == []


def test_naming_settings_are_cached_for_at_most_ten_minutes(env, caplog):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    assert ex.execute_update(intent_update_metadata(arr, 7001), arr, 7001).ok
    n = len(settings_gets(env))
    assert n == 2                                             # library + sanitisation setting
    assert ex.execute_update(intent_update_metadata(arr, 7001, metadata={"title": "Again"}),
                             arr, 7001).ok
    assert len(settings_gets(env)) == n                       # cached
    env.clock.t += 601
    assert ex.execute_update(intent_update_metadata(arr, 7001, metadata={"title": "Third"}),
                             arr, 7001).ok
    assert len(settings_gets(env)) == 2 * n                   # re-read after 10 min


def test_stored_series_index_string_is_rendered_verbatim(env):
    """A stored "2.50" renders "02.50." in BookOrbit; normalising it to 2.5
    first would predict "02.5." and flag a correct move as misplaced."""
    attach_target(env, rel="Martha Wells/Murderbot Diaries/02.50. Artificial Condition",
                  seriesName="Murderbot Diaries", seriesIndex="2.50",
                  files=(("02.50. Artificial Condition.epub", b"e"),))
    arr = env.libation(title="Artificial Condition")
    arr = mark_filed(env, arr, 7001)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute_update(intent_update_metadata(arr, 7001, metadata={"title": "Artificial Condition II"}),
                          arr, 7001)

    assert r.ok and r.state == "updated" and not r.escalate, r.detail
    assert env.fake.books[7001]["folderPath"] == \
        "/books/Library/Martha Wells/Murderbot Diaries/02.50. Artificial Condition II"


def test_guard9_restores_the_stored_series_index_string_verbatim(env):
    attach_target(env, rel="Martha Wells/Murderbot Diaries/02.50. Artificial Condition",
                  seriesName="Murderbot Diaries", seriesIndex="2.50",
                  files=(("02.50. Artificial Condition.epub", b"e"),))
    env.fake.on_scan = lambda fake, lib: fake.books[7001].update(seriesIndex="7")
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    assert r.ok and not r.escalate, r.detail
    assert env.fake.patch_bodies[0][2]["metadata"]["seriesIndex"] == "2.50"
    assert env.fake.books[7001]["folderPath"].endswith("/02.50. Artificial Condition")


def test_create_payload_and_render_normalise_whitespace_like_bookorbit(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, authors=["Jane\u00a0 Author"], series="The  Saga"), arr, {})

    assert r.ok and not r.escalate, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert body["authors"] == ["Jane Author"] and body["seriesName"] == "The Saga"
    assert env.fake.books[r.book_id]["folderPath"] == "/books/Library/Jane Author/The Saga/02. New Book"


# --- Task 11: NFS lookup-cache lag after BookOrbit's move; stale placement notes --------------


class StaleNfsView:
    """The librarian pod's NFS client as the go-live canary met it.

    A lookup the LIBRARIAN makes under the library root that finds nothing
    caches a negative entry for the first missing path component -- guard
    8's `lexists` of the folder BookOrbit is about to move the book into
    does exactly that. Every later lookup through that component answers
    ENOENT from the cache, although BookOrbit (another NFS client) has since
    created it, until the component's parent directory is listed
    (`listing_revalidates`: opening a directory forces a GETATTR, and a
    changed directory drops its negative entries) or the entry is
    `expire_after` s old on the FakeClock (the attribute-cache timeout;
    None = never). The librarian's own mkdir/link replace an entry at once,
    as they do on NFS. Filesystem calls made while the fake BookOrbit runs
    (anything under its transport) are the other client: they see the
    real disk and never touch the cache."""

    def __init__(self, env, monkeypatch, *, listing_revalidates=True, expire_after=None):
        self.root = str(env.books_root)
        self.clock = env.clock
        self.listing_revalidates = listing_revalidates
        self.expire_after = expire_after
        self.negative = {}            # path -> FakeClock time the miss was cached
        self.recorded = []            # every entry ever cached, in order
        self.revalidated = []         # directories whose listing dropped an entry
        self.hidden = 0               # lookups answered ENOENT from the cache
        self._server = 0
        self._real = {n: getattr(os, n) for n in ("lstat", "stat", "listdir", "mkdir", "link")}
        transport = env.fake.transport

        def server_side(*a, **k):
            self._server += 1
            try:
                return transport(*a, **k)
            finally:
                self._server -= 1

        monkeypatch.setattr(env.fake, "transport", server_side)
        monkeypatch.setattr(os, "lstat", self._lookup(self._real["lstat"]))
        monkeypatch.setattr(os, "stat", self._lookup(self._real["stat"]))
        monkeypatch.setattr(os, "listdir", self._listdir)
        monkeypatch.setattr(os, "mkdir", self._create(self._real["mkdir"], 0))
        monkeypatch.setattr(os, "link", self._create(self._real["link"], 1))

    def _mine(self, path):
        """`path` normalised if this client's view applies to it, else None."""
        if self._server or isinstance(path, int):
            return None
        try:
            p = os.fspath(path)
        except TypeError:
            return None
        if not isinstance(p, str):
            return None
        p = os.path.normpath(p if os.path.isabs(p) else os.path.join(os.getcwd(), p))
        return p if p.startswith(self.root + os.sep) else None

    def _cached(self, p):
        for n, t in list(self.negative.items()):
            if self.expire_after is not None and self.clock() - t >= self.expire_after:
                del self.negative[n]
            elif p == n or p.startswith(n + os.sep):
                return n
        return None

    def _remember_miss(self, p):
        cur = self.root
        for part in os.path.relpath(p, self.root).split(os.sep):
            cur = os.path.join(cur, part)
            try:
                self._real["lstat"](cur)
            except FileNotFoundError:
                if cur not in self.negative:
                    self.negative[cur] = self.clock()
                    self.recorded.append(cur)
                return
            except OSError:
                return

    def _hide(self, path):
        self.hidden += 1
        raise FileNotFoundError(errno.ENOENT, "No such file or directory (NFS lookup cache)", path)

    def _lookup(self, real_fn):
        def fn(path, *a, **k):
            p = self._mine(path)
            if p is None:
                return real_fn(path, *a, **k)
            if self._cached(p) is not None:
                self._hide(path)
            try:
                return real_fn(path, *a, **k)
            except FileNotFoundError:
                self._remember_miss(p)
                raise
        return fn

    def _listdir(self, path="."):
        p = self._mine(path)
        if p is not None:
            if self._cached(p) is not None:
                self._hide(path)
            if self.listing_revalidates:
                dropped = [n for n in self.negative if os.path.dirname(n) == p]
                for n in dropped:
                    del self.negative[n]
                if dropped:
                    self.revalidated.append(p)
        try:
            return self._real["listdir"](path)
        except FileNotFoundError:
            if p is not None:
                self._remember_miss(p)
            raise

    def _create(self, real_fn, dst_arg):
        def fn(*a, **k):
            out = real_fn(*a, **k)
            p = self._mine(a[dst_arg]) if len(a) > dst_arg else None
            if p is not None:
                self.negative.pop(p, None)
            return out
        return fn


def test_fresh_lstat_lists_every_level_top_down_before_the_lookup(tmp_path, monkeypatch):
    """The cached miss lives in the deepest directory that already existed
    (the author dir in the canary), so every level from the library root
    down is listed -- the file's own parent may itself be the hidden name."""
    from app import fsops
    root = tmp_path / "Library"
    (root / "A" / "S" / "B").mkdir(parents=True)
    (root / "A" / "S" / "B" / "f.epub").write_bytes(b"x")
    (root / "top.epub").write_bytes(b"tt")
    seen = []
    real = os.listdir
    monkeypatch.setattr(os, "listdir", lambda d: seen.append(str(d)) or real(d))

    assert fsops.fresh_lstat(str(root / "A" / "S" / "B" / "f.epub"), str(root)).st_size == 1
    assert seen == [str(root), str(root / "A"), str(root / "A" / "S"), str(root / "A" / "S" / "B")]
    seen.clear()
    assert fsops.fresh_lstat(str(root / "A" / "X" / "B" / "f.epub"), str(root)) is None
    assert seen == [str(root), str(root / "A")]        # stops at the first level it cannot see
    seen.clear()
    assert fsops.fresh_lstat(str(root / "top.epub"), str(root)).st_size == 2
    assert seen == [str(root)]


def test_fresh_lstat_never_lists_through_a_symlinked_level(tmp_path, monkeypatch):
    """Fix round 1 (M4): each level is lstat'ed first; the walk stops at
    anything that is not a real directory, so it never lists through a
    symlink (a symlinked folder escaping the library is refused by the
    caller's is_under check, after the lookup)."""
    from app import fsops
    root = tmp_path / "Library"
    root.mkdir()
    outside = tmp_path / "outside"
    (outside / "S").mkdir(parents=True)
    (outside / "S" / "f.epub").write_bytes(b"x")
    os.symlink(outside, root / "A")
    seen = []
    real = os.listdir
    monkeypatch.setattr(os, "listdir", lambda d: seen.append(str(d)) or real(d))

    fsops.fresh_lstat(str(root / "A" / "S" / "f.epub"), str(root))

    assert seen == [str(root)]


def lose_the_file_when_bookorbit_moves_it(env, monkeypatch):
    """BookOrbit lists the moved file, but the disk has nothing there (it is
    parked outside the library; put it back with `restore(lost)`)."""
    real = env.fake._rename_files
    lost = {}

    def rename_then_lose(bid):
        real(bid)
        b = env.fake.books[bid]
        folder = env.fake._local(b["folderPath"])
        for f in b["files"]:
            p = os.path.join(folder, f["filename"])
            if os.path.isfile(p):
                lost[p] = str(env.tmp / f"lost-{len(lost)}-{f['filename']}")
                os.rename(p, lost[p])
    monkeypatch.setattr(env.fake, "_rename_files", rename_then_lose)
    return lost


def restore(lost):
    for p, parked in lost.items():
        os.rename(parked, p)


def test_nfs_negative_lookup_is_revalidated_by_listing_and_files_at_once(env, monkeypatch, caplog):
    """The go-live canary: guard 8's lexists cached ENOENT for the folder
    BookOrbit then moved the book into; one stat of the file failed ->
    retryable (+1 h) and a false attention task on the successful retry.
    Listing the directories above the file drops the stale entry."""
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    nfs = StaleNfsView(env, monkeypatch)
    ex = env.executor()
    env.snapshot_tree()

    with caplog.at_level("INFO"):
        r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    assert not [m for m in caplog.messages if "showed up on disk" in m]    # no wait was needed
    author = str(env.books_root / "Library" / "Jane Author")
    assert os.path.join(author, "Saga") in nfs.recorded          # guard 8 cached the miss ...
    assert author in nfs.revalidated                             # ... the listing dropped it
    final = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b"
    assert r.moves == [(arr["primary"], str(final), 5000)]
    j = env.arrivals.get(arr["key"])["exec"]
    assert not j.get("attempts") and not j.get("unverified") and not j.get("notes")


def test_nfs_negative_lookup_listing_cannot_clear_is_polled_out(env, monkeypatch, caplog):
    """Even when listing does not revalidate (e.g. a nocto mount), the disk
    is polled until the cached miss expires -- within the 90 s budget."""
    assert (executor_mod.VERIFY_MAX, executor_mod.VERIFY_POLL) == (90, 3)
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    nfs = StaleNfsView(env, monkeypatch, listing_revalidates=False, expire_after=30)
    monkeypatch.setattr(executor_mod, "VERIFY_POLL", 2)       # tell its sleeps from the settle's
    ex = env.executor()
    env.snapshot_tree()

    with caplog.at_level("INFO"):
        r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    assert nfs.hidden and env.clock.sleeps.count(2) >= 3       # it waited the cached miss out
    assert [m for m in caplog.messages if "02. New Book.m4b showed up on disk after" in m]
    j = env.arrivals.get(arr["key"])["exec"]
    assert not j.get("attempts") and not j.get("unverified")


def test_file_really_missing_after_the_poll_budget_is_retryable_then_resume_files_clean(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    lost = lose_the_file_when_bookorbit_moves_it(env, monkeypatch)
    monkeypatch.setattr(executor_mod, "VERIFY_MAX", 9)        # small injected budget
    monkeypatch.setattr(executor_mod, "VERIFY_POLL", 2)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "retryable" and "missing or the wrong size on disk" in r.detail, r.detail
    # fix round 1 (M2): the placement check polls at 0,2,..,10 s; the rename
    # step's check shares this call's spent budget -- one look, not 10 s more
    assert env.clock.sleeps.count(2) == 5
    j = env.arrivals.get(arr["key"])["exec"]
    assert j["open"] and j["step"] == "renamed" and j["attempts"] == 1
    final = env.books_root / "Library" / "Jane Author" / "Saga" / "02. New Book" / "02. New Book.m4b"
    assert "missing or the wrong size on disk" in j["unverified"]["note"]     # genuine: kept pending
    assert j["unverified"]["path"] == str(final)                             # (M3) where it looked
    assert not j.get("notes")
    assert not [k for k in j if k.startswith("_")]          # the per-call budget is never journaled

    restore(lost)                                                    # the file turns up
    r2 = ex.resume(env.arrivals.get(arr["key"]))

    assert r2.ok and r2.state == "filed" and not r2.escalate, r2.detail
    assert "ESCALATE" not in r2.detail
    j = env.arrivals.get(arr["key"])["exec"]
    assert not j.get("unverified") and j["outcome"]["escalate"] is None


@pytest.mark.parametrize("shape", ["separate", "combined"])
def test_resume_drops_a_legacy_journaled_placement_note_once_the_file_verifies(env, monkeypatch, shape):
    """The canary's own journal: the image before Task 11 journaled the
    failed check as an ordinary `exec.notes` entry, and the successful retry
    turned it into a false attention task. A genuine note next to it stays --
    also when the old code joined both into one "<problem>; <check>" note
    (fix round 1 nit: the stale tail is split off, the problem kept)."""
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    lost = lose_the_file_when_bookorbit_moves_it(env, monkeypatch)
    monkeypatch.setattr(executor_mod, "VERIFY_MAX", 3)
    ex = env.executor()
    env.snapshot_tree()
    assert ex.execute(intent_create(arr), arr, {}).state == "retryable"
    j = dict(env.arrivals.get(arr["key"])["exec"])
    del j["unverified"]
    stale = (f"BookOrbit lists {next(iter(lost))} for book {j['book_id']} but it is missing or the "
             f"wrong size on disk")
    genuine = (f"BookOrbit left book {j['book_id']} at '/books/Library/x' instead of moving it to "
               f"'y' (rename skipped or still pending); its file stays filed there")
    j["notes"] = [stale, genuine] if shape == "separate" else [f"{genuine}; {stale}"]
    env.arrivals.record(arr["key"], states.EXECUTING, exec=j)
    restore(lost)

    r = ex.resume(env.arrivals.get(arr["key"]))

    assert r.ok and r.state == "filed", r.detail
    assert r.escalate == genuine


def test_placement_check_disproved_later_in_the_same_run_leaves_no_note(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    lost = lose_the_file_when_bookorbit_moves_it(env, monkeypatch)
    monkeypatch.setattr(executor_mod, "VERIFY_MAX", 3)
    real = Executor._placement_note
    seen = []

    def check_then_turn_up(self, ctx, d, plan):
        out = real(self, ctx, d, plan)
        seen.append((out, ctx.get("unverified")))
        restore(lost)                                  # visible before the rename step looks
        return out
    monkeypatch.setattr(Executor, "_placement_note", check_then_turn_up)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert len(seen) == 1 and seen[0][0] is None                     # no placement problem ...
    assert "missing or the wrong size on disk" in (seen[0][1] or {}).get("note", "")  # ... the disk check failed
    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    assert not env.arrivals.get(arr["key"])["exec"].get("attempts")


def test_stop_while_polling_the_disk_is_retryable_and_not_an_attempt(env, monkeypatch):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    lose_the_file_when_bookorbit_moves_it(env, monkeypatch)
    monkeypatch.setattr(executor_mod, "VERIFY_POLL", 2)
    real_sleep = env.clock.sleep

    def sleep(s):
        real_sleep(s)
        if s == 2:
            env.stop = True
    env.clock.sleep = sleep
    ex = env.executor()
    env.snapshot_tree()
    beats = env.beats

    r = ex.execute(intent_create(arr), arr, {})

    assert r.state == "retryable" and "stopping" in r.detail, r.detail
    assert env.clock.sleeps.count(2) == 1 and env.beats > beats
    j = env.arrivals.get(arr["key"])["exec"]
    assert j["open"] and not j.get("attempts")


def test_own_lib_dir_already_gone_is_not_reported_left_behind(env, monkeypatch):
    """A stale NFS view can still show our [lib-] dir right after BookOrbit
    moved it away; rmdir then answers ENOENT -- gone, not "left non-empty"."""
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    made.mkdir(parents=True)
    env.snapshot_tree()
    ctx = {"key": arr["key"], "dst_dir": str(made)}

    def gone(p, *a, **k):
        raise FileNotFoundError(errno.ENOENT, "No such file or directory", p)
    monkeypatch.setattr(executor_mod.os, "rmdir", gone)
    assert ex._rmdir_own(ctx) is None
    monkeypatch.undo()
    (made / "x.m4b").write_bytes(b"x")
    assert ex._rmdir_own(ctx) == f"left non-empty {made}"



def test_a_failed_check_is_kept_when_the_file_then_verifies_somewhere_else(env, monkeypatch):
    """Fix round 1 (M3): a later successful locate clears the parked check
    only at the path that check looked at. Verified at ANOTHER path means the
    book moved again after the check -- kept, and it escalates with where the
    file turned up."""
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    lost = lose_the_file_when_bookorbit_moves_it(env, monkeypatch)
    monkeypatch.setattr(executor_mod, "VERIFY_MAX", 3)
    real = Executor._placement_note
    elsewhere = env.books_root / "Library" / "Jane Author" / "Elsewhere"

    def check_then_relocate(self, ctx, d, plan):
        out = real(self, ctx, d, plan)
        (parked,) = lost.values()
        elsewhere.mkdir()
        os.rename(parked, elsewhere / "02. New Book.m4b")
        env.fake.books[ctx["book_id"]]["folderPath"] = "/books/Library/Jane Author/Elsewhere"
        return out
    monkeypatch.setattr(Executor, "_placement_note", check_then_relocate)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr), arr, {})

    assert r.ok and r.state == "filed", r.detail
    assert r.escalate and "missing or the wrong size on disk" in r.escalate, r.detail
    assert f"verified at {elsewhere / '02. New Book.m4b'}" in r.escalate
    assert r.moves[0][1] == str(elsewhere / "02. New Book.m4b")


def test_a_disk_check_that_needs_no_wait_does_not_log_on_a_real_clock(env, caplog):
    """Fix round 1 (M1): time.time advances during the lookup itself, so a
    check that found the file at once logged "showed up on disk after 0 s"
    every time. Only a check that actually slept logs."""
    ex = env.executor()
    folder = env.books_root / "Library" / "A" / "B"
    folder.mkdir(parents=True)
    (folder / "b.m4b").write_bytes(b"x" * 10)
    env.snapshot_tree()
    ticks = iter(range(1, 10 ** 6))
    ex.clock = lambda: 1_000_000.0 + next(ticks) / 100          # moves on every read
    ctx = {"library": "Library", "size": 10, "sha256": "unused"}

    with caplog.at_level("INFO"):
        p = ex._verify_local({"id": 5, "folderPath": "/books/Library/A/B"}, {"filename": "b.m4b"}, ctx)

    assert p == str(folder / "b.m4b")
    assert not [m for m in caplog.messages if "showed up on disk" in m]


def update_moves_the_book(env, ex, filed_arrival):
    """execute_update sets a series on book 7001, so BookOrbit moves it to
    Martha Wells/Murderbot Diaries/02. Artificial Condition -- after guard 8
    looked that folder up (a cached miss under StaleNfsView)."""
    r = ex.execute_update(intent_update_metadata(
        filed_arrival, 7001, metadata={"series": "Murderbot Diaries", "seriesIndex": 2}, lock=[]),
        filed_arrival, 7001)
    assert r.ok and r.state == "updated", r.detail
    return env.books_root / "Library" / "Martha Wells" / "Murderbot Diaries" / "02. Artificial Condition"


def manual_m4b(env, name="second.m4b", data=b"M" * 4000):
    src = env.intake / "manual" / name
    src.write_bytes(data)
    return env._arrival("manual", os.path.splitext(name)[0], src, src)


def test_attach_to_a_book_execute_update_just_moved_files_despite_the_stale_lookup(env, monkeypatch):
    """Fix round 1 (I2): guard 3's plain isdir read the moved folder through
    the cached miss -> a permanent failure before the move (exec-failed,
    failure push, task). It re-lists the way the post-move check does."""
    attach_target(env)
    first = mark_filed(env, env.libation(title="Artificial Condition"), 7001)
    nfs = StaleNfsView(env, monkeypatch)
    ex = env.executor()
    env.snapshot_tree()
    moved = update_moves_the_book(env, ex, first)
    assert str(moved.parent) in nfs.recorded                     # guard 8 cached the miss
    second = manual_m4b(env)

    r = ex.execute(intent_attach(second, 7001, iid="r2:1"), second, {})

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    assert (moved / "02. Artificial Condition.m4b").stat().st_size == 4000


def test_book_folder_still_not_visible_before_the_move_is_retryable_not_failed(env, monkeypatch):
    """Fix round 1 (I2): a folder even the re-listing cannot show is retried
    later (bounded by the service's max_attempts), never exec-failed. Nothing
    moved; the arrival is back in the intake."""
    attach_target(env)
    first = mark_filed(env, env.libation(title="Artificial Condition"), 7001)
    StaleNfsView(env, monkeypatch, listing_revalidates=False)
    ex = env.executor()
    env.snapshot_tree()
    update_moves_the_book(env, ex, first)
    second = manual_m4b(env)

    r = ex.execute(intent_attach(second, 7001, iid="r2:1"), second, {})

    assert r.state == "retryable" and "not visible" in r.detail, r.detail
    assert os.path.isfile(second["primary"]) and r.moves == []


def test_duplicate_of_a_book_execute_update_just_moved_is_removed(env, monkeypatch):
    """Fix round 1 (I2): _library_copy re-lists too."""
    rec = _duplicate(env)                                  # 7001 holds the arrival's exact bytes
    other = mark_filed(env, env.kindle(), 7001)
    StaleNfsView(env, monkeypatch)
    ex = env.executor()
    env.snapshot_tree()
    update_moves_the_book(env, ex, other)

    r = ex.remove_duplicate(env.arrivals.get(rec["key"]))

    assert r.state == "removed", r.detail
    assert not os.path.exists(rec["path"])


def test_duplicate_whose_library_copy_is_not_visible_is_retryable_not_failed(env, monkeypatch):
    rec = _duplicate(env)
    other = mark_filed(env, env.kindle(), 7001)
    StaleNfsView(env, monkeypatch, listing_revalidates=False)
    ex = env.executor()
    env.snapshot_tree()
    update_moves_the_book(env, ex, other)

    r = ex.remove_duplicate(env.arrivals.get(rec["key"]))

    assert r.state == "retryable" and "not visible" in r.detail, r.detail
    assert os.path.isfile(rec["primary"])

# --- Task 11: create_book language / publishedYear from the arrival's EPUB OPF ----------------


def manual_epub(env, name="zz-canary.epub"):
    src = env.intake / "manual" / name
    src.write_bytes(b"EPUB" * 400)
    return env._arrival("manual", name, src, src)


def omitting(intent, *keys):
    for k in keys:
        intent["payload"]["metadata"].pop(k, None)
    return intent


def epub_dossier(arr, **epub):
    return {"key": arr["key"], "untrusted": {"epub": epub or None}}


def test_create_book_takes_language_and_year_from_the_epub_when_the_intent_omits_them(env):
    """The canary: no language in the intent, the OPF said "en" -- it was
    written as a LOCKED null. Now the OPF value is written and locked."""
    arr = manual_epub(env)
    ex = env.executor()
    env.snapshot_tree()
    intent = omitting(intent_create(arr, title="Zz Canary", series=None, seriesIndex=None),
                      "language", "publishedYear")

    r = ex.execute(intent, arr, epub_dossier(arr, language="en", date="2026-09-23T00:00:00+00:00"))

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert body["language"] == "en" and body["publishedYear"] == 2026
    b = env.fake.books[r.book_id]
    assert b["language"] == "en" and b["publishedYear"] == 2026
    assert {"language", "publishedYear"} <= set(b["lockedFields"])


def test_create_book_intent_language_and_year_beat_the_epub(env):
    arr = manual_epub(env)
    ex = env.executor()
    env.snapshot_tree()

    r = ex.execute(intent_create(arr, language="fr", publishedYear=1999),
                   arr, epub_dossier(arr, language="en", date="2026"))

    assert r.ok, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert (body["language"], body["publishedYear"]) == ("fr", 1999)


@pytest.mark.parametrize("epub", [
    {"language": "<b>en</b>", "date": "0101-01-01T00:00:00+00:00"},    # junk code; calibre's "no date"
    {"language": "und", "date": "someday"},
    {"language": None, "date": None},
    {},                                                                # no epub in the dossier at all
])
def test_create_book_omits_language_and_year_nobody_can_supply(env, epub):
    arr = manual_epub(env)
    ex = env.executor()
    env.snapshot_tree()
    intent = omitting(intent_create(arr, series=None, seriesIndex=None, subtitle=None),
                      "language", "publishedYear")

    r = ex.execute(intent, arr, epub_dossier(arr, **epub))

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert "language" not in body and "publishedYear" not in body      # neither null ...
    locked = set(env.fake.books[r.book_id]["lockedFields"])
    assert not locked & {"language", "publishedYear"}                  # ... nor locked
    # subtitle and series keep null + lock (the provider fetch pollutes series)
    assert body["subtitle"] is None and body["seriesName"] is None and body["seriesIndex"] is None
    assert {"title", "subtitle", "description", "authors", "seriesName", "seriesIndex"} <= locked


def test_audio_only_create_book_omits_absent_language_and_year(env):
    arr = env.libation(asin="B0NEWBOOK1", title="New Book")
    ex = env.executor()
    env.snapshot_tree()
    intent = omitting(intent_create(arr), "language", "publishedYear")

    r = ex.execute(intent, arr, {"key": arr["key"], "untrusted": {"epub": None, "files": [{"name": "x"}]}})

    assert r.ok and not r.escalate, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert "language" not in body and "publishedYear" not in body
    assert not set(env.fake.books[r.book_id]["lockedFields"]) & {"language", "publishedYear"}


def test_resumed_create_uses_the_metadata_journaled_before_the_move(env):
    """The OPF values are resolved once, before the move, and journaled with
    the rest of the create metadata: a resume (which has no dossier) sends
    the same body."""
    arr = manual_epub(env)
    ex = env.executor()
    env.snapshot_tree()
    env.fake.crash_on[("PATCH", "/metadata-and-locks")] = Crash()
    intent = omitting(intent_create(arr), "language", "publishedYear")
    with pytest.raises(Crash):
        ex.execute(intent, arr, epub_dossier(arr, language="en", date="2026"))

    r = env.executor().resume(env.arrivals.get(arr["key"]))

    assert r.ok and r.state == "filed", r.detail
    body = env.fake.patch_bodies[-1][2]["metadata"]
    assert (body["language"], body["publishedYear"]) == ("en", 2026)


def test_create_book_drops_an_implausible_intent_language_and_year_with_a_warning(env, caplog):
    """Fix round 1 (M6): the intent's own language/year pass the same checks
    as the OPF's; implausible ones are logged and dropped -- the OPF's value
    (or nothing) is written -- rather than failing a filing over them."""
    arr = manual_epub(env)
    ex = env.executor()
    env.snapshot_tree()

    with caplog.at_level("WARNING"):
        r = ex.execute(intent_create(arr, language="english (probably)", publishedYear=20200),
                       arr, epub_dossier(arr, language="en", date="1851"))

    assert r.ok and r.state == "filed" and not r.escalate, r.detail
    body = env.fake.patch_bodies[0][2]["metadata"]
    assert (body["language"], body["publishedYear"]) == ("en", 1851)
    dropped = [m for m in caplog.messages if "dropped" in m]
    assert any("english (probably)" in m for m in dropped) and any("20200" in m for m in dropped)
