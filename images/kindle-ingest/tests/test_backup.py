"""Config backup: the due-gate, archive verification, and rotation."""
import json
import os
import sqlite3
import tarfile
import time

import pytest

from app import backup as B


_seq = [0]


def _sqlite_bytes(tmp_path, name=None, rows=3):
    _seq[0] += 1
    p = tmp_path / (name or f"s{_seq[0]}.db")
    con = sqlite3.connect(p)
    con.execute("create table t (x, y)")
    con.executemany("insert into t values (?,?)",
                    [(i, "v" * 80) for i in range(rows)])
    con.commit(); con.close()
    return p.read_bytes()


def _archive(tmp_path, dbs=None, extra=("settings.reader.lua", b"return {}")):
    """Build an archive shaped like the device produces."""
    dbs = {"statistics": _sqlite_bytes(tmp_path),
           "vocabulary_builder": _sqlite_bytes(tmp_path, "v.db")} if dbs is None else dbs
    path = tmp_path / "snap.tar.gz.part"
    with tarfile.open(path, "w:gz") as t:
        for name, blob in dbs.items():
            info = tarfile.TarInfo(f"settings/{name}.sqlite3.dbbk")
            info.size = len(blob)
            import io
            t.addfile(info, io.BytesIO(blob))
        if extra:
            info = tarfile.TarInfo(extra[0]); info.size = len(extra[1])
            import io
            t.addfile(info, io.BytesIO(extra[1]))
    return str(path)


# --- the due gate -----------------------------------------------------------
# The cycle runs every 10 minutes; the backup does not need to. A failure must
# retry on a shorter interval than a success, or a deterministic failure would
# either hammer the device every cycle or wait a full day.

def test_a_first_run_is_due(tmp_path):
    assert B.is_due(str(tmp_path), now=1000.0) is True


def test_not_due_again_within_a_day(tmp_path):
    B.record(str(tmp_path), ok=True, now=1000.0)
    assert B.is_due(str(tmp_path), now=1000.0 + 23 * 3600) is False


def test_due_again_after_a_day(tmp_path):
    B.record(str(tmp_path), ok=True, now=1000.0)
    assert B.is_due(str(tmp_path), now=1000.0 + 25 * 3600) is True


def test_a_failure_retries_sooner_than_a_success(tmp_path):
    B.record(str(tmp_path), ok=False, now=1000.0)
    assert B.is_due(str(tmp_path), now=1000.0 + 600) is False, "not every cycle"
    assert B.is_due(str(tmp_path), now=1000.0 + 2 * 3600) is True, "but sooner than a day"


def test_a_clock_stepped_backward_does_not_wedge_the_gate(tmp_path):
    # A timestamp in the future would otherwise hold the gate shut until the
    # clock caught up -- potentially days.
    B.record(str(tmp_path), ok=True, now=9_000_000.0)
    assert B.is_due(str(tmp_path), now=1000.0) is True


def test_an_unreadable_state_file_is_treated_as_due(tmp_path):
    (tmp_path / B.STATE_FILE).write_text("{ not json")
    assert B.is_due(str(tmp_path), now=1000.0) is True


# --- verification -----------------------------------------------------------
# `tar tzf` passes happily on a zero-byte database member. That is the same
# silent-stale failure the whole design exists to prevent, one layer out.

def test_a_valid_archive_verifies(tmp_path):
    B.verify(_archive(tmp_path))          # must not raise


def test_an_empty_database_member_is_rejected(tmp_path):
    a = _archive(tmp_path, dbs={"statistics": b"", "vocabulary_builder": _sqlite_bytes(tmp_path)})
    with pytest.raises(B.BackupInvalid) as e:
        B.verify(a)
    # A zero-byte file is a VALID empty SQLite database as far as
    # integrity_check is concerned, so the size check has to catch it itself.
    assert "empty" in str(e.value)


def test_a_non_sqlite_database_member_is_rejected(tmp_path):
    a = _archive(tmp_path, dbs={"statistics": b"not a database at all",
                                "vocabulary_builder": _sqlite_bytes(tmp_path)})
    with pytest.raises(B.BackupInvalid) as e:
        B.verify(a)
    assert "not a SQLite database" in str(e.value)


def test_a_corrupt_database_is_rejected(tmp_path):
    # Header intact so it still looks like SQLite, but a b-tree page wrecked.
    # (Smashing page 1's unused tail is NOT detected -- integrity_check returns
    # "ok" -- so the corruption has to land on real content to be a real test.)
    good = bytearray(_sqlite_bytes(tmp_path, rows=2000))
    good[5000:9000] = b"\xff" * 4000
    a = _archive(tmp_path, dbs={"statistics": bytes(good),
                                "vocabulary_builder": _sqlite_bytes(tmp_path)})
    with pytest.raises(B.BackupInvalid):
        B.verify(a)


