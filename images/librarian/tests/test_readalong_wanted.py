"""Read-along worker: "wanted" markers -- the librarian asks for a book's
read-along right after filing it; the worker reads, and drops, them."""
import json
import os

from app.readalong import wanted


def test_write_then_read_after_it_settles(tmp_path):
    d = str(tmp_path / "wanted")
    wanted.write(d, 111, now=1000.0, arrival="manual:A Little Hatred.m4b:7de7")
    assert wanted.read(d, now=1000.0 + 299, settle=300) == {}          # not settled yet
    assert wanted.read(d, now=1000.0 + 300, settle=300) == {111: 1000.0}
    assert json.load(open(os.path.join(d, "111.json")))["arrival"] == "manual:A Little Hatred.m4b:7de7"


def test_anything_but_a_well_formed_marker_is_ignored_and_left_alone(tmp_path):
    d = tmp_path / "wanted"
    d.mkdir()
    (d / "abc.json").write_text('{"book": 1, "at": 1}')                 # not a book id
    (d / "12.json").write_text("not json")
    (d / "13.json").write_text('{"book": 13}')                           # no time
    (d / "14.txt").write_text('{"book": 14, "at": 1}')
    (d / ".15.json.tmp").write_text('{"book": 15, "at": 1}')             # a write in progress
    (d / "16.json").write_text('{"book": 17, "at": 1}')                  # names another book
    (d / "18.json").mkdir()
    assert wanted.read(str(d), now=10 ** 9, settle=0) == {}
    assert sorted(os.listdir(d)) == [".15.json.tmp", "12.json", "13.json", "14.txt", "16.json", "18.json",
                                     "abc.json"]


def test_a_missing_directory_is_no_markers(tmp_path):
    assert wanted.read(str(tmp_path / "nope"), now=1, settle=0) == {}


def test_a_rewrite_replaces_atomically_and_leaves_no_temp(tmp_path):
    d = str(tmp_path / "wanted")
    wanted.write(d, 7, now=1.0, arrival="a")
    wanted.write(d, 7, now=2.0, arrival="b")
    assert wanted.read(d, now=10.0, settle=0) == {7: 2.0}
    assert os.listdir(d) == ["7.json"]


def test_drop_is_idempotent(tmp_path):
    d = str(tmp_path / "wanted")
    wanted.write(d, 7, now=1.0, arrival="a")
    wanted.drop(d, 7)
    wanted.drop(d, 7)                                                      # already gone: fine
    assert wanted.read(d, now=10.0, settle=0) == {}


def test_book_ids_are_integers_only(tmp_path):
    d = str(tmp_path / "wanted")
    for bad in ("7/../8", "-1", "1.5", True, None):
        try:
            wanted.write(d, bad, now=1.0, arrival="x")
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")
    assert not os.path.exists(d) or os.listdir(d) == []


def test_asked_at_reads_one_marker_settled_or_not(tmp_path):
    d = str(tmp_path / "wanted")
    assert wanted.asked_at(d, 7) is None
    wanted.write(d, 7, now=5.0, arrival="a")
    assert wanted.asked_at(d, 7) == 5.0
    (tmp_path / "wanted" / "8.json").write_text('{"book": 9, "at": 1}')      # names another book
    assert wanted.asked_at(d, 8) is None
