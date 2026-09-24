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
    """Speaks beta.38's shape (probed on the live server 2026-09-23). After the
    import `readaloud` is null and there is no job; the title comes from the
    EPUB's metadata and `ebook.fileSize` is the imported EPUB's size; `process`
    gives QUEUED/PROCESSING -> ALIGNED with `processingJob` RUNNING, null once
    it ends. A failure is readaloud ERROR or STOPPED with no job; a pause is
    readaloud STOPPED with the job PAUSED. `createdAt` is UTC with no zone, and
    an unknown uuid is a 404 -- all as the real server and client do."""

    def __init__(self, clock, polls_until_done=2, grade="S", library_root=None):
        self.clock = clock
        self.library_root = library_root          # this test's view of Storyteller's /library
        self.drop_ebook = 0                        # imports that lose beta.38's EPUB/audio race
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
        def size(path):
            return os.path.getsize(os.path.join(self.library_root, path[len("/library/"):])) if self.library_root else 1
        stem = os.path.splitext(os.path.basename(epub))[0]
        ebook = {"filepath": f"/data/assets/{stem}/text/{stem}.epub", "fileSize": size(epub) + 1000}  # upgraded copy
        if self.drop_ebook > 0:                    # the audio candidate won: the EPUB was dropped
            self.drop_ebook -= 1
            ebook = {"filepath": None, "fileSize": None}
        self.books_[uuid] = {"uuid": uuid, "title": stem.split(". ", 1)[-1],       # the EPUB's own title
                             "createdAt": made, "readaloud": None, "processingJob": None, "ebook": ebook,
                             "audiobook": {"filepath": f"/data/assets/{stem}/audio", "fileSize": size(audio)},
                             "left": None}
        self.calls.append(("create", epub, audio))
        return uuid

    def process(self, uuid):
        """beta.38: an active job (queued, running or PAUSED) is returned unchanged -- process never resumes."""
        b = self._get(uuid)
        self.calls.append(("process", uuid))
        if (b["processingJob"] or {}).get("status") in ("QUEUED", "RUNNING", "PAUSED"):
            return
        b.update(readaloud={"status": "PROCESSING"}, processingJob={"status": "RUNNING"}, left=self.polls_until_done)

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
        """A listing is a snapshot: it does not move an alignment along."""
        return [{k: v for k, v in b.items() if k != "left"} for b in self.books_.values()] + self.foreign

    def alignment_report(self, uuid):
        if uuid not in self.books_ or self.report_missing:    # the real client answers None on a 404
            return None
        return {"grade": self.grade}

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
SHORT = {"RUN_HOURS": "1", "START_HOURS": "1", "FINISH_HOURS": "0.5"}    # a run that ends mid-alignment


@pytest.fixture
def env(tmp_path):
    books = tmp_path / "books"
    lib = FakeLibrary(books)
    lib.add_book(111, "Joe Abercrombie/The Age of Madness/01. A Little Hatred",
                 [(11, "01. A Little Hatred.epub", b"PLAIN"), (12, "01. A Little Hatred.m4b", b"AUDIO" * 20)],
                 title="A Little Hatred", updatedAt="2026-09-20T10:00:00.000Z",
                 customMetadata=[{"fieldId": 2, "value": False}])
    clock = Clock()
    st = FakeStoryteller(clock, library_root=books)
    pushes = []

    def make(**extra):
        s = Settings.from_env({**ENV, "STATE_DIR": str(tmp_path / "state"), "MEDIA_BOOKS": str(books),
                               "STAGING_DIR": str(tmp_path / "staging"), **extra})
        os.makedirs(s.state_dir, exist_ok=True)
        return Job(s, bo=lib, st=st, push=lambda url, t, b: pushes.append((t, b)) or True,
                   clock=clock, sleep=clock.sleep, monotonic=clock, duration=lambda path: 40.0,
                   tools=lambda: None)
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
    assert make(**SHORT).run() == 0
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


