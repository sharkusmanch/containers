"""Read-along worker: the tick -- one look between nightly runs at the book in
Storyteller and at the books the librarian asked for (app/readalong/wanted.py)."""
import json
import os

from app.readalong import wanted
from app.readalong.storyteller import StorytellerHTTPError
from tests.test_readalong_job import (DAY, add_other, creates, env, folder, has_readalong,  # noqa: F401
                                      state_of)

FRESH = "2027-01-15T07:59:00.000Z"                 # a minute before the fake clock: inside the quiet period


def ask(tmp, book_id, at):
    wanted.write(str(tmp / "wanted"), book_id, now=at, arrival=f"manual:{book_id}.m4b:abc")


def asked(tmp):
    d = tmp / "wanted"
    return sorted(int(n.split(".")[0]) for n in os.listdir(d) if n.endswith(".json")) if d.exists() else []


def counting(lib):
    seen = []
    real = lib.detail

    def detail(bid):
        seen.append(bid)
        return real(bid)
    lib.detail = detail
    return seen


def test_an_idle_tick_calls_nothing(env):
    lib, st, clock, pushes, make, tmp = env
    seen = counting(lib)
    assert make().tick() == 0
    assert seen == [] and st.calls == [] and pushes == []


def test_an_unsettled_ask_waits(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 60)                        # BookOrbit may still be settling
    assert make().tick() == 0
    assert st.calls == [] and asked(tmp) == [111]


def test_an_asked_book_starts_at_once_despite_the_quiet_period(env):
    lib, st, clock, pushes, make, tmp = env
    lib._books[111]["updatedAt"] = FRESH               # just filed: the nightly would skip it
    ask(tmp, 111, clock.t - 400)
    t = clock.t
    assert make().tick() == 0
    assert creates(st) == 1 and ("process", "u1") in st.calls
    assert clock.t == t                                # one look: never a sleep
    assert asked(tmp) == [] and state_of(tmp)["in_flight"]["book"] == 111


