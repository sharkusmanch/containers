"""Read-along worker: the nightly run end to end, over fakes."""
import json
import os
import zipfile

import pytest

from app.readalong.config import Settings
from app.readalong.job import Job
from app.readalong.state import State
from app.readalong.storyteller import Status
from tests.readalong_fakes import FakeLibrary
from tests.test_readalong_smil import CONTAINER, OPF, S1

S2 = S1.replace("c1.xhtml", "c2.xhtml")          # 20 s of overlay per SMIL -> 40 s in all


def make_readalong(path, zero_clip=False):
    s2 = S2.replace('clipBegin="10.5s" clipEnd="20s"', 'clipBegin="20s" clipEnd="20s"') if zero_clip else S2
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/s1.smil", S1)
        z.writestr("OEBPS/s2.smil", s2)


class FakeStoryteller:
    """Speaks beta.38's shape: readaloud.status (QUEUED/PROCESSING/ALIGNED) and
    processingJob.status (QUEUED/RUNNING/PAUSED/DONE/ERROR/CANCELED; None when done)."""

    def __init__(self, polls_until_done=2, grade="S"):
        self.books_ = {}
        self.polls_until_done, self.grade = polls_until_done, grade
        self.calls = []
        self.foreign = []
        self.report_missing = False
        self.downloads = 0
        self.now = "2027-01-15T08:00:00Z"

    def login(self, u, p):
        self.calls.append(("login",))

    def relogin(self):
        pass

    def create_book(self, epub, audio):
        uuid = f"u{len(self.books_) + len([c for c in self.calls if c[0] == 'delete']) + 1}"
        self.books_[uuid] = {"uuid": uuid, "paths": (epub, audio), "createdAt": self.now,
                             "readaloud": {"status": "QUEUED"}, "processingJob": {"status": "QUEUED"}, "left": None}
        self.calls.append(("create", epub, audio))
        return uuid

    def process(self, uuid):
        self.calls.append(("process", uuid))
        self.books_[uuid].update(readaloud={"status": "PROCESSING"}, processingJob={"status": "RUNNING"},
                                 left=self.polls_until_done)

    def book(self, uuid):
        b = self.books_[uuid]
        if (b["processingJob"] or {}).get("status") == "RUNNING":
            b["left"] -= 1
            if b["left"] <= 0:
                b.update(readaloud={"status": "ALIGNED"}, processingJob=None)
        return {k: v for k, v in b.items() if k != "left"}

    def books(self):
        return [self.book(u) for u in list(self.books_)] + self.foreign

    def alignment_report(self, uuid):
        return None if self.report_missing else {"grade": self.grade}

    def download_readaloud(self, uuid, dest):
        self.downloads += 1
        make_readalong(dest)
        return os.path.getsize(dest)

    def delete_book(self, uuid):
        self.calls.append(("delete", uuid))
        self.books_.pop(uuid, None)


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


ENV = {"BOOKORBIT_URL": "http://b/api/v1", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p",
       "STORYTELLER_URL": "http://st:8001", "STORYTELLER_USER": "su", "STORYTELLER_PASS": "sp",
       "APPRISE_URL": "http://apprise/notify/librarian"}


@pytest.fixture
def env(tmp_path):
    books = tmp_path / "books"
    lib = FakeLibrary(books)
    lib.add_book(111, "Joe Abercrombie/The Age of Madness/01. A Little Hatred",
                 [(11, "01. A Little Hatred.epub", b"PLAIN"), (12, "01. A Little Hatred.m4b", b"AUDIO" * 20)],
                 title="A Little Hatred", updatedAt="2026-09-20T10:00:00.000Z",
                 customMetadata=[{"fieldId": 2, "value": False}])
    st = FakeStoryteller()
    clock = Clock()
    pushes = []

    def make(**extra):
        s = Settings.from_env({**ENV, "STATE_DIR": str(tmp_path / "state"), "MEDIA_BOOKS": str(books),
                               "STAGING_DIR": str(tmp_path / "staging"), **extra})
        os.makedirs(s.state_dir, exist_ok=True)
        return Job(s, bo=lib, st=st, push=lambda url, t, b: pushes.append((t, b)) or True,
                   clock=clock, sleep=clock.sleep, duration=lambda path: 40.0)
    return lib, st, clock, pushes, make, tmp_path


