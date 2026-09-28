"""Read-along worker: an audiobook's stored length. BookOrbit sums it only while the
book's PRIMARY file is audio (metadata.service aggregateAudioDuration, 3.0.0 and
3.1.0), so an m4b the librarian attaches to an existing ebook never gets one. The
worker's nightly run fills it from BookOrbit's own measurement of the audio file."""
import logging

import pytest

from app.readalong.job import BookGone, Bookorbit
from app.readalong.length import fill_lengths, target_length
from tests.readalong_fakes import FakeLibrary
from tests.test_readalong_job import creates, env  # noqa: F401
from tests.test_readalong_tick import ask, counting

M4B = "01. A Little Hatred.m4b"


def book(stored, *parts, lib=7):
    files = [{"id": 1, "format": "epub", "role": "primary"}]
    files += [{"id": 10 + i, "format": fmt, "role": "content", "durationSeconds": secs}
              for i, (fmt, secs) in enumerate(parts)]
    return {"id": 5, "libraryId": lib, "files": files,
            "audioMetadata": None if stored == "no audioMetadata" else {"durationSeconds": stored}}


@pytest.mark.parametrize("stored", [None, 0, 70000, "no audioMetadata"])
def test_a_missing_zero_or_wrong_length_gets_the_files_sum(stored):
    assert target_length(book(stored, ("m4b", 73241)), (7, 8)) == 73241


def test_a_length_within_a_minute_is_left_alone():
    assert target_length(book(73241 - 60, ("m4b", 73241)), (7, 8)) is None
    assert target_length(book(73241, ("m4b", 73241)), (7, 8)) is None


@pytest.mark.parametrize("parts", [
    (("m4b", None),),                      # not measured yet: BookOrbit's scan does that first
    (("m4b", 0),),
    (("m4b", 300), ("mp3", 301)),          # two editions: which one's length?
    (("mp3", 100), ("mp3", 200)),          # parts -- or a duplicate, or a set caught mid-copy
    (),                                    # no audio at all
])
def test_no_value_is_ever_guessed(parts):
    assert target_length(book(None, *parts), (7, 8)) is None


def test_other_libraries_are_not_touched():
    assert target_length(book(None, ("m4b", 100), lib=3), (7, 8)) is None


# --- the nightly sweep -----------------------------------------------------------------------

NOW = 1790000000.0                          # the sweep's wall clock: 2026-09-21T...; files older unless set


def lib_with(tmp_path, *books):
    lib = FakeLibrary(tmp_path)
    for bid, names in books:
        lib.add_book(bid, f"A/{bid:02d}. B{bid}", [(bid * 10 + i, n, b"x" * (i + 1)) for i, n in enumerate(names)])
    return lib


class Mono:
    def __init__(self, step=0.0):
        self.t, self.step = 0.0, step

    def __call__(self):
        self.t += self.step
        return self.t


def sweep(lib, books, **kw):
    kw.setdefault("monotonic", Mono())
    return fill_lengths(lib, books, libraries=(7, 8), dry_run=kw.pop("dry_run", False), now=NOW, **kw)


def test_the_sweep_reads_only_books_holding_audio_and_fills_the_empty_ones(tmp_path):
    lib = lib_with(tmp_path, (1, ["01. A.epub", "01. A.m4b"]), (2, ["02. B.epub"]), (3, ["03. C.m4b"]))
    lib.durations = {"01. A.m4b": 500, "03. C.m4b": 900}
    lib._books[3]["audioMetadata"] = {"durationSeconds": 900}       # audio primary: BookOrbit filled it
    books = lib.books()
    seen = counting(lib)
    assert sweep(lib, books) == (1, 0)
    assert seen == [1, 3] and lib.length_calls == [(1, 500)]
    assert lib.detail(1)["audioMetadata"]["durationSeconds"] == 500


def test_a_book_with_a_file_under_an_hour_old_is_left_to_its_filing(tmp_path):
    """The librarian may still be filing it (and writing the book's locks): never race that --
    an EPUB attached to an audiobook is a filing too, and an unreadable date is treated as new."""
    names = [(i, [f"{i:02d}. A.epub", f"{i:02d}. A.m4b"]) for i in range(1, 5)]
    lib = lib_with(tmp_path, *names)
    lib.durations = {f"{i:02d}. A.m4b": 100 * i for i in range(1, 5)}
    lib.created = {"01. A.m4b": "2026-09-21T13:43:20.000Z",           # NOW - 30 min
                   "02. A.m4b": "2026-09-21T11:53:20.000Z",           # NOW - 2 h 20 min
                   "03. A.epub": "2026-09-21T13:43:20.000Z",          # an EPUB just attached
                   "04. A.m4b": "yesterday-ish"}                      # unreadable
    assert sweep(lib, lib.books()) == (1, 0) and lib.length_calls == [(2, 200)]


def test_a_date_without_a_zone_is_utc(tmp_path):
    lib = lib_with(tmp_path, (1, ["01. A.epub", "01. A.m4b"]))
    lib.durations = {"01. A.m4b": 500}
    lib.created = {"01. A.m4b": "2026-09-21T13:43:20"}                # NOW - 30 min, if UTC
    assert sweep(lib, lib.books()) == (0, 0)


