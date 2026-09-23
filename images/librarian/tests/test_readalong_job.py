"""Read-along worker: the nightly run end to end, over fakes."""
import calendar
import json
import os
import time
import zipfile
from datetime import datetime, timezone

import pytest

from app.readalong.config import Settings
from app.readalong.job import BookGone, Bookorbit, Job, JobError, st_created
from app.readalong.state import State
from app.readalong.storyteller import StorytellerHTTPError
from tests.readalong_fakes import OVERLAY, FakeLibrary
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
    """Speaks beta.38's shape. After the import `readaloud.status` is CREATED
    and there is no job; `process` gives QUEUED/PROCESSING -> ALIGNED with
    `processingJob` RUNNING, null once it ends. A failure is readaloud ERROR or
    STOPPED with no job; a pause is readaloud STOPPED with the job PAUSED.
    `createdAt` is UTC with no zone, and an unknown uuid is a 404 -- all as
    the real server and client do."""

    def __init__(self, clock, polls_until_done=2, grade="S"):
        self.clock = clock
        self.books_ = {}
        self.polls_until_done, self.grade = polls_until_done, grade
        self.calls = []
        self.foreign = []
        self.report_missing = False
        self.downloads = 0
        self.imports = 0

    def login(self, u, p):
        self.calls.append(("login",))

    def relogin(self):
        self.calls.append(("relogin",))

    def _get(self, uuid):
        if uuid not in self.books_:
            raise StorytellerHTTPError(f"GET /api/v2/books/{uuid} -> 404: b'not found'", 404)
        return self.books_[uuid]

    def create_book(self, epub, audio):
        self.imports += 1
        uuid = f"u{self.imports}"
        made = datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        self.books_[uuid] = {"uuid": uuid, "title": os.path.splitext(os.path.basename(epub))[0],
                             "createdAt": made, "readaloud": {"status": "CREATED"}, "processingJob": None,
                             "left": None}
        self.calls.append(("create", epub, audio))
        return uuid

    def process(self, uuid):
        self._get(uuid)
        self.calls.append(("process", uuid))
        self.books_[uuid].update(readaloud={"status": "PROCESSING"}, processingJob={"status": "RUNNING"},
                                 left=self.polls_until_done)

    def fail(self, uuid, status="ERROR"):
        self.books_[uuid].update(readaloud={"status": status}, processingJob=None)

    def pause(self, uuid):
        self.books_[uuid].update(readaloud={"status": "STOPPED"}, processingJob={"status": "PAUSED"})

    def book(self, uuid):
        b = self._get(uuid)
        if (b["processingJob"] or {}).get("status") == "RUNNING":
            b["left"] -= 1
            if b["left"] <= 0:
                b.update(readaloud={"status": "ALIGNED"}, processingJob=None)
        return {k: v for k, v in b.items() if k != "left"}

    def books(self):
        return [self.book(u) for u in list(self.books_)] + self.foreign

    def alignment_report(self, uuid):
        self._get(uuid)
        return None if self.report_missing else {"grade": self.grade}

    def download_readaloud(self, uuid, dest):
        self._get(uuid)
        self.downloads += 1
        make_readalong(dest)
        return os.path.getsize(dest)

    def cancel_processing(self, uuid):
        self.calls.append(("cancel", uuid))
        if uuid in self.books_ and self.books_[uuid]["processingJob"]:
            self.books_[uuid].update(readaloud={"status": "STOPPED"}, processingJob=None)

    def delete_book(self, uuid):
        self.calls.append(("delete", uuid))
        self.books_.pop(uuid, None)


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0                 # 2027-01-15 08:00 UTC

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


ENV = {"BOOKORBIT_URL": "http://b/api/v1", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p",
       "STORYTELLER_URL": "http://st:8001", "STORYTELLER_USER": "su", "STORYTELLER_PASS": "sp",
       "APPRISE_URL": "http://apprise/notify/librarian"}
DAY = 24 * 3600