def folder(tmp_path):
    return tmp_path / "books/Joe Abercrombie/The Age of Madness/01. A Little Hatred"


def test_dry_run_changes_nothing(env):
    lib, st, clock, pushes, make, tmp = env
    assert make(DRY_RUN="true").run() == 0
    assert st.calls == [("login",)] and pushes == [] and lib.scans == 0     # read-only: lists Storyteller
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]


def test_one_book_end_to_end(env):
    lib, st, clock, pushes, make, tmp = env
    assert make().run() == 0
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred (ebook).epub", "01. A Little Hatred.epub",
                                                "01. A Little Hatred.m4b"]
    d = lib.detail(111)
    ra = next(f for f in d["files"] if f["mediaOverlay"]["available"])
    assert ra["role"] == "primary" and d["readAloudSync"]["state"] == "enabled"
    assert d["customMetadata"][0]["value"] is True                      # the Read-Along flag
    assert st.books_ == {} and ("delete", "u1") in st.calls             # Storyteller emptied
    assert st.calls[1][1] == "/library/Joe Abercrombie/The Age of Madness/01. A Little Hatred/01. A Little Hatred.epub"
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["in_flight"] is None and state["history"][-1]["outcome"] == "published"
    assert pushes and "1 published" in pushes[0][0] and "A Little Hatred" in pushes[0][1]
    assert os.listdir(tmp / "staging") == []


def test_nothing_to_do_is_silent(env):
    lib, st, clock, pushes, make, tmp = env
    assert make().run() == 0
    pushes.clear()
    assert make().run() == 0                     # the book now has its read-along
    assert pushes == []