def test_a_book_deleted_since_the_listing_is_skipped(tmp_path):
    lib = lib_with(tmp_path, (1, ["01. A.epub", "01. A.m4b"]), (2, ["02. B.epub", "02. B.m4b"]))
    lib.durations = {"01. A.m4b": 500, "02. B.m4b": 600}
    books = lib.books()
    lib.remove_book(1)
    assert sweep(lib, books) == (1, 0)
    assert lib.detail(2)["audioMetadata"]["durationSeconds"] == 600


def test_a_failing_bookorbit_stops_the_sweep_after_three_in_a_row(tmp_path):
    names = [(i, [f"{i:02d}. A.epub", f"{i:02d}. A.m4b"]) for i in range(1, 6)]
    lib = lib_with(tmp_path, *names)
    lib.durations = {f"{i:02d}. A.m4b": 100 * i for i in range(1, 6)}
    lib.length_fails = True
    assert sweep(lib, lib.books()) == (0, 3) and [b for b, _ in lib.length_calls] == [1, 2, 3]


def test_the_sweep_yields_the_night_after_its_time_budget(tmp_path):
    names = [(i, [f"{i:02d}. A.epub", f"{i:02d}. A.m4b"]) for i in range(1, 6)]
    lib = lib_with(tmp_path, *names)
    lib.durations = {f"{i:02d}. A.m4b": 100 * i for i in range(1, 6)}
    assert sweep(lib, lib.books(), monotonic=Mono(step=100.0)) == (2, 0)     # 300 s budget


def test_the_sweep_stops_on_sigterm(tmp_path):
    lib = lib_with(tmp_path, (1, ["01. A.epub", "01. A.m4b"]), (2, ["02. B.epub", "02. B.m4b"]))
    lib.durations = {"01. A.m4b": 500, "02. B.m4b": 600}
    assert sweep(lib, lib.books(), stopping=lambda: bool(lib.length_calls)) == (1, 0)   # SIGTERM after book 1
    assert lib.length_calls == [(1, 500)]


def test_a_dry_run_sweep_writes_nothing(tmp_path):
    lib = lib_with(tmp_path, (1, ["01. A.epub", "01. A.m4b"]))
    lib.durations = {"01. A.m4b": 500}
    assert sweep(lib, lib.books(), dry_run=True) == (1, 0)
    assert lib.length_calls == []


# --- the worker ------------------------------------------------------------------------------

def test_the_nightly_run_fills_the_length(env):
    lib, st, clock, pushes, make, tmp = env
    lib.durations = {M4B: 73241}
    assert make().run() == 0
    assert (111, 73241) in lib.length_calls


def test_a_dry_run_night_only_says_what_it_would_set(env, caplog):
    lib, st, clock, pushes, make, tmp = env
    lib.durations = {M4B: 73241}
    with caplog.at_level(logging.INFO):
        make(DRY_RUN="true").run()
    assert lib.length_calls == [] and "would set the length of book 111" in caplog.text


def test_a_tick_leaves_lengths_to_the_nightly_run(env):
    """An ask waits whenever Storyteller is busy, so a tick is no reliable moment: the
    nightly run is the one place (the audit allows it a day)."""
    lib, st, clock, pushes, make, tmp = env
    lib.durations = {M4B: 73241}
    ask(tmp, 111, clock.t - 400)
    make().tick()
    assert creates(st) == 1 and lib.length_calls == []


# --- the BookOrbit adapter -------------------------------------------------------------------

class Writer:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    def patch_metadata(self, book_id, metadata, locked):
        if self.fail:
            raise self.fail
        self.calls.append((book_id, metadata, locked))


class Client:
    def __init__(self, *replies):
        self.replies = list(replies)

    def get(self, path):
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


LOCKS = ["title", "durationSeconds"]


def test_the_adapter_sends_only_the_length_and_keeps_every_lock():
    w = Writer()
    Bookorbit(Client({"lockedFields": LOCKS}, {"lockedFields": LOCKS[::-1], "audioMetadata": {"durationSeconds": 500}}),
              w).set_length(5, 500)
    assert w.calls == [(5, {"audioMetadata": {"durationSeconds": 500}}, [])]       # [] = no new locks


def test_a_lock_added_meanwhile_is_no_failure():
    Bookorbit(Client({"lockedFields": LOCKS},
                     {"lockedFields": LOCKS + ["genres"], "audioMetadata": {"durationSeconds": 500}}),
              Writer()).set_length(5, 500)


def test_the_adapter_reports_a_lock_it_lost():
    with pytest.raises(RuntimeError, match="lost locks.*durationSeconds"):
        Bookorbit(Client({"lockedFields": LOCKS},
                         {"lockedFields": ["title"], "audioMetadata": {"durationSeconds": 500}}),
                  Writer()).set_length(5, 500)


def test_the_adapter_refuses_a_length_that_did_not_take():
    with pytest.raises(RuntimeError, match="reads back"):
        Bookorbit(Client({"lockedFields": LOCKS}, {"lockedFields": LOCKS, "audioMetadata": {"durationSeconds": None}}),
                  Writer()).set_length(5, 500)


def test_a_book_deleted_meanwhile_is_gone():
    w = Writer(fail=RuntimeError("GET /books/5 -> HTTP 404: not found"))
    with pytest.raises(BookGone):
        Bookorbit(Client({}), w).set_length(5, 500)
