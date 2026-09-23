"""Read-along worker: publishing into the book folder (fake BookOrbit whose
scanner matches paths before inodes, like 3.0.0's)."""
import os

import pytest

from app.readalong.publish import FilesChanged, PublishConflict, PublishError, _problem, publish
from tests.readalong_fakes import OVERLAY, FakeLibrary

FOLDER = "Author/Series/01. Title"


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


@pytest.fixture
def env(tmp_path):
    books = tmp_path / "books"
    staging = tmp_path / "staging"
    staging.mkdir()
    lib = FakeLibrary(books)
    lib.add_book(111, FOLDER, [(11, "01. Title.epub", b"PLAIN-EPUB"), (12, "Title [B0X].m4b", b"AUDIO" * 10)])
    staged = staging / "111-u.epub"
    staged.write_bytes(OVERLAY + b"-READALONG" * 5)
    clock = Clock()

    def run(**kw):
        return publish(lib, 111, str(staged), (11, 10, 12, 50), media_books=str(books), books_prefix="/books",
                       staging_dir=str(staging), sleep=clock.sleep, clock=clock, **kw)[0]
    return lib, books / FOLDER, staged, run, clock


def names(folder):
    return sorted(os.listdir(folder))


def test_publish_lands_the_final_layout_and_keeps_every_file_id(env):
    lib, folder, staged, run, _ = env
    d = run()
    assert names(folder) == ["01. Title (ebook).epub", "01. Title.epub", "01. Title.m4b"]
    by_name = {f["filename"]: f for f in d["files"]}
    assert by_name["01. Title (ebook).epub"]["id"] == 11          # the plain EPUB kept its id
    assert by_name["01. Title.m4b"]["id"] == 12
    ra = by_name["01. Title.epub"]
    assert ra["id"] not in (11, 12) and ra["role"] == "primary" and ra["mediaOverlay"]["available"]
    assert d["readAloudSync"] == {"overlayFileId": ra["id"], "state": "enabled"}
    assert not staged.exists() and lib.scans == 2


def test_the_fake_scanner_really_is_path_first(env):
    """Guards the fake's fidelity: linking the read-along at the plain EPUB's
    known name BEFORE the rename is scanned rebinds the plain's record -- the
    very hazard publish() is ordered to avoid."""
    lib, folder, staged, _run, _ = env
    os.link(folder / "01. Title.epub", folder / "01. Title (ebook).epub")
    os.unlink(folder / "01. Title.epub")
    os.link(staged, folder / "01. Title.epub")
    lib.scan(7)
    by_name = {f["filename"]: f for f in lib.detail(111)["files"]}
    assert by_name["01. Title.epub"]["id"] == 11                  # the plain's record now IS the read-along
    assert by_name["01. Title (ebook).epub"]["id"] != 11


def test_resume_after_a_kill_between_the_rename_and_its_scan(env):
    lib, folder, staged, run, _ = env
    os.link(folder / "01. Title.epub", folder / "01. Title (ebook).epub")
    os.unlink(folder / "01. Title.epub")                          # killed here: BookOrbit still has the old names
    d = run()
    assert {f["filename"]: f["id"] for f in d["files"]}["01. Title (ebook).epub"] == 11
    assert names(folder) == ["01. Title (ebook).epub", "01. Title.epub", "01. Title.m4b"]


def test_resume_after_a_kill_between_the_link_and_its_scan(env):
    lib, folder, staged, run, _ = env
    for a, b in (("01. Title.epub", "01. Title (ebook).epub"), ("Title [B0X].m4b", "01. Title.m4b")):
        os.link(folder / a, folder / b)
        os.unlink(folder / a)
    lib.scan(7)
    os.link(staged, folder / "01. Title.epub")                    # killed before the second scan
    d = run()
    assert {f["filename"]: f["id"] for f in d["files"]}["01. Title (ebook).epub"] == 11
    assert not staged.exists()