def test_no_new_book_starts_after_start_hours(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    clock.t += 4 * 3600                         # the run is already 4 h old
    assert job.run() == 0
    assert not any(c[0] == "create" for c in st.calls)


def test_unfinished_alignment_is_kept_for_the_next_run(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    assert make(RUN_HOURS="1", START_HOURS="1").run() == 0
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["in_flight"]["uuid"] == "u1" and pushes == []
    assert st.books_["u1"]["readaloud"]["status"] == "PROCESSING"
    st.books_["u1"]["left"] = 1                   # Storyteller finishes overnight
    assert make().run() == 0
    assert json.load(open(tmp / "state/readalong.json"))["in_flight"] is None
    assert any(f["mediaOverlay"]["available"] for f in lib.detail(111)["files"])
    assert sum(1 for c in st.calls if c[0] == "create") == 1          # never aligned twice


def test_a_busy_storyteller_is_never_touched(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "manual-run", "readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "RUNNING"}}]
    assert make().run() == 0
    assert not any(c[0] in ("create", "delete") for c in st.calls)


def test_a_refusal_is_remembered_for_the_same_files(env):
    lib, st, clock, pushes, make, tmp = env
    st.grade = "D"
    assert make().run() == 0
    assert "1 refused" in pushes[0][0] and "grade D" in pushes[0][1]
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]
    assert st.books_ == {}                        # the refused alignment is deleted
    pushes.clear()
    assert make().run() == 0
    assert sum(1 for c in st.calls if c[0] == "create") == 1 and pushes == []


def test_files_changing_during_alignment_abandon_it(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    (folder(tmp) / "01. A Little Hatred.m4b").write_bytes(b"NEW AUDIO" * 50)   # a better m4b was filed
    lib.scan(7)
    clock.t += 3 * 3600
    assert make().run() == 0
    assert "files changed" in pushes[-1][1] and ("delete", "u1") in st.calls


def test_publish_errors_retry_then_give_up(env):
    lib, st, clock, pushes, make, tmp = env
    lib.scan_fails = True
    for n in range(3):
        clock.t += 24 * 3600
        assert make().run() == 0
    assert "gave up after 3 tries" in pushes[-1][1]
    assert st.books_ == {} and sum(1 for c in st.calls if c[0] == "create") == 1
    lib.scan_fails = False
    clock.t += 24 * 3600
    assert make().run() == 0                      # same files: not retried
    assert sum(1 for c in st.calls if c[0] == "create") == 1


def test_an_undelivered_push_fails_the_run(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    job._push = lambda url, t, b: False
    assert job.run() == 1


def test_a_truncated_or_empty_listing_fails_the_run(env):
    lib, st, clock, pushes, make, tmp = env
    lib.books_by_id = lambda: []
    from app.readalong.job import JobError
    with pytest.raises(JobError):
        make().run()


def test_a_failed_publish_keeps_its_book_and_starts_no_other(env):
    """The kept Storyteller book must never be orphaned by starting the next one."""
    lib, st, clock, pushes, make, tmp = env
    lib.add_book(222, "Other/01. Other", [(21, "01. Other.epub", b"P2"), (22, "01. Other.m4b", b"A2" * 9)],
                 title="Other", updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    lib.scan_fails = True
    assert make().run() == 0
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["in_flight"]["book"] == 111 and list(st.books_) == [state["in_flight"]["uuid"]]
    assert sum(1 for c in st.calls if c[0] == "create") == 1
    lib.scan_fails = False
    clock.t += 24 * 3600
    assert make().run() == 0                        # 111 finishes, then 222 gets its turn
    assert sum(1 for c in st.calls if c[0] == "create") == 2
    assert all(any(f["mediaOverlay"]["available"] for f in lib.detail(b)["files"]) for b in (111, 222))


def test_a_storyteller_failure_is_retried_never_refused(env):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process
    fails = {"n": 1}

    def process(uuid):
        real_process(uuid)
        if fails["n"] > 0:                          # the first processing errors out
            fails["n"] -= 1
            st.books_[uuid].update(readaloud={"status": "ERROR"}, processingJob={"status": "ERROR"})
    st.process = process
    assert make().run() == 0
    assert "Storyteller could not align it" in pushes[-1][1]
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["refused"] == {} and state["in_flight"]["book"] == 111   # kept, re-processing
    clock.t += 24 * 3600
    assert make().run() == 0
    assert any(f["mediaOverlay"]["available"] for f in lib.detail(111)["files"])
    assert sum(1 for c in st.calls if c[0] == "create") == 1


@pytest.mark.parametrize("status", ["CANCELED", "ERROR", "SOMETHING-NEW"])
def test_any_non_aligned_end_is_an_error_not_a_refusal(env, status):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process

    def process(uuid):
        real_process(uuid)
        st.books_[uuid].update(readaloud={"status": status}, processingJob={"status": status})
    st.process = process
    for _ in range(3):
        clock.t += 24 * 3600
        make().run()
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["refused"] == {} and "gave up after 3 tries" in pushes[-1][1]


def test_a_missing_report_is_an_error_not_a_refusal(env):
    lib, st, clock, pushes, make, tmp = env
    st.report_missing = True
    make().run()
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["refused"] == {} and state["in_flight"]["book"] == 111
    assert "no alignment report" in pushes[-1][1]


def test_a_paused_job_is_resumed_and_waited_for(env):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process
    once = {"n": 1}

    def process(uuid):
        real_process(uuid)
        if once["n"]:
            once["n"] = 0
            st.books_[uuid]["processingJob"] = {"status": "PAUSED"}
    st.process = process
    assert make().run() == 0
    assert sum(1 for c in st.calls if c[0] == "process") == 2          # resumed once
    assert any(f["mediaOverlay"]["available"] for f in lib.detail(111)["files"])


def test_a_rerun_after_the_link_never_downloads_or_rewrites_the_live_file(env, monkeypatch):
    """C2: the staged name is a hard link of the library file after the link."""
    lib, st, clock, pushes, make, tmp = env
    import app.readalong.publish as pub
    real_scan = lib.scan
    calls = {"n": 0}

    def scan(library_id):                            # killed right after the link, before its scan
        calls["n"] += 1
        if calls["n"] == 2:
            raise KeyboardInterrupt
        return real_scan(library_id)
    lib.scan = scan
    with pytest.raises(KeyboardInterrupt):
        make().run()
    live = folder(tmp) / "01. A Little Hatred.epub"
    before = (os.stat(live).st_ino, live.read_bytes())
    lib.scan = real_scan
    downloads = st.downloads
    assert make().run() == 0
    assert st.downloads == downloads                 # nothing downloaded again
    assert (os.stat(live).st_ino, live.read_bytes()) == before
    assert any(f["mediaOverlay"]["available"] for f in lib.detail(111)["files"])


def test_an_import_whose_uuid_was_never_recorded_is_adopted(env):
    lib, st, clock, pushes, make, tmp = env
    real_create = st.create_book
    st.create_book = lambda e, a: (real_create(e, a), (_ for _ in ()).throw(KeyboardInterrupt))[0]
    with pytest.raises(KeyboardInterrupt):
        make().run()
    state = json.load(open(tmp / "state/readalong.json"))
    assert state["in_flight"]["uuid"] is None and list(st.books_) == ["u1"]
    st.create_book = real_create
    st.now = "2100-01-01T00:00:00Z"                  # created after the run recorded its start
    st.process("u1")
    assert make().run() == 0
    assert sum(1 for c in st.calls if c[0] == "create") == 1
    assert any(f["mediaOverlay"]["available"] for f in lib.detail(111)["files"])


def test_sigterm_stops_polling_and_keeps_the_book(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    job = make()
    real_sleep = job.sleep

    def sleep(s):
        job.on_sigterm()
        real_sleep(s)
    job.sleep = sleep
    assert job.run() == 0
    assert json.load(open(tmp / "state/readalong.json"))["in_flight"]["uuid"] == "u1"


def test_a_book_too_long_for_the_rest_of_the_run_waits(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    job.duration = lambda path: 60 * 3600.0          # 60 h of audio: ~6 h to align
    clock.t += 1 * 3600                              # an hour into the run
    assert job.run() == 0
    assert not any(c[0] == "create" for c in st.calls)
    job2 = make()
    job2.duration = lambda path: 60 * 3600.0
    assert job2.run() == 0                           # at the top of a run it still starts
    assert any(c[0] == "create" for c in st.calls)


def test_a_foreign_book_stuck_in_storyteller_is_told_once(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "x", "title": "Manual", "readaloud": {"status": "PROCESSING"},
                   "processingJob": {"status": "RUNNING"}}]
    for _ in range(4):
        clock.t += 24 * 3600
        make().run()
    told = [b for _t, b in pushes if "not mine" in b]
    assert len(told) == 1


def test_a_blocking_stray_is_told_once_and_retried_until_gone(env):
    lib, st, clock, pushes, make, tmp = env
    stray = folder(tmp) / "01. a little hatred (EBOOK).epub"
    stray.write_bytes(b"NOT THE BOOK'S")
    make().run()
    assert "is in the way" in pushes[-1][1]
    n = len(pushes)
    clock.t += 24 * 3600
    make().run()
    assert len(pushes) == n                          # same blocker: not told again
    os.unlink(stray)
    clock.t += 24 * 3600
    make().run()
    assert "published" in pushes[-1][1] and sum(1 for c in st.calls if c[0] == "create") == 1


def test_phase_reads_the_job_before_the_readaloud():
    from app.readalong.job import DONE, FAILED, PAUSED, RUNNING, phase
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "PAUSED"}}) == PAUSED
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "RUNNING"}}) == RUNNING
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": None}) == DONE
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "DONE"}}) == DONE
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": None}) == RUNNING
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "ERROR"}}) == FAILED
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "CANCELED"}}) == FAILED
    assert phase({}) == FAILED