def test_later_ticks_publish_as_soon_as_storyteller_is_done(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 3
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # started
    for _ in range(5):
        clock.t += 60
        make().tick()
    assert has_readalong(lib, 111) and state_of(tmp)["in_flight"] is None
    assert "published" in pushes[-1][1] and st.books_ == {}


def test_a_failed_alignment_is_left_to_the_nightly(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    make().tick()
    st.fail("u1")
    n = len(st.calls)
    clock.t += 60
    assert make().tick() == 0
    assert st.calls[n:] == [] and state_of(tmp)["errors"] == {}      # not re-processed, not counted


def test_a_book_with_a_recent_error_is_left_alone(env):
    lib, st, clock, pushes, make, tmp = env
    lib.scan_fails = True
    ask(tmp, 111, clock.t - 400)
    st.polls_until_done = 1
    make().tick()
    clock.t += 60
    make().tick()                                      # the publish fails: counted once
    assert state_of(tmp)["errors"]["111"]["count"] == 1
    attempts = lib.scan_attempts
    assert attempts >= 1
    for _ in range(3):
        clock.t += 60
        make().tick()
    assert lib.scan_attempts == attempts and state_of(tmp)["errors"]["111"]["count"] == 1   # no rescan every minute


def test_an_ask_for_a_book_that_is_no_candidate_is_dropped(env):
    lib, st, clock, pushes, make, tmp = env
    lib.add_book(333, "Solo/01. Solo", [(31, "01. Solo.epub", b"E")], title="Solo",
                 updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    lib.add_book(444, "Comics/01. X", [(41, "01. X.epub", b"E"), (42, "01. X.m4b", b"A")], library_id=3)
    for bid in (333, 444, 999):                        # no pair; another library; deleted
        ask(tmp, bid, clock.t - 400)
    assert make().tick() == 0
    assert asked(tmp) == [] and creates(st) == 0


def test_an_ask_waits_while_storyteller_is_busy_or_only_excludes_it(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "x", "title": "Manual", "readaloud": {"status": "PROCESSING"},
                   "processingJob": {"status": "RUNNING"}}]
    ask(tmp, 111, clock.t - 400)
    make().tick()
    assert creates(st) == 0 and asked(tmp) == [111]
    st.foreign = []
    make(ONLY="222").tick()
    assert creates(st) == 0 and asked(tmp) == [111]
    make().tick()
    assert creates(st) == 1 and asked(tmp) == []


def test_a_failed_start_is_charged_and_its_ask_dropped(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    job = make()

    def duration(path):
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{path}'")
    job.duration = duration
    assert job.tick() == 0
    assert state_of(tmp)["errors"]["111"]["count"] == 1 and asked(tmp) == []
    assert "could not start" in pushes[-1][1]


def test_at_most_one_start_per_tick(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    ask(tmp, 222, clock.t - 900)
    ask(tmp, 111, clock.t - 400)
    make().tick()
    assert creates(st) == 1 and state_of(tmp)["in_flight"]["book"] == 222   # the oldest ask first
    assert asked(tmp) == [111]
    for _ in range(6):
        clock.t += 60
        make().tick()
    assert has_readalong(lib, 222) and has_readalong(lib, 111) and asked(tmp) == []


def test_a_tick_in_dry_run_does_nothing(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    assert make(DRY_RUN="true").tick() == 0
    assert st.calls == [] and asked(tmp) == [111]


def test_a_failing_tick_is_told_once_a_day(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)

    def down():
        raise StorytellerHTTPError("GET /api/v2/books -> 502: b'bad gateway'", 502)
    st.books = down                                    # the busy check cannot tell: the tick fails
    assert make().tick() == 1
    clock.t += 60
    assert make().tick() == 1
    told = [b for _t, b in pushes if "failing between runs" in b]
    assert len(told) == 1 and asked(tmp) == [111]      # the ask stays; nothing charged
    assert state_of(tmp)["errors"] == {}
    clock.t += DAY
    make().tick()
    assert len([b for _t, b in pushes if "failing between runs" in b]) == 2


def test_a_tick_adopts_a_landed_import_without_polling(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    real_create = st.create_book

    def killed_after_the_import(epub, audio):
        real_create(epub, audio)
        raise KeyboardInterrupt
    st.create_book = killed_after_the_import
    try:
        make().tick()
    except KeyboardInterrupt:
        pass
    st.create_book = real_create
    clock.t += 60
    t = clock.t
    assert make().tick() == 0
    assert state_of(tmp)["in_flight"]["uuid"] == "u1" and ("process", "u1") in st.calls
    assert clock.t == t and creates(st) == 1


def test_a_re_ask_during_the_tick_is_kept(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    real_create = st.create_book

    def create(epub, audio):                          # the librarian files the book again meanwhile
        ask(tmp, 111, clock.t)
        return real_create(epub, audio)
    st.create_book = create
    make().tick()
    assert creates(st) == 1 and asked(tmp) == [111]
    marker = json.load(open(tmp / "wanted" / "111.json"))
    assert marker["at"] == clock.t


def test_the_nightly_starts_asked_books_first_and_drops_their_asks(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)                                     # older than 111: normally second
    lib._books[222]["updatedAt"] = FRESH               # and just filed: normally skipped
    ask(tmp, 222, clock.t - 400)
    assert make().run() == 0
    first = next(c for c in st.calls if c[0] == "create")
    assert "Other" in first[1] and asked(tmp) == []
    assert has_readalong(lib, 222) and has_readalong(lib, 111)


def test_a_failing_look_backs_off_and_is_charged_from_the_second_failure(env):
    """A failure while looking (a download, a publish, Storyteller) must never repeat
    every minute, and one blip (a restart) must not charge the book or tell anyone."""
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    make().tick()
    calls = []

    def book(uuid):
        calls.append(clock.t)
        raise StorytellerHTTPError(f"GET /api/v2/books/{uuid} -> 503: b'restarting'", 503)
    st.book = book
    t0 = clock.t

    def tick_until(minutes):                            # a tick every minute up to t0 + minutes
        while clock.t < t0 + minutes * 60:
            clock.t += 60
            make().tick()
    tick_until(30)                                      # the first failure, then half an hour of ticks
    assert [c - t0 for c in calls] == [60]
    s = state_of(tmp)
    assert s["errors"] == {} and s["in_flight"]["look_fails"] == 1 and not pushes   # a blip: logged only
    tick_until(92)                                      # 30 min after it the second -> charged, told
    assert [c - t0 for c in calls] == [60, 60 + 1800, 60 + 1800 + 3600]            # then 1 h
    s = state_of(tmp)
    assert s["errors"]["111"]["count"] == 1 and s["in_flight"]["uuid"] == "u1"
    assert len([b for _t, b in pushes if "failed" in b]) == 1                       # the third is not re-told
    tick_until(3 * 24 * 60)                             # days of ticks alone (no nightly run to retry it):
    gaps = [b - a for a, b in zip(calls, calls[1:])]    # the waits double up to ERROR_INTERVAL ...
    assert gaps[:7] == [1800, 3600, 7200, 14400, 28800, 57600, 20 * 3600]
    assert state_of(tmp)["in_flight"] is None           # ... and one count per 20 h gives up at the third
    assert [b for _t, b in pushes if "gave up after 3 tries" in b]


def test_a_clean_look_resets_the_backoff(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6                      # keeps aligning
    ask(tmp, 111, clock.t - 400)
    make().tick()
    real = st.book
    fail = {"on": True}

    def book(uuid):
        if fail["on"]:
            raise StorytellerHTTPError(f"GET /api/v2/books/{uuid} -> 502: b'bad gateway'", 502)
        return real(uuid)
    st.book = book
    clock.t += 60
    make().tick()                                      # blip 1
    fail["on"] = False
    clock.t += 1800
    make().tick()                                      # a clean look: reset
    assert "look_fails" not in state_of(tmp)["in_flight"]
    fail["on"] = True
    clock.t += 60
    make().tick()                                      # blip 2, not "the second in a row"
    assert state_of(tmp)["errors"] == {} and state_of(tmp)["in_flight"]["look_fails"] == 1


def test_the_nightly_clears_a_look_backoff(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6                      # still aligning when the nightly run ends
    ask(tmp, 111, clock.t - 400)
    make().tick()
    real = st.book
    st.book = lambda uuid: (_ for _ in ()).throw(StorytellerHTTPError("GET -> 503", 503))
    clock.t += 60
    make().tick()
    st.book = real
    assert state_of(tmp)["in_flight"]["look_fails"] == 1
    assert make(RUN_HOURS="1", START_HOURS="1", FINISH_HOURS="0.5").run() == 0
    fl = state_of(tmp)["in_flight"]
    assert fl["book"] == 111 and "look_fails" not in fl and "look_failed_at" not in fl


def test_a_nightly_stopped_before_its_starts_keeps_the_asks(env):
    """A rollout or a node drain during the nightly (k3s patches land 00:00-06:00):
    the asks it did not serve stay for the resumed run and the ticks."""
    lib, st, clock, pushes, make, tmp = env
    lib._books[111]["updatedAt"] = FRESH               # just filed: only the ask gets it aligned tonight
    lib.add_book(333, "Solo/01. Solo", [(31, "01. Solo.epub", b"E")], title="Solo",
                 updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    ask(tmp, 111, clock.t - 400)
    ask(tmp, 333, clock.t - 400)                       # no candidate: a finished run would drop it
    job = make()
    job.on_sigterm()                                   # before the first start
    assert job.run() == 0
    assert creates(st) == 0 and asked(tmp) == [111, 333] and not job.completed