def test_resume_after_a_kill_between_verify_and_cleanup(env):
    lib, folder, staged, run, _ = env
    run()
    os.link(folder / "01. Title.epub", staged)                    # the staged name was never unlinked
    scans = lib.scans
    d = run()                                                     # already published: verify, then clean up
    assert d["readAloudSync"]["state"] == "enabled" and not staged.exists()
    assert lib.scans == scans and (folder / "01. Title.epub").exists()


def test_a_foreign_file_at_the_ebook_name_stops_everything(env):
    lib, folder, staged, run, _ = env
    (folder / "01. Title (ebook).epub").write_bytes(b"SOMETHING ELSE")
    with pytest.raises(PublishConflict):
        run()
    assert (folder / "01. Title (ebook).epub").read_bytes() == b"SOMETHING ELSE"
    assert (folder / "01. Title.epub").read_bytes() == b"PLAIN-EPUB"
    assert staged.exists() and lib.scans == 0


def test_a_file_landing_at_the_plain_name_before_the_rename_scan_stops_safely(env):
    """BookOrbit rebinds the plain EPUB's record to whatever sits at its old
    path, so the book no longer holds one EPUB + one m4b: stop (the job
    abandons the alignment), overwrite nothing."""
    lib, folder, staged, run, _ = env

    def stray(fake):
        (folder / "01. Title.epub").write_bytes(b"STRAY")
    lib.hook_before_scan = stray
    with pytest.raises(FilesChanged):
        run()
    assert (folder / "01. Title.epub").read_bytes() == b"STRAY"
    assert (folder / "01. Title (ebook).epub").read_bytes() == b"PLAIN-EPUB"
    assert staged.exists()


def test_a_foreign_file_at_the_clean_name_is_never_overwritten(env):
    lib, folder, staged, run, _ = env
    for a, b in (("01. Title.epub", "01. Title (ebook).epub"), ("Title [B0X].m4b", "01. Title.m4b")):
        os.link(folder / a, folder / b)
        os.unlink(folder / a)
    lib.scan(7)                                                   # a previous run finished the rename phase
    (folder / "01. Title.epub").write_bytes(b"STRAY")             # then something put a file there, unscanned
    with pytest.raises(PublishConflict):
        run()
    assert (folder / "01. Title.epub").read_bytes() == b"STRAY"
    assert staged.exists()


def test_changed_files_stop_before_anything_moves(env):
    lib, folder, staged, _run, clock = env
    with pytest.raises(PublishError, match="files changed"):
        publish(lib, 111, str(staged), (11, 10, 12, 999), media_books=str(folder.parents[2]),
                sleep=clock.sleep, clock=clock)
    assert names(folder) == ["01. Title.epub", "Title [B0X].m4b"]


def test_a_scan_that_never_ends_stops_before_anything_moves(env):
    lib, folder, staged, run, _ = env
    lib.running_scans = 10 ** 6
    with pytest.raises(PublishError, match="still running"):
        run()
    assert names(folder) == ["01. Title.epub", "Title [B0X].m4b"]


def test_verify_rejects_a_read_along_that_is_not_primary():
    d = {"id": 1, "folderPath": "/books/A/01. T",
         "files": [{"id": 5, "filename": "01. T.epub", "format": "epub", "role": "content", "sizeBytes": 9,
                    "mediaOverlay": {"available": True}},
                   {"id": 11, "filename": "01. T (ebook).epub", "format": "epub", "role": "primary",
                    "sizeBytes": 3, "mediaOverlay": {"available": False}},
                   {"id": 12, "filename": "01. T.m4b", "format": "m4b", "role": "content", "sizeBytes": 4}],
         "readAloudSync": {"overlayFileId": 5, "state": "enabled"}}
    assert "not the primary" in _problem(d, (11, 3, 12, 4), 9)
    d["files"][0]["role"], d["files"][1]["role"] = "primary", "content"
    assert _problem(d, (11, 3, 12, 4), 9) is None
    d["readAloudSync"]["state"] = "unavailable"
    assert "sync" in _problem(d, (11, 3, 12, 4), 9)