@pytest.fixture
def env(tmp_path):
    books = tmp_path / "books"
    lib = FakeLibrary(books)
    lib.add_book(111, "Joe Abercrombie/The Age of Madness/01. A Little Hatred",
                 [(11, "01. A Little Hatred.epub", b"PLAIN"), (12, "01. A Little Hatred.m4b", b"AUDIO" * 20)],
                 title="A Little Hatred", updatedAt="2026-09-20T10:00:00.000Z",
                 customMetadata=[{"fieldId": 2, "value": False}])
    clock = Clock()
    st = FakeStoryteller(clock)
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


def add_other(lib):
    lib.add_book(222, "Other/01. Other", [(21, "01. Other.epub", b"P2"), (22, "01. Other.m4b", b"A2" * 9)],
                 title="Other", updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])


def state_of(tmp):
    return json.load(open(tmp / "state/readalong.json"))


def creates(st):
    return sum(1 for c in st.calls if c[0] == "create")


def has_readalong(lib, bid):
    return any(f["mediaOverlay"]["available"] for f in lib.detail(bid)["files"])


def released_in_order(st, uuid):
    """Cancelled before deleted -- a DELETE alone does not stop an alignment."""
    names = [c for c in st.calls if c in (("cancel", uuid), ("delete", uuid))]
    return names == [("cancel", uuid), ("delete", uuid)]


# --- the happy path ------------------------------------------------------------------

def test_dry_run_changes_nothing(env):
    lib, st, clock, pushes, make, tmp = env
    assert make(DRY_RUN="true").run() == 0
    assert st.calls == [("login",)] and pushes == [] and lib.scans == 0     # read-only: lists Storyteller
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]
    assert not os.path.exists(tmp / "state/readalong.json")


def test_one_book_end_to_end(env):
    lib, st, clock, pushes, make, tmp = env
    assert make().run() == 0
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred (ebook).epub", "01. A Little Hatred.epub",
                                                "01. A Little Hatred.m4b"]
    d = lib.detail(111)
    ra = next(f for f in d["files"] if f["mediaOverlay"]["available"])
    assert ra["role"] == "primary" and d["readAloudSync"]["state"] == "enabled"
    assert d["customMetadata"][0]["value"] is True                      # the Read-Along flag
    assert st.books_ == {} and released_in_order(st, "u1")              # Storyteller emptied
    assert st.calls[1][1] == "/library/Joe Abercrombie/The Age of Madness/01. A Little Hatred/01. A Little Hatred.epub"
    state = state_of(tmp)
    assert state["in_flight"] is None and state["history"][-1]["outcome"] == "published"
    assert pushes and "1 published" in pushes[0][0] and "A Little Hatred" in pushes[0][1]
    assert os.listdir(tmp / "staging") == []


def test_nothing_to_do_is_silent(env):
    lib, st, clock, pushes, make, tmp = env
    assert make().run() == 0
    pushes.clear()
    assert make().run() == 0                     # the book now has its read-along
    assert pushes == []


def test_the_zero_length_patch_path_end_to_end(env):
    lib, st, clock, pushes, make, tmp = env

    s1 = S1.replace('clipBegin="0:00:00.000" clipEnd="0:00:10.500"', 'clipBegin="0s" clipEnd="10.5s"')
    s2 = s1.replace("c1.xhtml", "c2.xhtml").replace('clipBegin="10.5s" clipEnd="20s"', 'clipBegin="20s" clipEnd="20s"')

    def download(uuid, dest):                        # Storyteller's own "<n>s" form, one zero-length clip
        st.downloads += 1
        with zipfile.ZipFile(dest, "w") as z:
            z.writestr("mimetype", "application/epub+zip")
            z.writestr("META-INF/container.xml", CONTAINER)
            z.writestr("OEBPS/content.opf", OPF)
            z.writestr("OEBPS/s1.smil", s1)
            z.writestr("OEBPS/s2.smil", s2)
            z.writestr("OEBPS/a.m4a", os.urandom(1 << 20), compress_type=zipfile.ZIP_STORED)
        return os.path.getsize(dest)
    st.download_readaloud = download
    job = make()
    job.duration = lambda path: 30.0                 # 30.5 s of overlay after the patch
    assert job.run() == 0
    assert "published" in pushes[-1][1]
    with zipfile.ZipFile(folder(tmp) / "01. A Little Hatred.epub") as z:
        assert z.testzip() is None and z.infolist()[0].filename == "mimetype"
        assert z.getinfo("OEBPS/a.m4a").compress_type == zipfile.ZIP_STORED
        assert 'clipEnd="20.001s"' in z.read("OEBPS/s2.smil").decode()
    assert os.listdir(tmp / "staging") == []


