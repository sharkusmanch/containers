"""Read-along worker: every metadata field is locked before a publish touches
the book's folder -- BookOrbit re-extracts a new primary file's embedded
metadata over every unlocked field (2026-09-24: 189 books lost provider ids,
page counts, genres and descriptions to the read-along publishes)."""
from app.bookorbit import LOCK_FIELDS as LOCK_ALL
from tests.test_readalong_job import creates, env, has_readalong, state_of  # noqa: F401

CURATED = {"description": "CURATED", "genres": ["Epic Fantasy", "Fantasy"], "tags": ["Favourite"],
           "pageCount": 656, "publisher": "Orbit", "hardcoverId": "a-little-hatred",
           "goodreadsId": "35606041", "googleBooksId": "qSuDDwAAQBAJ"}


def curate(lib, bid=111):
    lib._books[bid].update({k: (list(v) if isinstance(v, list) else v) for k, v in CURATED.items()})


def test_the_fake_wipes_unlocked_metadata_when_a_new_file_becomes_primary(env):
    """Guards the other tests: without the lock, the fake does what BookOrbit did."""
    lib, st, clock, pushes, make, tmp = env
    curate(lib)
    folder = lib._local(lib._books[111]["folderPath"])
    with open(f"{folder}/01. A Little Hatred (x).epub", "wb") as fh:
        fh.write(b"OVERLAY" + b"x" * 10)            # a read-along: it becomes the primary
    lib.scan(7)
    b = lib._books[111]
    assert b["description"] == "EMBEDDED BLURB" and b["genres"] == [] and b["hardcoverId"] is None


def test_a_publish_keeps_every_metadata_field(env):
    lib, st, clock, pushes, make, tmp = env
    curate(lib)
    assert make().run() == 0
    assert has_readalong(lib, 111)
    b = lib._books[111]
    assert {k: b[k] for k in CURATED} == CURATED
    assert set(LOCK_ALL) <= set(b["lockedFields"])


def test_the_lock_comes_before_the_first_file_operation_in_the_book_folder(env):
    lib, st, clock, pushes, make, tmp = env
    make().run()
    (bid, names), = lib.lock_calls
    assert bid == 111 and names == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]   # untouched yet


def test_existing_locks_are_kept(env):
    lib, st, clock, pushes, make, tmp = env
    lib._books[111]["lockedFields"] = ["narrators", "someFutureField"]
    make().run()
    assert {"narrators", "someFutureField"} <= set(lib._books[111]["lockedFields"])


def test_no_lock_no_publish(env):
    """BookOrbit down while locking: the book is not published unlocked, the
    failure is the book's (counted), its files are untouched."""
    lib, st, clock, pushes, make, tmp = env
    curate(lib)
    lib.lock_fails = True
    make().run()
    folder = lib._local(lib._books[111]["folderPath"])
    import os
    assert sorted(os.listdir(folder)) == ["01. A Little Hatred.epub", "01. A Little Hatred.m4b"]
    assert not has_readalong(lib, 111) and lib._books[111]["description"] == "CURATED"
    assert state_of(tmp)["errors"]["111"]["count"] == 1 and state_of(tmp)["in_flight"]["book"] == 111
    lib.lock_fails = False
    make().run()                                     # the next run locks, then publishes
    assert has_readalong(lib, 111) and lib._books[111]["description"] == "CURATED"


def test_a_resumed_publish_locks_again_harmlessly(env):
    lib, st, clock, pushes, make, tmp = env
    curate(lib)
    lib._books[111]["lockedFields"] = list(LOCK_ALL)            # locked by an earlier attempt
    make().run()
    assert has_readalong(lib, 111) and lib._books[111]["description"] == "CURATED"
    assert [b for b, _n in lib.lock_calls] == [111]