def test_verify_still_pending_is_retried_without_touching_the_files(env):
    lib, folder, staged, run, _ = env
    lib.sync_pending = 10 ** 6
    with pytest.raises(PublishError, match="verify"):
        run()
    ino = os.stat(folder / "01. Title.epub").st_ino
    lib.sync_pending = 0
    d = run()                                        # the next run only verifies
    assert d["readAloudSync"]["state"] == "enabled"
    assert os.stat(folder / "01. Title.epub").st_ino == ino and not staged.exists()


def test_a_case_variant_stray_blocks_until_it_is_gone(env):
    lib, folder, staged, run, _ = env
    (folder / "01. title (EBOOK).epub").write_bytes(b"STRAY")
    with pytest.raises(PublishConflict) as e:
        run()
    assert e.value.path.endswith("01. title (EBOOK).epub")
    assert names(folder) == ["01. Title.epub", "01. title (EBOOK).epub", "Title [B0X].m4b"]
    os.unlink(folder / "01. title (EBOOK).epub")    # a human removed it
    run()
    assert names(folder) == ["01. Title (ebook).epub", "01. Title.epub", "01. Title.m4b"]


def test_a_foreign_scan_between_link_and_unlink_is_rekeyed(env, monkeypatch):
    """The old path still existed, so that scan gave the plain EPUB a new
    record; our scan then pruned the old one. Match it by name and size."""
    lib, folder, staged, _run, clock = env
    real_unlink = os.unlink
    fired = []

    def unlink(path, *a, **k):
        if not fired and str(path).endswith("01. Title.epub"):
            fired.append(1)
            lib.scan(7)                              # the hourly scan lands right here
        return real_unlink(path, *a, **k)
    monkeypatch.setattr(os, "unlink", unlink)
    d, pair = publish(lib, 111, str(staged), (11, 10, 12, 50), media_books=str(folder.parents[2]),
                      staging_dir=str(staged.parent), sleep=clock.sleep, clock=clock)
    assert pair[0] != 11 and pair[1:] == (10, 12, 50)
    assert {f["filename"]: f["id"] for f in d["files"]}["01. Title (ebook).epub"] == pair[0]


def test_paths_outside_the_roots_are_refused(env):
    lib, folder, staged, _run, clock = env
    lib._books[111]["folderPath"] = "/books/../../etc"
    with pytest.raises(PublishError, match="not under"):
        publish(lib, 111, str(staged), (11, 10, 12, 50), media_books=str(folder.parents[2]),
                sleep=clock.sleep, clock=clock)
    with pytest.raises(PublishError, match="not under"):
        publish(lib, 111, "/etc/passwd", (11, 10, 12, 50), media_books=str(folder.parents[2]),
                staging_dir=str(staged.parent), sleep=clock.sleep, clock=clock)


def test_a_file_attached_during_alignment_is_files_changed_not_published(env):
    """Review I3: a second m4b filed by the librarian while Storyteller aligned."""
    lib, folder, staged, run, _ = env
    (folder / "Title (Unabridged).m4b").write_bytes(b"OTHER AUDIO")
    lib.scan(7)
    with pytest.raises(FilesChanged):
        run()
    assert names(folder) == ["01. Title.epub", "Title (Unabridged).m4b", "Title [B0X].m4b"]
    assert staged.exists()


def test_a_book_moved_during_the_publish_stops_before_the_link(env):
    lib, folder, staged, run, _ = env

    def move(fake):                                  # BookOrbit renamed the book mid-publish (disk + record)
        os.rename(folder, folder.parent / "01. Renamed")
        fake._books[111]["folderPath"] = "/books/Author/Series/01. Renamed"
    lib.hook_before_scan = move
    with pytest.raises(PublishError, match="moved"):
        run()
    moved = folder.parent / "01. Renamed"
    assert not any(os.path.samefile(staged, moved / n) for n in os.listdir(moved))
    assert staged.exists()
