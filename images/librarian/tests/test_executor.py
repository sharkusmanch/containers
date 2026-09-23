"""Executor tests: real LibraryIndex + real BookorbitWriter over a fake
BookOrbit transport, real filesystem moves on tmp_path roots.

The fake server simulates a library scan by walking the fake library root
(book-per-folder): a folder with files is one book; an existing book's file
list is re-synced, a new folder becomes a new book. `rename-files` moves the
book to BookOrbit's rendered pattern. Every scenario snapshots the library
tree first and asserts that no pre-existing path was removed or modified.
"""
import errno
import hashlib
import json
import os

import pytest

from app import executor as executor_mod
from app import states
from app.bookorbit import BookorbitClient, BookorbitWriter, LibraryIndex
from app.config import Settings
from app.executor import ExecResult, Executor, sha12
from app.policy import render_folder
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
        self.rename_leaves_old_dir = True
        self.crash_on = {}                   # (method, path-suffix) -> exception to raise
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
        if self.on_scan:
            self.on_scan(self, library_id)

    def _rename_files(self, bid):
        b = self.books[bid]
        lib = b["libraryName"]
        rendered = render_folder(b["authors"][0]["name"], b.get("seriesName"),
                                 b.get("seriesIndex"), b["title"])
        old = self._local(b["folderPath"])
        new = os.path.join(self.books_root, lib, rendered)
        os.makedirs(new, exist_ok=True)
        base = os.path.basename(rendered)
        out = []
        for f in b["files"]:
            ext = os.path.splitext(f["filename"])[1]
            src = os.path.join(old, f["filename"])
            dst = os.path.join(new, base + ext)
            if src != dst:
                assert not os.path.exists(dst), "fake rename-files would overwrite"
                os.rename(src, dst)
            out.append(self._file_entry(dst))
        if old != new and not self.rename_leaves_old_dir:
            os.rmdir(old)
        b["files"] = out
        b["folderPath"] = f"/books/{lib}/{rendered}"
        self._touch(b)

    # transport ------------------------------------------------------------
    def transport(self, method, url, body, headers):
        path = url.split("/api/v1", 1)[1]
        self.calls.append((method, path))
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
        if path.startswith("/scanner/libraries/"):
            lib = int(path.split("/")[3])
            if path.endswith("/scan-history"):
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
                return 200, "{}"
            if parts[3] == "metadata-and-locks" and method == "PATCH":
                b = self.books[bid]
                for k, v in payload["metadata"].items():
                    if k == "authors":
                        b["authors"] = [{"id": i, "name": n, "sortName": n} for i, n in enumerate(v)]
                    elif k == "audibleId":
                        b["providerIds"] = {"audible": v}
                    else:
                        b[k] = v
                b["lockedFields"] = list(payload["lockedFields"])
                self._touch(b)
                return 200, "{}"
        return 500, f"unhandled {method} {path}"

    def _history(self, lib):
        if self.running_polls[lib] > 0:
            self.running_polls[lib] -= 1
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
        assert self._before is not None
        after = self._tree()
        for p, sig in self._before.items():
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


# --- states -------------------------------------------------------------------


def test_new_states_exist():
    assert states.EXECUTING == "executing" and states.EXECUTING in states.ARRIVAL_STATES
    assert states.EXECUTED == "executed" and states.EXECUTED in states.INTENT_STATES
    assert states.EXEC_FAILED == "exec-failed" and states.EXEC_FAILED in states.INTENT_STATES


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
                  rel="Martha Wells/Murderbot Diaries/2. Artificial Condition",
                  files=(("2. Artificial Condition.epub", b"e"),))

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


def test_attach_file_not_listed_after_scan_fails_and_keeps_intake(env):
    attach_target(env)
    arr = env.libation(title="Artificial Condition")
    ex = env.executor()
    env.snapshot_tree()
    env.fake.scan_enabled = False

    r = ex.execute(intent_attach(arr, 7001), arr, {})

    dst = env.books_root / "Library" / "Martha Wells" / "Artificial Condition" / "Artificial Condition.m4b"
    assert r.state == "failed" and str(dst) in r.detail
    assert dst.is_file()                                     # never auto-moved back
    staging = env.intake / ".executing" / sha12(arr["key"])
    assert (staging / "cover.jpg").is_file()                 # no cleanup without verify
    assert env.fake.renames() == []
    assert env.arrivals.get(arr["key"])["exec"]["open"] is False


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
    assert set(b["lockedFields"]) >= {"title", "subtitle", "description"}
    assert "seriesName" not in b["lockedFields"] and "seriesIndex" not in b["lockedFields"]
    # renamed into BookOrbit's pattern
    assert b["folderPath"] == "/books/Library/Jane Author/Saga/2. New Book"
    assert (env.books_root / "Library" / "Jane Author" / "Saga" / "2. New Book" / "2. New Book.m4b").is_file()
    made = env.books_root / "Library" / "Jane Author" / f"New Book [lib-{sha12(arr['key'])}]"
    assert r.moves == [(arr["primary"], str(made / "New Book.m4b"), 5000)]
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


def test_resume_after_link_before_unlink_fails_without_touching_files(env, monkeypatch):
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
    r = env.executor().resume(rec)

    assert r.state == "failed"
    assert rec["exec"]["src"] in r.detail and rec["exec"]["dst"] in r.detail
    assert os.path.isfile(rec["exec"]["src"]) and os.path.isfile(rec["exec"]["dst"])
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
    assert r2.moves == r.moves


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
    assert r.state == "retryable", r.detail
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
    r = ex.execute(intent, arr, {})
    assert r.state == "failed" and r.moves
    staged_side = env.intake / ".executing" / sha12(arr["key"]) / "B0KINDLE01.json"
    assert staged_side.is_file()

    r2 = ex.execute(intent, env.arrivals.get(arr["key"]), {})

    assert r2.state == "failed" and r2.detail == r.detail
    assert staged_side.is_file()
    assert not (env.intake / "kindle" / "B0KINDLE01.json").exists()
