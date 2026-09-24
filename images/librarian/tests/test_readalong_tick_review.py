# Regression tests from the code review of the long-lived worker (2026-09-23).
"""Adversarial review (rv7) of 389811d -- the tick. Each test states the
behaviour the design promises; a FAIL is a finding."""
import os

from app.readalong import job as jobmod
from tests.test_readalong_job import add_other, creates, env, has_readalong, state_of  # noqa: F401
from tests.test_readalong_tick import ask, asked


# --- F1: a tick-published book never gets its Read-Along flag ----------------------------------
def test_a_tick_publish_sets_the_read_along_flag(env, caplog):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # started
    clock.t += 60
    make().tick()                                      # DONE -> finish() -> publish
    assert has_readalong(lib, 111)
    flag = [m.get("value") for m in lib._books[111].get("customMetadata", []) if m.get("fieldId") == 2]
    print("flag after the tick publish:", flag, "| log:",
          [r.getMessage() for r in caplog.records if "Read-Along flag" in r.getMessage()])
    assert flag == [True]


# --- F2: a deterministic failure after the download re-downloads every tick --------------------
def test_a_gate_error_does_not_redownload_every_tick(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1

    def corrupt(uuid, dest):                           # e.g. a SMIL inspect_epub cannot parse
        st.downloads += 1
        with open(dest, "wb") as fh:
            fh.write(b"not a zip" * 1000)
        return os.path.getsize(dest)
    st.download_readaloud = corrupt
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # started
    rcs = []
    for _ in range(10):                                # ten minutes of ticks
        clock.t += 60
        rcs.append(make().tick())
    print("tick rcs:", rcs, "downloads:", st.downloads, "errors:", state_of(tmp)["errors"])
    assert st.downloads <= 1                           # the nightly path downloads once per night


# --- F3: an undelivered push is retried every tick (3 POSTs each) -----------------------------
def test_an_undelivered_push_is_not_retried_every_minute(env):
    lib, st, clock, pushes, make, tmp = env
    attempts = []

    def flaky(url, title, body):                       # Apprise 424/timeout: maybe delivered, reported failed
        attempts.append(clock.t)
        return False
    j = make()                                         # no ask, nothing in flight: purely idle ticks
    j._push = flaky
    j._tell("📖🎧 X — read-along published (grade S)")  # something to tell
    for _ in range(60):                                # one hour of idle ticks
        clock.t += 60
        j = make()
        j._push = flaky
        j.tick()
    print("push attempts in one hour:", len(attempts), "(x3 POSTs each in send_push)")
    assert len(attempts) <= 2


# --- F4: one poisoned ask blocks every younger ask, forever -----------------------------------
def test_a_failing_ask_does_not_block_the_asks_behind_it(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    ask(tmp, 222, clock.t - 900)                       # the oldest ask ...
    ask(tmp, 111, clock.t - 400)
    real = lib.detail

    def detail(bid):
        if bid == 222:                                 # ... whose detail GET 500s (a BookOrbit bug on that book)
            raise RuntimeError("GET /books/222 -> HTTP 500: internal")
        return real(bid)
    lib.detail = detail
    rcs = []
    for _ in range(30):
        clock.t += 60
        rcs.append(make().tick())
    print("rcs:", set(rcs), "creates:", creates(st), "asks left:", asked(tmp))
    assert creates(st) == 1                            # 111 should have started


# --- F5: SIGTERM during a start drops the ask -------------------------------------------------
def test_sigterm_during_a_start_keeps_the_ask(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    j = make()

    def duration(path):                                # the rollout's SIGTERM lands during the ffprobe
        j.on_sigterm()
        return 40.0
    j.duration = duration
    assert j.tick() == 0
    print("creates:", creates(st), "asks left:", asked(tmp))
    assert creates(st) == 0 and asked(tmp) == [111]    # not started, so the ask must survive


# --- F6: a broken wanted dir (an optional input) takes down the nightly and every tick ---------
def test_a_broken_wanted_dir_does_not_stop_the_nightly(env):
    lib, st, clock, pushes, make, tmp = env
    (tmp / "wanted").write_text("a file where the directory should be")   # the librarian's own test case
    try:
        rc = make().run()
    except OSError as e:
        rc = f"raised {type(e).__name__}: {e}"
    print("nightly:", rc)
    assert rc == 0 and has_readalong(lib, 111)


# --- informational: per-tick cost while Storyteller is busy with a foreign book ----------------
def test_cost_of_an_ask_kept_while_storyteller_is_busy(env):
    lib, st, clock, pushes, make, tmp = env
    st.foreign = [{"uuid": "x", "title": "Manual", "readaloud": {"status": "STOPPED"},
                   "processingJob": {"status": "PAUSED"}}]          # paused by the owner: busy until resumed
    ask(tmp, 111, clock.t - 400)
    gets, probes, saves = [], [], []
    real_detail, real_save = lib.detail, jobmod.State.save
    lib.detail = lambda bid: gets.append(bid) or real_detail(bid)
    jobmod.State.save = lambda self: saves.append(1) or real_save(self)
    try:
        for _ in range(60):
            clock.t += 60
            j = make()
            j.tools = lambda: probes.append(1)
            j.tick()
    finally:
        jobmod.State.save = real_save
    print(f"per hour while busy: {len(gets)} detail GETs, {len(probes)} ffprobe preflights, "
          f"{len(saves)} state fsyncs, asks={asked(tmp)}")
    assert len(gets) <= 6


# --- F8: a re-filed in-flight book loses its ask in the very tick that abandons the old pair -----
def test_a_refiled_in_flight_book_keeps_its_ask(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # 111 aligning (u1)
    # the owner replaces the m4b; the librarian files it and asks again
    import os as _os
    from tests.test_readalong_job import folder
    m4b = folder(tmp) / "01. A Little Hatred.m4b"
    m4b.write_bytes(b"BETTER AUDIO" * 50)
    lib.scan(7)                                        # BookOrbit sees the new size: a new pair
    ask(tmp, 111, clock.t)
    clock.t += 400                                     # settled
    make().tick()                                      # the look abandons u1 ("files changed") ...
    print("history:", [h["outcome"] for h in state_of(tmp)["history"]], "in_flight:",
          (state_of(tmp)["in_flight"] or {}).get("uuid"), "asks:", asked(tmp), "creates:", creates(st))
    assert asked(tmp) == [111] or creates(st) == 2     # ... so the new pair must start now, or its ask stay


# --- F9 (design consequence): a book the nightly re-processed blocks every ask for ~a day -------
def test_a_retried_alignment_that_succeeds_is_published_by_a_tick(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    st.polls_until_done = 10 ** 6
    lib._books[222]["updatedAt"] = "2026-09-19T10:00:00.000Z"
    make().run()                                       # the nightly starts 111 (newest first) ...
    uuid = state_of(tmp)["in_flight"]["uuid"]
    st.fail(uuid)                                      # ... Storyteller fails it once (a restart, OOM)
    clock.t += 3600
    st.polls_until_done = 1
    make().run()                                       # next run: counted once, re-processed, returns
    assert state_of(tmp)["errors"]["111"]["count"] == 1
    ask(tmp, 222, clock.t - 400)                       # meanwhile the librarian files book 222
    for _ in range(12 * 60):                           # twelve hours of ticks
        clock.t += 60
        make().tick()
    print("111 published:", has_readalong(lib, 111), "| 222 started:", creates(st) > 2,
          "| in_flight:", (state_of(tmp)["in_flight"] or {}).get("book"), "| asks:", asked(tmp))
    assert has_readalong(lib, 111)                     # the retry finished in minutes: publish it


# --- F3b: the same, through the real send_push: Apprise 424 (Bark split: first part delivered) --
def test_a_partially_delivered_push_is_not_resent_every_minute(env):
    lib, st, clock, pushes, make, tmp = env
    posts = []

    class R:
        status_code = 424                              # apprise: "one or more notifications could not be sent"

    def post(url, json, timeout):
        posts.append(clock.t)                          # ... but the first part of the split body went out
        return R()

    def push(url, title, body):
        return jobmod.send_push(url, title, body, post=post, sleep=lambda s: None)
    j = make()
    j._push = push
    j._tell("⚠️ something worth telling")
    for _ in range(60):
        clock.t += 60
        j = make()
        j._push = push
        j.tick()
    print("POSTs to Apprise in one idle hour:", len(posts))
    assert len(posts) <= 6


# --- rv9 (review of 1df8809): asks the nightly run did not serve, a blip on a look, Apprise 424 --

def test_a_nightly_stopped_mid_poll_keeps_the_asks_it_did_not_start(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    st.polls_until_done = 10_000                       # 111 keeps aligning
    ask(tmp, 111, clock.t - 900)
    ask(tmp, 222, clock.t - 400)
    j = make()
    real = j.sleep

    def sleep(s):                                      # SIGTERM during the first poll of 111
        j.on_sigterm()
        real(s)
    j.sleep = sleep
    lib.add_book(333, "Solo/01. Solo", [(31, "01. Solo.epub", b"E")], title="Solo",
                 updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    ask(tmp, 333, clock.t - 400)                       # no candidate: a finished run would drop it
    j.run()
    assert asked(tmp) == [222, 333] and not j.completed   # 111's went at its start; the rest stay


def test_a_nightly_that_ends_with_a_book_aligning_leaves_the_rest_to_the_ticks(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    st.polls_until_done = 10_000
    ask(tmp, 111, clock.t - 900)
    ask(tmp, 222, clock.t - 400)
    assert make(RUN_HOURS="1", START_HOURS="1", FINISH_HOURS="0.5").run() == 0
    assert asked(tmp) == [222] and state_of(tmp)["in_flight"]["book"] == 111
    for b in st.books_.values():                       # 111 finishes: the ticks publish it, then start 222
        b["left"] = 0
    for _ in range(3):
        clock.t += 60
        make().tick()
    assert has_readalong(lib, 111) and state_of(tmp)["in_flight"]["book"] == 222 and asked(tmp) == []


def test_one_blip_on_a_look_neither_parks_the_book_for_long_nor_charges_it(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # started
    real = lib.detail
    calls = {"n": 0}

    def flaky(bid):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("GET /books/111 -> HTTP 502: bad gateway")   # BookOrbit restarting
        return real(bid)
    lib.detail = flaky
    clock.t += 60
    make().tick()                                      # the blip
    for _ in range(30):                                # half an hour later it is looked at again
        clock.t += 60
        make().tick()
    assert has_readalong(lib, 111) and state_of(tmp)["errors"] == {}
    assert not [b for _t, b in pushes if "failed" in b]


def test_the_nightly_drops_only_the_asks_of_books_that_are_no_candidates(env):
    lib, st, clock, pushes, make, tmp = env
    lib.add_book(333, "Solo/01. Solo", [(31, "01. Solo.epub", b"E")], title="Solo",
                 updatedAt="2026-09-19T10:00:00.000Z", customMetadata=[{"fieldId": 2, "value": False}])
    ask(tmp, 333, clock.t - 400)                       # no pair (yet): no candidate
    ask(tmp, 999, clock.t - 400)                       # not in the listing (deleted, another library)
    assert make().run() == 0
    assert asked(tmp) == [] and has_readalong(lib, 111)


def test_a_nightly_under_ONLY_keeps_the_other_asks(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    ask(tmp, 222, clock.t - 400)
    assert make(ONLY="111").run() == 0
    assert has_readalong(lib, 111) and asked(tmp) == [222]


def test_an_asked_book_that_does_not_fit_the_run_keeps_its_ask(env):
    lib, st, clock, pushes, make, tmp = env
    ask(tmp, 111, clock.t - 400)
    j = make()
    j.fits = lambda seconds: False                     # too long for what is left of tonight's run
    assert j.run() == 0
    assert creates(st) == 0 and asked(tmp) == [111]
    clock.t += 60
    make().tick()                                      # a tick has no window: it starts it
    assert creates(st) == 1 and asked(tmp) == []


def test_a_424_is_not_delivered(env):
    lib, st, clock, pushes, make, tmp = env

    class R:
        status_code = 424                              # Apprise: its one target (Bark) failed

    assert jobmod.send_push("http://apprise", "t", "b", post=lambda url, json, timeout: R(),
                            sleep=lambda s: None) is False
    j = make()
    j._push = lambda url, title, body: jobmod.send_push(url, title, body, post=lambda url, json, timeout: R(),
                                                        sleep=lambda s: None)
    j._tell("⚠️ Sharp Ends — gave up after 3 tries: x")
    j.report()
    p = state_of(tmp)["pending_push"]
    assert p["lines"] == ["⚠️ Sharp Ends — gave up after 3 tries: x"] and p["tries"] == 1   # kept, backed off


# --- rv10 (review of 26a84df): failures finish() handles itself, unstartable asks, closes, 424 ----

def test_a_failing_publish_scan_backs_off_like_any_failed_look(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1
    ask(tmp, 111, clock.t - 400)
    make().tick()                                      # started
    attempts = []

    def scan(library_id):                              # BookOrbit's scan times out / 500s
        attempts.append(clock.t)
        raise RuntimeError("scan did not finish within 900 s")
    lib.scan = scan
    t0 = clock.t
    while clock.t < t0 + 95 * 60:
        clock.t += 60
        make().tick()
    assert [a - t0 for a in attempts] == [60, 60 + 1800, 60 + 1800 + 3600]   # not every minute
    s = state_of(tmp)
    assert s["errors"]["111"]["count"] == 1 and s["in_flight"]["look_fails"] == 3
    assert len([b for _t, b in pushes if "failed" in b]) == 1


def test_a_missing_report_is_not_refetched_every_minute(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1
    st.report_missing = True                           # finish(): _fail("gave no alignment report")
    ask(tmp, 111, clock.t - 400)
    make().tick()
    calls = []
    real = st.alignment_report
    st.alignment_report = lambda uuid: calls.append(clock.t) or real(uuid)
    for _ in range(10):
        clock.t += 60
        make().tick()
    assert len(calls) == 1


def test_a_charged_failure_after_a_blip_keeps_backing_off(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 1
    ask(tmp, 111, clock.t - 400)
    make().tick()
    real_detail = lib.detail
    n = {"i": 0}

    def detail(bid):                                   # the first look: a BookOrbit 502
        n["i"] += 1
        if n["i"] == 1:
            raise RuntimeError("GET /books/111 -> HTTP 502: bad gateway")
        return real_detail(bid)
    lib.detail = detail
    lib.scan_fails = True                              # and then the publish fails (PublishError)
    clock.t += 60
    make().tick()
    assert state_of(tmp)["in_flight"]["look_fails"] == 1
    clock.t += 1800
    make().tick()                                      # the second failure in a row: charged ...
    s = state_of(tmp)
    assert s["errors"]["111"]["count"] == 1 and s["in_flight"]["look_fails"] == 2   # ... and backing off
    attempts = lib.scan_attempts
    for _ in range(30):
        clock.t += 60
        make().tick()
    assert lib.scan_attempts == attempts               # 1 h now


def test_an_ask_the_nightly_could_not_start_is_dropped_by_it(env):
    lib, st, clock, pushes, make, tmp = env
    add_other(lib)
    real = lib.detail
    gets = []

    def detail(bid):
        if bid == 222:                                 # BookOrbit 500s on this one book's detail
            gets.append(clock.t)
            raise RuntimeError("GET /books/222 -> HTTP 500: internal")
        return real(bid)
    lib.detail = detail
    real_books = lib.books                             # the fake's listing goes through detail(): keep it whole

    def books():
        lib.detail = real
        try:
            return real_books()
        finally:
            lib.detail = detail
    lib.books = books
    ask(tmp, 222, clock.t - 400)
    for _ in range(10):                                # ticks cannot evaluate it: it stays, blocks nothing
        clock.t += 60
        make().tick()
    assert asked(tmp) == [222]
    make().run()                                       # the nightly tries to start it: charged, ask dropped
    assert asked(tmp) == [] and state_of(tmp)["errors"]["222"]["count"] == 1
    n = len(gets)
    for _ in range(60):
        clock.t += 60
        make().tick()
    assert len(gets) == n                              # no more GETs every minute


def test_a_resumed_close_is_not_held_back_by_the_look_backoff(env):
    lib, st, clock, pushes, make, tmp = env
    st.polls_until_done = 10 ** 6
    ask(tmp, 111, clock.t - 400)
    make().tick()
    j = make()                                         # the state a kill leaves mid-_close() after a
    fl = j.state.in_flight                             # tick's give-up (look_fails 8 = the 20 h cap)
    fl.update(closing="gave-up", closing_line="⚠️ A Little Hatred — gave up after 3 tries: x",
              look_fails=8, look_failed_at=clock.t)
    j.state.save()
    clock.t += 60
    make().tick()
    assert state_of(tmp)["in_flight"] is None
    assert [b for _t, b in pushes if "gave up after 3 tries" in b]


def test_a_424_is_one_post_per_backed_off_attempt(env):
    lib, st, clock, pushes, make, tmp = env
    posts = []

    class R:
        status_code = 424                              # Apprise: its target failed (maybe some parts arrived)

    def push(url, title, body):
        return jobmod.send_push(url, title, body, post=lambda url, json, timeout: posts.append(clock.t) or R(),
                                sleep=lambda s: None)
    j = make()
    j._tell("📖🎧 Sharp Ends — read-along published (grade S)")
    t0 = clock.t
    for _ in range(120):                               # two idle hours
        clock.t += 60
        j = make()
        j._push = push
        j.tick()
    assert [p - t0 for p in posts] == [60, 60 + 1800, 60 + 1800 + 3600]   # never re-sent seconds later
    assert state_of(tmp)["pending_push"]["lines"]      # kept until delivered
