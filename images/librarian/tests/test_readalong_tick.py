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
    scans = lib.scans
    for _ in range(3):
        clock.t += 60
        make().tick()
    assert lib.scans == scans and state_of(tmp)["errors"]["111"]["count"] == 1   # no rescan every minute


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

    def down(bid):
        raise RuntimeError("GET /books/111 -> HTTP 502: bad gateway")
    lib.detail = down
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


def test_a_storyteller_error_on_the_look_fails_the_tick_not_the_book(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    make().tick()
    real_book = st.book

    def book(uuid):
        raise StorytellerHTTPError(f"GET /api/v2/books/{uuid} -> 503: b'restarting'", 503)
    st.book = book
    clock.t += 60
    assert make().tick() == 1
    assert state_of(tmp)["errors"] == {} and state_of(tmp)["in_flight"]["uuid"] == "u1"
    st.book = real_book