def test_a_retry_pod_continues_its_jobs_window(env):
    lib, st, clock, pushes, make, tmp = env
    first = make(JOB_ID="readalong-1")
    first._push = lambda url, t, b: False            # exit 1: the Job starts a retry pod
    assert first.run() == 1
    clock.t += 2 * 3600
    assert make(JOB_ID="readalong-1").t0 == first.t0          # not a fresh 3.5 h to start books in
    assert make(JOB_ID="readalong-2").t0 == clock.t           # another Job is another window
    assert make().t0 == clock.t


def test_an_evening_manual_run_does_not_eat_the_nightly_window(env):
    lib, st, clock, pushes, make, tmp = env
    manual = make(JOB_ID="readalong-manual-1")     # the owner runs it by hand at ~20:00
    assert manual.run() == 0 and has_readalong(lib, 111)
    add_other(lib)
    clock.t = manual.t0 + 4.5 * 3600                 # the CronJob's own Job at 00:30
    assert make(JOB_ID="librarian-readalong-29801234").run() == 0
    assert has_readalong(lib, 222)


def test_a_retry_pod_after_a_full_run_only_finishes_up(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_report = st.alignment_report
    st.alignment_report = lambda uuid: {"grade": "D"} if uuid == "u1" else real_report(uuid)   # 111: refused
    real_process = st.process

    def process(uuid):                               # 222 still aligning at RUN_HOURS
        real_process(uuid)
        if uuid == "u2":
            st.books_[uuid]["left"] = 10 ** 6
    st.process = process
    first = make(JOB_ID="j")
    first._push = lambda url, t, b: False            # the end-of-run push fails -> exit 1 -> a retry pod
    assert first.run() == 1
    clock.t += 10
    st.books_["u2"]["left"] = 1                      # 222 finishes just as the retry pod starts
    retry = make(JOB_ID="j")
    assert retry.run() == 0
    assert retry.t0 == first.t0 and not has_readalong(lib, 222)  # past the window: no publish begins
    assert "1 refused" in pushes[-1][0] and "grade D" in pushes[-1][1]        # but the news goes out


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


def test_an_owners_pause_is_left_alone_and_told_once(env):
    """beta.38's process never resumes a paused job; the pause is the owner's to lift."""
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_process = st.process
    once = {"n": 1}

    def process(uuid):
        real_process(uuid)
        if once["n"]:
            once["n"] = 0
            st.pause(uuid)                           # the owner pauses it in Storyteller's UI
    st.process = process
    for _ in range(3):
        clock.t += DAY
        assert make().run() == 0
    assert st.books_["u1"]["processingJob"] == {"status": "PAUSED"} and creates(st) == 1   # the queue waits
    assert len([b for _t, b in pushes if "paused in Storyteller" in b]) == 1
    assert not any("still aligning" in b for _t, b in pushes)
    st.books_["u1"].update(readaloud={"status": "PROCESSING"}, processingJob={"status": "RUNNING"}, left=1)
    clock.t += DAY
    assert make().run() == 0                         # resumed by the owner: published, then the queue moves
    assert has_readalong(lib, 111) and has_readalong(lib, 222)


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
    make(**SHORT).run()
    st.books_.pop("u1")                               # the owner cleans Storyteller up in its UI
    clock.t += DAY
    assert make(**SHORT).run() == 0
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
    assert state_of(tmp)["in_flight"]["uuid"] is None and st.books_["u1"]["readaloud"] is None
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
        assert make().run() == 0                     # the import may still be landing: wait, never import again
        assert creates(st) == 0 and state_of(tmp)["in_flight"]["uuid"] is None
        clock.t += DAY
        assert make().run() == 0                     # nothing landed within the hour: started afresh
        assert not any(c[1] == "manual-1" for c in st.calls if c[0] in ("process", "cancel", "delete"))
        assert "manual-1" in st.books_ and has_readalong(lib, 111) and creates(st) == 1
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


def test_a_new_book_with_another_title_is_left_alone_and_told(env):
    lib, st, clock, pushes, make, tmp = env

    def someone_elses_import_then_killed(epub, audio):
        st.books_["other"] = {"uuid": "other", "title": "Another Book", "createdAt":
                              datetime.fromtimestamp(clock.t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                              "readaloud": None, "processingJob": None, "ebook": {"filepath": "/x", "fileSize": 999},
                              "audiobook": {"filepath": "/y", "fileSize": 999}, "left": None}
        raise KeyboardInterrupt
    real_create = st.create_book
    st.create_book = someone_elses_import_then_killed
    with pytest.raises(KeyboardInterrupt):
        make().run()
    st.create_book = real_create
    clock.t += 60
    assert make().run() == 0 and creates(st) == 0    # within the hour: ours may still be landing
    clock.t += DAY
    assert make().run() == 0
    assert "is certainly its own" in pushes[-1][1] and "Another Book" in pushes[-1][1]
    assert "other" in st.books_
    assert not any(c[1] == "other" for c in st.calls if c[0] in ("process", "cancel", "delete"))
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
    make(**SHORT).run()
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
    make(**SHORT).run()
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
    make(**SHORT).run()
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
    make(**SHORT).run()
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
    assert any("A Little Hatred" in line for line in state_of(tmp)["pending_push"]["lines"])
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
    assert make(JOB_ID="j").run() == 1
    clock.t += 600
    assert make(JOB_ID="j").run() == 1             # the retry pod: same failure, not told again
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
    assert phase({"readaloud": None, "processingJob": None}) == NOT_STARTED    # beta.38 right after the import
    assert phase({}) == FAILED                       # an unreadable shape is counted, never waited on
    assert phase({"readAloud": None, "processingJob": None}) == FAILED
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
    assert w.calls == [("scan", 7, 900), ("wait", 7, 41, 900),
                       ("patch", 111, {"customMetadata": [{"fieldId": 2, "value": True}]}, [])]


# --- second review round: regressions ---------------------------------------------------------

def utc(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def add_dune(lib):
    lib.add_book(333, "Frank Herbert/Dune/01. Dune",
                 [(31, "01. Dune.epub", b"PLAIN3"), (32, "01. Dune.m4b", b"AUDIO3" * 20)],
                 title="Dune", updatedAt="2026-09-21T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])


def test_a_storyteller_book_that_cannot_be_freed_never_holds_the_queue(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_delete = st.delete_book

    def delete(uuid):                                # Storyteller's DELETE keeps failing for this one book
        if uuid == "u1":
            raise StorytellerHTTPError(f"DELETE /api/v2/books/{uuid} -> 500: b'EBUSY'", 500)
        return real_delete(uuid)
    st.delete_book = delete
    codes = []
    for _ in range(5):
        clock.t += DAY
        codes.append(make().run())
    assert codes == [0] * 5 and has_readalong(lib, 111) and has_readalong(lib, 222)
    assert list(state_of(tmp)["to_release"]) == ["u1"]           # still parked, retried every run
    assert len([b for _t, b in pushes if "cannot be deleted" in b]) == 1
    st.delete_book = real_delete
    clock.t += DAY
    make().run()
    assert state_of(tmp)["to_release"] == {} and "u1" not in st.books_


def test_a_cancelled_alignment_is_waited_for_before_the_delete(env):
    """A cancel only signals the worker; deleting under it races its shutdown."""
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(**SHORT).run()
    stops_after = {"polls": 2}
    real_book, seen = st.book, []

    def cancel(uuid):                                # the job keeps running for a couple of polls
        st.calls.append(("cancel", uuid))

    def book(uuid):
        b = real_book(uuid)
        if ("cancel", uuid) in st.calls:
            stops_after["polls"] -= 1
            if stops_after["polls"] <= 0:
                st.books_[uuid].update(readaloud={"status": "STOPPED"}, processingJob=None)
            seen.append(st.books_[uuid]["processingJob"])
        return real_book(uuid) if stops_after["polls"] <= 0 else b
    st.cancel_processing, st.book = cancel, book
    lib._books[111]["tags"] = ["no-readalong"]       # abandon: release u1 while it aligns
    clock.t += DAY
    make().run()
    assert ("delete", "u1") in st.calls and seen[-1] is None     # deleted only once it had stopped


def test_a_read_along_from_elsewhere_during_the_publish_is_never_joined(env):
    lib, st, clock, pushes, make, tmp = env

    def foreign_arrives(_fake):                      # lands while our rename phase is being scanned
        (folder(tmp) / "01. A Little Hatred (readaloud).epub").write_bytes(OVERLAY + b" made by hand")
    lib.hook_before_scan = foreign_arrives
    make().run()
    ras = [f["filename"] for f in lib.detail(111)["files"] if f["mediaOverlay"]["available"]]
    assert ras == ["01. A Little Hatred (readaloud).epub"]        # ours was not linked beside it
    assert "from elsewhere" in pushes[-1][1] and state_of(tmp)["in_flight"] is None


def test_the_owners_later_import_of_a_series_mate_is_never_adopted(env):
    lib, st, clock, pushes, make, tmp = env
    add_dune(lib)

    def lost(epub, audio):                           # our import's fate is unknown (a reset, not a refusal)
        raise ConnectionError("connection reset by peer")
    real_create = st.create_book
    st.create_book = lost
    night1 = make(ONLY="333")
    night1.duration = lambda path: 21 * 3600.0
    assert night1.run() == 0 and state_of(tmp)["in_flight"]["uuid"] is None
    st.create_book = real_create
    clock.t += 12 * 3600                             # next day the owner imports the sequel by hand
    for uuid, title in (("owner-1", "02. Dune Messiah"), ("owner-2", "01. Dune")):
        st.books_[uuid] = {"uuid": uuid, "title": title, "createdAt": utc(clock.t),
                           "readaloud": {"status": "ALIGNED"}, "processingJob": None, "left": None}
    clock.t += 12 * 3600
    assert make(ONLY="333").run() == 0               # (the fake's alignment is 40 s: fits Dune's fake m4b)
    touched = [c for c in st.calls if c[0] in ("process", "cancel", "delete") and c[1].startswith("owner")]
    assert touched == [] and sorted(u for u in st.books_) == ["owner-1", "owner-2"]
    assert creates(st) == 1 and has_readalong(lib, 333)          # its own, fresh import instead
    assert state_of(tmp)["refused"] == {}


def test_a_kill_later_in_the_run_loses_no_line(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    job = make()
    real_sleep = job.sleep

    def sleep(s):                                    # OOM-kill / node loss while 222 aligns
        if has_readalong(lib, 111) and creates(st) == 2:
            raise KeyboardInterrupt
        real_sleep(s)
    job.sleep = sleep
    with pytest.raises(KeyboardInterrupt):
        job.run()
    assert pushes == []
    clock.t += DAY
    make().run()
    assert any("A Little Hatred" in b and "published" in b for _t, b in pushes)


def test_one_failure_one_line(env):
    lib, st, clock, pushes, make, tmp = env
    real_process = st.process
    n = {"calls": 0}

    def process(uuid):
        n["calls"] += 1
        if n["calls"] == 1:
            real_process(uuid)
            st.fail(uuid)                            # the alignment errors out
            return
        raise StorytellerHTTPError(f"POST /api/v2/books/{uuid}/process -> 409: b'busy'", 409)
    st.process = process
    make().run()
    assert len([ln for ln in pushes[-1][1].splitlines() if "A Little Hatred" in ln]) == 1
    assert state_of(tmp)["errors"]["111"]["count"] == 1


def test_a_broken_job_charges_no_book(env):
    """ffprobe missing (an image regression): the preflight fails the run before any book is charged."""
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    add_dune(lib)

    def no_ffprobe():
        raise FileNotFoundError("[Errno 2] No such file or directory: 'ffprobe'")
    codes = []
    for _ in range(3):
        clock.t += DAY
        job = make()
        job.tools = no_ffprobe
        codes.append(job.run())
    assert codes == [1, 1, 1] and state_of(tmp)["errors"] == {} and creates(st) == 0
    assert all("run failed" in b and "ffprobe" in b for _t, b in pushes)


def test_three_bad_books_in_a_row_are_charged_and_then_the_queue_moves_on(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    add_dune(lib)
    lib.add_book(444, "Older/01. Older", [(41, "01. Older.epub", b"P4"), (42, "01. Older.m4b", b"A4" * 9)],
                 title="Older", updatedAt="2026-09-01T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    bad = {"Hatred": "corrupt m4b", "Other": "no such file", "Dune": "moov atom not found"}

    def duration(path):
        for key, why in bad.items():
            if key in path:
                raise RuntimeError(why)
        return 40.0
    for night in range(1, 5):
        clock.t += DAY
        job = make()
        job.duration = duration
        job.run()
        if night < 4:
            assert creates(st) == 0                  # three in a row: no more starts tonight
    s = state_of(tmp)
    assert {k: v["count"] for k, v in s["errors"].items()} == {"111": 3, "222": 3, "333": 3}
    assert has_readalong(lib, 444)                   # the others given up: the queue went on


def test_a_book_specific_start_error_is_charged_and_the_queue_moves_on(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    job = make()

    def duration(path):
        if "Hatred" in path:
            raise FileNotFoundError(f"[Errno 2] No such file or directory: '{path}'")
        return 40.0
    job.duration = duration
    assert job.run() == 0
    assert state_of(tmp)["errors"]["111"]["count"] == 1 and has_readalong(lib, 222)
    assert "could not start" in pushes[-1][1]


def test_an_import_storyteller_refused_does_not_hold_the_queue(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_create = st.create_book

    def create(epub, audio):                         # a definitive answer: nothing was imported
        if "Hatred" in epub:
            raise StorytellerHTTPError("POST /api/v2/books -> 405: b'Unable to create book'", 405)
        return real_create(epub, audio)
    st.create_book = create
    assert make().run() == 0
    s = state_of(tmp)
    assert has_readalong(lib, 222) and s["errors"]["111"]["count"] == 1 and s["in_flight"] is None
    assert list(st.books_) == []                     # nothing orphaned


def test_an_unknown_status_shape_is_counted_and_given_up(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real_book = st.book

    def renamed(uuid):                               # e.g. a Storyteller upgrade renames `readaloud`
        b = dict(real_book(uuid))
        b["readAloud"] = b.pop("readaloud")
        b.pop("processingJob", None)
        return b
    st.book = renamed
    for _ in range(4):
        clock.t += DAY
        make().run()
    assert "gave up after 3 tries" in "\n".join(b for _t, b in pushes)
    assert creates(st) == 2                          # the queue moved on to 222


def test_an_import_landing_after_the_retry_pod_is_adopted_not_duplicated(env):
    lib, st, clock, pushes, make, tmp = env
    t_request = []

    def killed_mid_request(epub, audio):             # the server is still copying the m4b when the pod dies
        t_request.append(clock.t)
        raise KeyboardInterrupt
    real_create = st.create_book
    st.create_book = killed_mid_request
    with pytest.raises(KeyboardInterrupt):
        make().run()
    st.create_book = real_create
    clock.t += 30                                    # the Job's retry pod, before the import has landed
    assert make().run() == 0 and creates(st) == 0
    st.books_["u-late"] = {"uuid": "u-late", "title": "A Little Hatred", "createdAt": utc(t_request[0] + 45),
                           "readaloud": None, "processingJob": None,
                           "ebook": {"filepath": "/data/assets/A Little Hatred/text/x.epub", "fileSize": 1005},
                           "audiobook": {"filepath": "/data/assets/A Little Hatred/audio",
                                         "fileSize": len(b"AUDIO" * 20)}, "left": None}
    clock.t += DAY
    assert make().run() == 0
    assert creates(st) == 0 and has_readalong(lib, 111) and st.books_ == {}   # the late import, adopted


def test_the_books_own_file_in_the_way_is_never_reported(env, monkeypatch):
    """BookOrbit's own rename can put the book's file back at a name mid-publish: retry, never tell."""
    lib, st, clock, pushes, make, tmp = env
    from app.readalong import job as jobmod
    from app.readalong.publish import PublishConflict
    real_publish, n = jobmod.publish, {"calls": 0}

    def publish(*a, **k):
        n["calls"] += 1
        if n["calls"] <= 2:
            raise PublishConflict("in the way", str(folder(tmp) / "01. A Little Hatred.epub"))
        return real_publish(*a, **k)
    monkeypatch.setattr(jobmod, "publish", publish)
    for _ in range(3):
        clock.t += DAY
        make().run()
    assert not any("in the way" in b for _t, b in pushes) and has_readalong(lib, 111)



# --- third review round ------------------------------------------------------------------------

def test_an_import_that_lost_the_race_is_deleted_and_retried(env):
    lib, st, clock, pushes, make, tmp = env
    st.drop_ebook = 1                                # beta.38 dropped the EPUB of the first import
    assert make().run() == 0
    assert creates(st) == 2 and ("delete", "u1") in st.calls and has_readalong(lib, 111)
    assert state_of(tmp)["errors"] == {}


def test_an_import_that_loses_the_race_twice_is_charged(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    st.drop_ebook = 2
    assert make().run() == 0
    assert ("delete", "u1") in st.calls and ("delete", "u2") in st.calls
    assert state_of(tmp)["errors"]["111"]["count"] == 1 and "dropped the EPUB" in pushes[-1][1]
    assert has_readalong(lib, 222)                   # the queue moved on


def test_an_epub2_import_is_adopted_by_its_audio(env):
    """Storyteller rewrites an EPUB 2 into an EPUB 3: only the audio keeps its size."""
    lib, st, clock, pushes, make, tmp = env
    real_create = st.create_book

    def killed_after_the_import(epub, audio):
        real_create(epub, audio)
        raise KeyboardInterrupt
    st.create_book = killed_after_the_import
    with pytest.raises(KeyboardInterrupt):
        make().run()
    assert st.books_["u1"]["ebook"]["fileSize"] != len(b"PLAIN")    # the fake's upgraded copy
    st.create_book = real_create
    clock.t += 60
    assert make().run() == 0
    assert creates(st) == 1 and has_readalong(lib, 111)


def test_a_cancel_that_does_not_stop_is_parked_not_deleted(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    make(**SHORT).run()

    def cancel(uuid):                                # the worker ignores the signal for now
        st.calls.append(("cancel", uuid))
    real_cancel, st.cancel_processing = st.cancel_processing, cancel
    lib._books[111]["tags"] = ["no-readalong"]
    clock.t += DAY
    make().run()
    assert ("delete", "u1") not in st.calls and list(state_of(tmp)["to_release"]) == ["u1"]
    assert not any("not mine" in b for _t, b in pushes)          # our own parked book is not someone else's
    st.cancel_processing = real_cancel
    clock.t += DAY
    make().run()
    assert ("delete", "u1") in st.calls and state_of(tmp)["to_release"] == {}


def test_a_retry_pod_does_not_retell_a_counted_failure(env):
    lib, st, clock, pushes, make, tmp = env
    lib.scan_fails = True
    first = make(JOB_ID="j")
    first._push = lambda url, t, b: False            # exit 1 -> the retry pod
    assert first.run() == 1
    clock.t += 60
    make(JOB_ID="j").run()
    lines = [ln for _t, b in pushes for ln in b.splitlines() if "A Little Hatred" in ln]
    assert len(lines) == 1 and state_of(tmp)["errors"]["111"]["count"] == 1


def test_a_long_outage_keeps_the_newest_lines(env):
    lib, st, clock, pushes, make, tmp = env
    job = make()
    job.state.pending_push = {"lines": [f"old {i}" for i in range(60)], "published": 0, "refused": 0}
    job._tell("newest")
    assert job.report() == 0
    body = pushes[-1][1].splitlines()
    assert body[0].startswith("… 21 older lines dropped") and body[-1] == "newest" and "old 59" in body