# --- time -------------------------------------------------------------------------------

def test_no_new_book_starts_after_start_hours(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    clock.t += 4 * 3600                         # the run is already 4 h old
    assert job.run() == 0
    assert creates(st) == 0


def test_unfinished_alignment_is_kept_for_the_next_run(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    assert make(RUN_HOURS="1", START_HOURS="1").run() == 0
    state = state_of(tmp)
    assert state["in_flight"]["uuid"] == "u1" and pushes == []
    assert st.books_["u1"]["readaloud"]["status"] == "PROCESSING"
    st.books_["u1"]["left"] = 1                   # Storyteller finishes overnight
    clock.t += DAY
    assert make().run() == 0
    assert state_of(tmp)["in_flight"] is None and has_readalong(lib, 111)
    assert creates(st) == 1                       # never aligned twice


def test_no_publish_begins_in_the_last_hour(env):
    """A publish can take an hour of scan waits: begun late it would be killed half-way."""
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 290                     # ALIGNED ~4.8 h into a 5.5 h run
    assert make().run() == 0
    assert not has_readalong(lib, 111) and state_of(tmp)["in_flight"]["uuid"] == "u1"
    assert "u1" in st.books_ and st.downloads == 0                  # not even gated
    clock.t += DAY
    assert make().run() == 0
    assert has_readalong(lib, 111) and creates(st) == 1


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
    assert state_of(tmp)["in_flight"]["uuid"] == "u1"


def test_a_book_too_long_for_the_rest_of_the_run_waits(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    job.duration = lambda path: 60 * 3600.0          # 60 h of audio: ~6 h to align
    clock.t += 1 * 3600                              # an hour into the run
    assert job.run() == 0
    assert creates(st) == 0
    clock.t += DAY
    job2 = make()
    job2.duration = lambda path: 60 * 3600.0
    assert job2.run() == 0                           # at the top of a run it still starts
    assert creates(st) == 1


def test_a_retry_pod_continues_the_nights_window(env):
    lib, st, clock, pushes, make, tmp = env
    first = make()
    first._push = lambda url, t, b: False            # exit 1: the Job starts a retry pod
    assert first.run() == 1
    clock.t += 2 * 3600
    assert make().t0 == first.t0                     # not a fresh 3.5 h to start books in
    clock.t += DAY
    assert make().t0 == clock.t                      # the next night is a new window


# --- Storyteller ------------------------------------------------------------------------

def test_a_busy_storyteller_is_never_touched(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "manual-run", "readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "RUNNING"}}]
    assert make().run() == 0
    assert not any(c[0] in ("create", "cancel", "delete") for c in st.calls)


def test_a_foreign_book_stuck_in_storyteller_is_told_once(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "x", "title": "Manual", "readaloud": {"status": "PROCESSING"},
                   "processingJob": {"status": "RUNNING"}}]
    for _ in range(4):
        clock.t += DAY
        make().run()
    assert len([b for _t, b in pushes if "not mine" in b]) == 1


def test_a_storyteller_failure_is_retried_never_refused(env):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process
    fails = {"n": 1}

    def process(uuid):
        real_process(uuid)
        if fails["n"] > 0:                          # the first processing errors out
            fails["n"] -= 1
            st.fail(uuid)
    st.process = process
    assert make().run() == 0
    assert "Storyteller could not align it" in pushes[-1][1]
    state = state_of(tmp)
    assert state["refused"] == {} and state["in_flight"]["book"] == 111   # kept, re-processing
    clock.t += DAY
    assert make().run() == 0
    assert has_readalong(lib, 111) and creates(st) == 1


@pytest.mark.parametrize("readaloud,job", [("ERROR", None), ("STOPPED", None), ("PROCESSING", "CANCELED"),
                                           ("SOMETHING-NEW", None)])
def test_any_non_aligned_end_is_an_error_not_a_refusal(env, readaloud, job):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process

    def process(uuid):
        real_process(uuid)
        st.books_[uuid].update(readaloud={"status": readaloud}, processingJob=job and {"status": job})
    st.process = process
    for _ in range(3):
        clock.t += DAY
        make().run()
    state = state_of(tmp)
    assert state["refused"] == {} and "gave up after 3 tries" in pushes[-1][1]
    assert st.books_ == {} and released_in_order(st, "u1")


def test_a_missing_report_is_an_error_not_a_refusal(env):
    lib, st, clock, pushes, make, tmp = env
    st.report_missing = True
    make().run()
    state = state_of(tmp)
    assert state["refused"] == {} and state["in_flight"]["book"] == 111
    assert "no alignment report" in pushes[-1][1] and "u1" in st.books_     # kept for the retry


def test_a_paused_job_is_resumed_and_waited_for(env):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process
    once = {"n": 1}

    def process(uuid):
        real_process(uuid)
        if once["n"]:
            once["n"] = 0
            st.pause(uuid)
    st.process = process
    assert make().run() == 0
    assert sum(1 for c in st.calls if c[0] == "process") == 2          # resumed once
    assert has_readalong(lib, 111)


def test_a_401_is_retried_once_after_relogin(env):
    lib, st, clock, pushes, make, tmp = env
    real_create = st.create_book
    once = {"n": 1}

    def create(epub, audio):
        if once["n"]:
            once["n"] = 0
            raise StorytellerHTTPError("POST /api/v2/books -> 401: b'expired'", 401)
        return real_create(epub, audio)
    st.create_book = create
    assert make().run() == 0
    assert ("relogin",) in st.calls and creates(st) == 1 and has_readalong(lib, 111)


def test_a_storyteller_book_deleted_while_aligning_is_abandoned(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    st.books_.pop("u1")                               # the owner cleans Storyteller up in its UI
    clock.t += DAY
    assert make(RUN_HOURS="1", START_HOURS="1").run() == 0
    assert "its Storyteller book was deleted" in pushes[-1][1]
    assert not any(c == ("cancel", "u1") or c == ("delete", "u1") for c in st.calls)
    st.polls_until_done = 2
    clock.t += DAY
    assert make().run() == 0                          # looked at again: a fresh import
    assert has_readalong(lib, 111) and creates(st) == 2


# --- a kill anywhere is finished by the next run -------------------------------------------

def test_a_rerun_after_the_link_never_downloads_or_rewrites_the_live_file(env):
    """C2: the staged name is a hard link of the library file after the link."""
    lib, st, clock, pushes, make, tmp = env
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
    assert has_readalong(lib, 111)


def test_an_import_whose_uuid_was_never_recorded_is_adopted_and_processed(env):
    lib, st, clock, pushes, make, tmp = env
    real_create = st.create_book

    def killed_after_the_import(epub, audio):
        real_create(epub, audio)
        raise KeyboardInterrupt
    st.create_book = killed_after_the_import
    with pytest.raises(KeyboardInterrupt):
        make().run()
    assert state_of(tmp)["in_flight"]["uuid"] is None and st.books_["u1"]["readaloud"]["status"] == "CREATED"
    st.create_book = real_create
    clock.t += 60                                    # the Job's retry pod
    assert make().run() == 0
    assert creates(st) == 1 and has_readalong(lib, 111)
    assert ("process", "u1") in st.calls             # CREATED and never processed: processed now


def test_a_create_that_timed_out_after_the_import_is_adopted(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_create = st.create_book
    first = []

    def create(epub, audio):
        uuid = real_create(epub, audio)              # the server did the import...
        if not first:
            first.append(uuid)
            raise RuntimeError("timed out")          # ...but the client never saw the answer
        return uuid
    st.create_book = create
    make().run()
    assert state_of(tmp)["in_flight"]["book"] == 111 and creates(st) == 1   # kept, nothing else started
    clock.t += 60
    assert make().run() == 0
    assert has_readalong(lib, 111) and has_readalong(lib, 222) and st.books_ == {}


def test_a_process_failure_after_the_import_keeps_it(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_process = st.process
    fails = {"n": 1}

    def process(uuid):
        if fails["n"]:
            fails["n"] = 0
            raise StorytellerHTTPError(f"POST /api/v2/books/{uuid}/process -> 500: b'boom'", 500)
        return real_process(uuid)
    st.process = process
    make().run()
    s = state_of(tmp)
    assert s["in_flight"]["uuid"] == "u1" and list(st.books_) == ["u1"]   # tracked, and nothing else imported
    clock.t += DAY
    assert make().run() == 0
    assert has_readalong(lib, 111) and has_readalong(lib, 222) and st.books_ == {}


def test_a_book_made_before_the_import_is_never_adopted_or_touched(env, monkeypatch):
    monkeypatch.setenv("TZ", "America/Los_Angeles")   # the CronJob's TZ
    time.tzset()
    try:
        lib, st, clock, pushes, make, tmp = env
        made = datetime.fromtimestamp(clock.t - 3 * 3600, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        st.books_["manual-1"] = {"uuid": "manual-1", "title": "A Little Hatred", "createdAt": made,
                                 "readaloud": {"status": "ALIGNED"}, "processingJob": None, "left": None}

        def killed_before_the_request(epub, audio):
            raise KeyboardInterrupt
        real_create = st.create_book
        st.create_book = killed_before_the_request
        with pytest.raises(KeyboardInterrupt):
            make().run()
        st.create_book = real_create
        clock.t += 60
        assert make().run() == 0
        assert not any(c[0] in ("cancel", "delete") and c[1] == "manual-1" for c in st.calls)
        assert "manual-1" in st.books_ and has_readalong(lib, 111)
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


def test_a_new_book_with_another_title_is_left_alone_and_told(env):
    lib, st, clock, pushes, make, tmp = env

    def someone_elses_import_then_killed(epub, audio):
        st.books_["other"] = {"uuid": "other", "title": "Another Book", "createdAt":
                              datetime.fromtimestamp(clock.t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                              "readaloud": {"status": "CREATED"}, "processingJob": None, "left": None}
        raise KeyboardInterrupt
    real_create = st.create_book
    st.create_book = someone_elses_import_then_killed
    with pytest.raises(KeyboardInterrupt):
        make().run()
    st.create_book = real_create
    clock.t += 60
    assert make().run() == 0
    assert "cannot tell which new Storyteller book" in pushes[-1][1]
    assert "other" in st.books_ and not any(c[0] in ("cancel", "delete") and c[1] == "other" for c in st.calls)
    assert has_readalong(lib, 111)                   # started again, under its own import


def test_a_kill_during_close_is_finished_and_told_by_the_next_run(env, monkeypatch):
    lib, st, clock, pushes, make, tmp = env
    st.grade = "D"                                   # this alignment will be refused
    real_record = State.record
    fired = []

    def record(self, *a, **k):                       # SIGKILL right after delete_book()
        if not fired:
            fired.append(1)
            raise KeyboardInterrupt
        return real_record(self, *a, **k)
    monkeypatch.setattr(State, "record", record)
    with pytest.raises(KeyboardInterrupt):
        make().run()
    assert "u1" not in st.books_ and pushes == []
    clock.t += DAY
    assert make().run() == 0
    s = state_of(tmp)
    assert s["in_flight"] is None and "111" in s["refused"] and s["history"][-1]["outcome"] == "refused"
    assert "1 refused" in pushes[-1][0] and "grade D" in pushes[-1][1]
    assert creates(st) == 1


def test_a_kill_while_releasing_storyteller_keeps_the_gated_read_along(env):
    """Once gated and staged, the read-along never depends on Storyteller again."""
    lib, st, clock, pushes, make, tmp = env
    real_delete = st.delete_book

    def delete_then_killed(uuid):                    # the DELETE landed, its answer never did
        real_delete(uuid)
        raise KeyboardInterrupt
    st.delete_book = delete_then_killed
    with pytest.raises(KeyboardInterrupt):
        make().run()
    st.delete_book = real_delete
    assert state_of(tmp)["in_flight"]["gated"] is True and st.books_ == {}
    clock.t += 60
    assert make().run() == 0
    assert has_readalong(lib, 111) and st.downloads == 1 and creates(st) == 1
    assert "published" in pushes[-1][1]


def test_a_failed_flag_update_is_not_a_failed_book(env):
    lib, st, clock, pushes, make, tmp = env
    real_set = lib.set_flag
    calls = {"n": 0}

    def set_flag(book_id, fid, value):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("PATCH /books/111/metadata-and-locks -> HTTP 503")
        return real_set(book_id, fid, value)
    lib.set_flag = set_flag
    assert make().run() == 0
    assert "published" in pushes[-1][1] and "failed" not in pushes[-1][1]
    assert state_of(tmp)["errors"] == {}
    clock.t += DAY
    assert make().run() == 0                         # the nightly flag sync repairs it
    assert lib.detail(111)["customMetadata"][0]["value"] is True


# --- the book changes under us --------------------------------------------------------------

def test_files_changing_during_alignment_abandon_it(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    (folder(tmp) / "01. A Little Hatred.m4b").write_bytes(b"NEW AUDIO" * 50)   # a better m4b was filed
    lib.scan(7)
    clock.t += DAY
    assert make().run() == 0
    assert "files changed" in pushes[-1][1] and released_in_order(st, "u1")


def test_a_file_attached_during_alignment_abandons_it(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    real_sleep = job.sleep
    done = []

    def sleep(s):                                    # the librarian files an unabridged m4b mid-alignment
        if not done:
            done.append(1)
            (folder(tmp) / "01. A Little Hatred (Unabridged).m4b").write_bytes(b"OTHER AUDIO" * 30)
            lib.scan(7)
        real_sleep(s)
    job.sleep = sleep
    job.run()
    assert not has_readalong(lib, 111) and "files changed" in pushes[-1][1]
    assert st.books_ == {} and released_in_order(st, "u1")


def test_a_read_along_from_elsewhere_abandons_ours(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    (folder(tmp) / "01. A Little Hatred (readaloud).epub").write_bytes(OVERLAY + b" made by hand")
    lib.scan(7)
    clock.t += DAY
    assert make().run() == 0
    assert "appeared from elsewhere" in pushes[-1][1] and released_in_order(st, "u1")
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred (readaloud).epub", "01. A Little Hatred.epub",
                                                "01. A Little Hatred.m4b"]


def test_opting_out_during_alignment_abandons_it(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    lib._books[111]["tags"] = [{"id": 9, "name": "no-readalong"}]
    clock.t += DAY
    assert make().run() == 0
    assert "tagged no-readalong" in pushes[-1][1] and released_in_order(st, "u1")
    clock.t += DAY
    make().run()
    assert creates(st) == 1


def test_a_book_deleted_from_bookorbit_is_closed(env):
    lib, st, clock, pushes, make, tmp = env
    lib.add_book(333, "Solo/01. Solo", [(31, "01. Solo.epub", b"E")], title="Solo",   # the library isn't empty
                 updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    st.polls_until_done = 10 ** 6
    make(RUN_HOURS="1", START_HOURS="1").run()
    lib.remove_book(111)
    clock.t += DAY
    assert make().run() == 0
    assert "deleted from BookOrbit" in pushes[-1][1] and released_in_order(st, "u1")
    assert state_of(tmp)["in_flight"] is None


# --- refusals, failures, give-ups -------------------------------------------------------------

def test_a_refusal_is_remembered_for_the_same_files(env):
    lib, st, clock, pushes, make, tmp = env
    st.grade = "D"
    assert make().run() == 0
    assert "1 refused" in pushes[0][0] and "grade D" in pushes[0][1]
    assert sorted(os.listdir(folder(tmp))) == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]
    assert st.books_ == {}                        # the refused alignment is deleted
    pushes.clear()
    assert make().run() == 0
    assert creates(st) == 1 and pushes == []


def test_publish_errors_retry_then_give_up(env):
    lib, st, clock, pushes, make, tmp = env
    lib.scan_fails = True
    for n in range(3):
        clock.t += DAY
        assert make().run() == 0
    assert "gave up after 3 tries" in pushes[-1][1]
    assert st.books_ == {} and creates(st) == 1
    lib.scan_fails = False
    clock.t += DAY
    assert make().run() == 0                      # same files: not retried
    assert creates(st) == 1


def test_a_failure_counts_once_a_night(env):
    """The Job's retry pods must not triple-count one night."""
    lib, st, clock, pushes, make, tmp = env
    lib.scan_fails = True
    for _ in range(3):
        clock.t += 600
        make().run()
    assert state_of(tmp)["errors"]["111"]["count"] == 1


def test_a_deterministic_error_is_given_up_and_the_queue_moves_on(env):
    """An unexpected exception (here: an overlay the SMIL reader rejects) counts like any failure."""
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    open_clip = ('<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq><par><text src="c2.xhtml#a"/>'
                 '<audio src="a.m4a" clipBegin="0s"/></par></seq></body></smil>')

    def bad_download(uuid, dest):
        st.downloads += 1
        with zipfile.ZipFile(dest, "w") as z:
            z.writestr("mimetype", "application/epub+zip")
            z.writestr("META-INF/container.xml", CONTAINER)
            z.writestr("OEBPS/content.opf", OPF)
            z.writestr("OEBPS/s1.smil", S1)
            z.writestr("OEBPS/s2.smil", open_clip)
        return os.path.getsize(dest)
    st.download_readaloud = bad_download
    codes = []
    for _night in range(6):
        clock.t += DAY
        codes.append(make().run())
    s = state_of(tmp)
    assert codes == [0] * 6 and s["in_flight"] is None
    assert creates(st) == 2 and st.books_ == {}   # 111 given up, then 222 had its turn (and gave up)
    assert os.listdir(tmp / "staging") == []


# --- blocked -------------------------------------------------------------------------------

def test_a_blocking_stray_is_parked_told_after_a_day_and_retried(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    stray = folder(tmp) / "01. a little hatred (EBOOK).epub"   # a folder by that name: no scan attaches it
    stray.mkdir()
    make().run()
    s = state_of(tmp)
    assert "111" in s["blocked"] and s["in_flight"] is None
    assert st.books_ == {} and has_readalong(lib, 222)          # released after the gate; the queue moved on
    assert not any("in the way" in b for _t, b in pushes)       # it may clear by itself
    clock.t += DAY
    make().run()
    assert "is in the way" in pushes[-1][1]
    n = len(pushes)
    clock.t += DAY
    make().run()
    assert len(pushes) == n                          # same blocker, told this week already
    stray.rmdir()
    clock.t += DAY
    make().run()
    assert "published" in pushes[-1][1] and has_readalong(lib, 111)
    assert creates(st) == 2 and state_of(tmp)["blocked"] == {}


# --- the run itself -----------------------------------------------------------------------------

def test_an_undelivered_push_fails_the_run_and_is_resent(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    job._push = lambda url, t, b: False
    assert job.run() == 1
    assert "A Little Hatred" in state_of(tmp)["pending_push"]["body"]
    clock.t += DAY
    assert make().run() == 0                         # nothing new tonight, but the old news goes out
    assert len(pushes) == 1 and "1 published" in pushes[0][0] and "A Little Hatred" in pushes[0][1]
    assert state_of(tmp)["pending_push"] is None


def test_a_run_failure_is_told_once_per_window(env):
    lib, st, clock, pushes, make, tmp = env
    real_books = st.books

    def down():
        raise ConnectionError("storyteller is down")
    st.books = down
    assert make().run() == 1
    clock.t += 600
    assert make().run() == 1                         # the retry pod: same failure, not told again
    assert len([b for _t, b in pushes if "run failed" in b]) == 1
    st.books = real_books


def test_a_truncated_or_empty_listing_fails_the_run(env):
    lib, st, clock, pushes, make, tmp = env
    lib.books_by_id = lambda: []
    with pytest.raises(JobError):
        make().run()


def test_a_failed_publish_keeps_its_book_and_starts_no_other(env):
    """A kept book must never be orphaned by starting the next one."""
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    lib.scan_fails = True
    assert make().run() == 0
    state = state_of(tmp)
    assert state["in_flight"]["book"] == 111 and state["in_flight"]["st_released"] is True
    assert st.books_ == {} and creates(st) == 1       # Storyteller's copy freed after the gate
    lib.scan_fails = False
    clock.t += DAY
    assert make().run() == 0                        # 111 finishes, then 222 gets its turn
    assert creates(st) == 2 and has_readalong(lib, 111) and has_readalong(lib, 222)


# --- small parts ---------------------------------------------------------------------------------

def test_phase_reads_the_job_before_the_readaloud():
    from app.readalong.job import DONE, FAILED, NOT_STARTED, PAUSED, RUNNING, phase
    assert phase({"readaloud": {"status": "STOPPED"}, "processingJob": {"status": "PAUSED"}}) == PAUSED
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "PAUSED"}}) == PAUSED
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": {"status": "RUNNING"}}) == RUNNING
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": None}) == DONE
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "DONE"}}) == DONE
    assert phase({"readaloud": {"status": "PROCESSING"}, "processingJob": None}) == RUNNING
    assert phase({"readaloud": {"status": "CREATED"}, "processingJob": None}) == NOT_STARTED
    assert phase({}) == NOT_STARTED
    assert phase({"readaloud": {"status": "ERROR"}, "processingJob": None}) == FAILED
    assert phase({"readaloud": {"status": "STOPPED"}, "processingJob": None}) == FAILED
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "ERROR"}}) == FAILED
    assert phase({"readaloud": {"status": "ALIGNED"}, "processingJob": {"status": "CANCELED"}}) == FAILED


def test_created_at_without_a_zone_is_utc(monkeypatch):
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    try:
        assert st_created({"createdAt": "2026-09-22 07:53:21"}) == calendar.timegm((2026, 9, 22, 7, 53, 21))
        assert st_created({"createdAt": "2026-09-22T07:53:21Z"}) == calendar.timegm((2026, 9, 22, 7, 53, 21))
        assert st_created({"createdAt": None}) is None
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


class _Client:
    def __init__(self, pages=None, total=None, error=None):
        self.pages, self.total, self.error, self.posts = pages or [], total, error, []

    def post(self, path, payload):
        self.posts.append((path, payload))
        page = payload["pagination"]["page"]
        return {"items": self.pages[page] if page < len(self.pages) else [], "total": self.total}

    def get(self, path):
        if self.error:
            raise RuntimeError(self.error)
        return {"id": 1, "path": path}


class _Writer:
    def __init__(self):
        self.calls = []

    def scan_running(self, lib):
        self.calls.append(("running", lib))
        return False

    def scan(self, lib, timeout):
        self.calls.append(("scan", lib, timeout))
        return 41

    def wait_scan(self, lib, after, timeout):
        self.calls.append(("wait", lib, after, timeout))

    def patch_metadata(self, book_id, metadata, locked):
        self.calls.append(("patch", book_id, metadata, locked))


def test_the_bookorbit_adapter_pages_the_whole_listing():
    c = _Client(pages=[[{"id": i} for i in range(100)], [{"id": i} for i in range(100, 105)]], total=105)
    assert [b["id"] for b in Bookorbit(c, None).books()] == list(range(105))
    assert [p["pagination"] for _path, p in c.posts] == [{"page": 0, "size": 100}, {"page": 1, "size": 100}]
    with pytest.raises(JobError):                       # a page came back short: never judge half a library
        Bookorbit(_Client(pages=[[{"id": i} for i in range(100)]], total=150), None).books()
    with pytest.raises(JobError):
        Bookorbit(_Client(pages=[[{"id": 1}]], total=None), None).books()


def test_the_bookorbit_adapter_maps_only_a_404_to_book_gone():
    with pytest.raises(BookGone):
        Bookorbit(_Client(error="GET /books/404 -> HTTP 404: {\"message\":\"Not Found\"}"), None).detail(404)
    with pytest.raises(RuntimeError, match="HTTP 500"):  # a book id or body containing 404 is not a 404
        Bookorbit(_Client(error="GET /books/404 -> HTTP 500: 404 upstream"), None).detail(404)
    assert Bookorbit(_Client(), None).detail(7) == {"id": 1, "path": "/books/7"}


def test_the_bookorbit_adapter_scans_and_flags_through_the_writer():
    w = _Writer()
    bo = Bookorbit(None, w)
    bo.scan(7)
    bo.set_flag(111, 2, True)
    assert w.calls == [("scan", 7, 1800), ("wait", 7, 41, 1800),
                       ("patch", 111, {"customMetadata": [{"fieldId": 2, "value": True}]}, [])]