def test_a_database_too_broken_to_open_is_rejected(tmp_path):
    # sqlite3 raises rather than returning a verdict; that must not escape as
    # something other than BackupInvalid.
    good = bytearray(_sqlite_bytes(tmp_path, rows=2000))
    good[4096:4096 * 3] = b"\xff" * (4096 * 2)
    a = _archive(tmp_path, dbs={"statistics": bytes(good)})
    with pytest.raises(B.BackupInvalid):
        B.verify(a)


def test_an_archive_with_no_config_at_all_is_rejected(tmp_path):
    a = _archive(tmp_path, extra=None, dbs={})
    with pytest.raises(B.BackupInvalid):
        B.verify(a)


def test_a_truncated_archive_is_rejected(tmp_path):
    a = _archive(tmp_path)
    with open(a, "r+b") as f:
        f.truncate(os.path.getsize(a) // 2)
    with pytest.raises(B.BackupInvalid):
        B.verify(a)


# --- rotation ---------------------------------------------------------------

def test_rotation_keeps_the_newest_and_drops_the_rest(tmp_path):
    d = tmp_path / "backups"; d.mkdir()
    for i in range(20):
        f = d / f"koreader-2026{i:04d}.tar.gz"
        f.write_bytes(b"x")
        os.utime(f, (1000 + i, 1000 + i))
    B.rotate(str(d), keep=14)
    left = sorted(p.name for p in d.iterdir())
    assert len(left) == 14
    assert "koreader-20260019.tar.gz" in left, "newest kept"
    assert "koreader-20260000.tar.gz" not in left, "oldest dropped"


def test_rotation_ignores_unrelated_files(tmp_path):
    d = tmp_path / "backups"; d.mkdir()
    (d / "koreader-20260101.tar.gz").write_bytes(b"x")
    (d / "notes.txt").write_bytes(b"x")
    B.rotate(str(d), keep=1)
    assert (d / "notes.txt").exists()


def test_rotation_never_removes_a_part_file_in_flight(tmp_path):
    d = tmp_path / "backups"; d.mkdir()
    (d / "koreader-20260101.tar.gz.part").write_bytes(b"x")
    for i in range(3):
        (d / f"koreader-2026010{i+2}.tar.gz").write_bytes(b"x")
    B.rotate(str(d), keep=1)
    assert (d / "koreader-20260101.tar.gz.part").exists()


# --- run(): orchestration ---------------------------------------------------

class _FakeDevice:
    """Produces a .part the way Device.backup_config does."""

    def __init__(self, tmp_path, fail=None, payload=None):
        self.tmp_path = tmp_path
        self.fail = fail
        self.payload = payload
        self.calls = 0

    def backup_config(self, dest):
        self.calls += 1
        if self.fail:
            raise self.fail
        part = dest + ".part"
        src = self.payload or _archive(self.tmp_path)
        os.replace(src, part) if os.path.exists(src) else None
        return part


def test_run_produces_a_verified_snapshot(tmp_path):
    dev = _FakeDevice(tmp_path)
    out = B.run(dev, str(tmp_path), now=1000.0)
    assert out and out.endswith(".tar.gz") and os.path.exists(out)
    assert not os.path.exists(out + ".part"), "the .part must be renamed away"


def test_run_skips_when_not_due(tmp_path):
    dev = _FakeDevice(tmp_path)
    B.record(str(tmp_path), ok=True, now=1000.0)
    assert B.run(dev, str(tmp_path), now=1000.0 + 600) is None
    assert dev.calls == 0, "must not touch the device when not due"


def test_a_failed_run_records_the_attempt_and_keeps_old_snapshots(tmp_path):
    d = tmp_path / B.SUBDIR; d.mkdir()
    keeper = d / "koreader-20260101.tar.gz"; keeper.write_bytes(b"old")
    dev = _FakeDevice(tmp_path, fail=RuntimeError("device exploded"))
    with pytest.raises(RuntimeError):
        B.run(dev, str(tmp_path), now=1000.0)
    assert keeper.exists(), "a failure must not cost the previous snapshot"
    assert B.is_due(str(tmp_path), now=1000.0 + 600) is False, "attempt recorded"
    # Recorded as a FAILURE: due again after the retry window, which a success
    # would have suppressed for a full day.
    assert B.is_due(str(tmp_path), now=1000.0 + 2 * 3600) is True


def test_an_unverifiable_archive_is_not_kept(tmp_path):
    bad = tmp_path / "bad.tar.gz.part"
    bad.write_bytes(b"not a tar at all")
    dev = _FakeDevice(tmp_path, payload=str(bad))
    with pytest.raises(B.BackupInvalid):
        B.run(dev, str(tmp_path), now=1000.0)
    assert not list((tmp_path / B.SUBDIR).glob("*.tar.gz")), "nothing promoted"


def test_run_rotates_after_a_successful_snapshot(tmp_path):
    d = tmp_path / B.SUBDIR; d.mkdir()
    for i in range(5):
        f = d / f"koreader-2026010{i}.tar.gz"; f.write_bytes(b"x")
        os.utime(f, (1000 + i, 1000 + i))
    dev = _FakeDevice(tmp_path)
    B.run(dev, str(tmp_path), now=1000.0, keep=3)
    assert len(list(d.glob("*.tar.gz"))) == 3
