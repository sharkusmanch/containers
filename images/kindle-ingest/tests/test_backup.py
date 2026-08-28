"""Config backup: the due-gate, archive verification, and rotation."""
import json
import os
import sqlite3
import tarfile
import time

import pytest

from app import backup as B

# A realistic clock: an epoch-1970 stamp renders as koreader-19691231,
# which sorts before every real snapshot and made rotation tests lie.
T0 = 1787875200.0        # 2026-08-27


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
    assert B.is_due(str(tmp_path), now=T0) is True


def test_not_due_again_within_a_day(tmp_path):
    B.record(str(tmp_path), ok=True, now=T0)
    assert B.is_due(str(tmp_path), now=T0 + 23 * 3600) is False


def test_due_again_after_a_day(tmp_path):
    B.record(str(tmp_path), ok=True, now=T0)
    assert B.is_due(str(tmp_path), now=T0 + 25 * 3600) is True


def test_a_failure_retries_sooner_than_a_success(tmp_path):
    B.record(str(tmp_path), ok=False, now=T0)
    assert B.is_due(str(tmp_path), now=T0 + 600) is False, "not every cycle"
    assert B.is_due(str(tmp_path), now=T0 + 2 * 3600) is True, "but sooner than a day"


def test_a_clock_stepped_backward_does_not_wedge_the_gate(tmp_path):
    # A timestamp in the future would otherwise hold the gate shut until the
    # clock caught up -- potentially days.
    B.record(str(tmp_path), ok=True, now=T0 + 9_000_000)
    assert B.is_due(str(tmp_path), now=T0) is True


def test_an_unreadable_state_file_is_treated_as_due(tmp_path):
    (tmp_path / B.STATE_FILE).write_text("{ not json")
    assert B.is_due(str(tmp_path), now=T0) is True


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
    out = B.run(dev, str(tmp_path), now=T0)
    assert out and out.endswith(".tar.gz") and os.path.exists(out)
    assert not os.path.exists(out + ".part"), "the .part must be renamed away"


def test_run_skips_when_not_due(tmp_path):
    dev = _FakeDevice(tmp_path)
    B.record(str(tmp_path), ok=True, now=T0)
    assert B.run(dev, str(tmp_path), now=T0 + 600) is None
    assert dev.calls == 0, "must not touch the device when not due"


def test_a_failed_run_records_the_attempt_and_keeps_old_snapshots(tmp_path):
    d = tmp_path / B.SUBDIR; d.mkdir()
    keeper = d / "koreader-20260101.tar.gz"; keeper.write_bytes(b"old")
    dev = _FakeDevice(tmp_path, fail=RuntimeError("device exploded"))
    with pytest.raises(RuntimeError):
        B.run(dev, str(tmp_path), now=T0)
    assert keeper.exists(), "a failure must not cost the previous snapshot"
    assert B.is_due(str(tmp_path), now=T0 + 600) is False, "attempt recorded"
    # Recorded as a FAILURE: due again after the retry window, which a success
    # would have suppressed for a full day.
    assert B.is_due(str(tmp_path), now=T0 + 2 * 3600) is True


def test_an_unverifiable_archive_is_not_kept(tmp_path):
    bad = tmp_path / "bad.tar.gz.part"
    bad.write_bytes(b"not a tar at all")
    dev = _FakeDevice(tmp_path, payload=str(bad))
    with pytest.raises(B.BackupInvalid):
        B.run(dev, str(tmp_path), now=T0)
    assert not list((tmp_path / B.SUBDIR).glob("*.tar.gz")), "nothing promoted"


def test_run_rotates_after_a_successful_snapshot(tmp_path):
    d = tmp_path / B.SUBDIR; d.mkdir()
    for i in range(5):
        f = d / f"koreader-2026010{i}.tar.gz"; f.write_bytes(b"x")
        os.utime(f, (1000 + i, 1000 + i))
    dev = _FakeDevice(tmp_path)
    B.run(dev, str(tmp_path), now=T0, keep=3)
    assert len(list(d.glob("*.tar.gz"))) == 3


# --- gaps found in review ---------------------------------------------------

def test_a_successful_run_closes_the_gate(tmp_path):
    # The single highest-consequence line in the module: without it every
    # 10-minute cycle would re-dump both databases and pull 480KB off a
    # sleeping Kindle, forever.
    dev = _FakeDevice(tmp_path)
    B.run(dev, str(tmp_path), now=T0)
    assert B.is_due(str(tmp_path), now=T0 + 600) is False
    assert B.is_due(str(tmp_path), now=T0 + 25 * 3600) is True


def test_a_failure_does_not_erase_an_earlier_success(tmp_path):
    # record() read-modify-writes; clobbering would silently downgrade the
    # daily gate to the hourly one forever.
    B.record(str(tmp_path), ok=True, now=T0)
    B.record(str(tmp_path), ok=False, now=T0 + 90000)
    st = json.loads((tmp_path / B.STATE_FILE).read_text())
    assert st["last_success"] == T0
    assert st["last_attempt"] == T0 + 90000


def test_an_unverifiable_archive_leaves_no_orphan_part(tmp_path):
    # rotate() ignores .part by design, so an orphan is never reaped -- it
    # would accumulate daily in a directory K8up ships offsite.
    bad = tmp_path / "bad.tar.gz.part"; bad.write_bytes(b"not a tar at all")
    dev = _FakeDevice(tmp_path, payload=str(bad))
    with pytest.raises(B.BackupInvalid):
        B.run(dev, str(tmp_path), now=T0)
    left = list((tmp_path / B.SUBDIR).iterdir())
    assert left == [], f"orphaned {[p.name for p in left]}"


def test_backoff_survives_a_backward_clock_step(tmp_path):
    # A future last_success must not short-circuit past the retry window, or a
    # failing backup retries every cycle for the whole width of the skew.
    B.record(str(tmp_path), ok=True, now=T0 + 9_000_000)
    B.record(str(tmp_path), ok=False, now=T0)
    assert B.is_due(str(tmp_path), now=T0 + 600) is False, "backoff still applies"
    assert B.is_due(str(tmp_path), now=T0 + 2 * 3600) is True, "and still recovers"


def test_a_missing_database_is_reported(tmp_path, caplog):
    import logging
    a = _archive(tmp_path, dbs={"statistics": _sqlite_bytes(tmp_path)})
    with caplog.at_level(logging.WARNING, logger="kindle-ingest"):
        B.verify(a, expect_dbs=("statistics", "vocabulary_builder"))
    assert "vocabulary_builder" in caplog.text


def test_an_archive_of_only_settings_is_accepted(tmp_path):
    # The design's sqlite3-missing degradation: Lua config without databases is
    # still worth keeping.
    B.verify(_archive(tmp_path, dbs={}))


def test_rotation_orders_by_the_date_in_the_name_not_mtime(tmp_path):
    # A restore that does not preserve timestamps would otherwise let rotation
    # delete the newest snapshots.
    d = tmp_path / "backups"; d.mkdir()
    for day in ("20260101", "20260210", "20260305"):
        f = d / f"koreader-{day}.tar.gz"; f.write_bytes(b"x")
    # mtimes deliberately inverted against the names
    os.utime(d / "koreader-20260305.tar.gz", (1000, 1000))
    os.utime(d / "koreader-20260101.tar.gz", (9000, 9000))
    B.rotate(str(d), keep=1)
    assert [p.name for p in d.iterdir()] == ["koreader-20260305.tar.gz"]


def test_rotation_skips_a_directory_matching_the_prefix(tmp_path):
    d = tmp_path / "backups"; d.mkdir()
    (d / "koreader-20260101.tar.gz").mkdir()          # not a file
    for day in ("20260202", "20260203"):
        (d / f"koreader-{day}.tar.gz").write_bytes(b"x")
    B.rotate(str(d), keep=1)
    assert (d / "koreader-20260203.tar.gz").exists(), "newest real snapshot kept"


def test_rotation_ignores_files_without_the_prefix(tmp_path):
    d = tmp_path / "backups"; d.mkdir()
    (d / "something-else.tar.gz").write_bytes(b"x")   # right suffix, wrong prefix
    (d / "koreader-20260101.tar.gz").write_bytes(b"x")
    B.rotate(str(d), keep=0)
    assert (d / "something-else.tar.gz").exists()


def test_a_link_member_is_rejected_as_backup_invalid(tmp_path):
    # extractfile raises KeyError on an unresolvable link -- it must not escape
    # verify() as something other than BackupInvalid.
    import tarfile as tf
    path = tmp_path / "link.tar.gz.part"
    with tf.open(path, "w:gz") as t:
        info = tf.TarInfo("settings/statistics.sqlite3.dbbk")
        info.type = tf.LNKTYPE
        info.linkname = "settings/../../etc/passwd"
        info.size = 10
        t.addfile(info)
    with pytest.raises(B.BackupInvalid):
        B.verify(str(path))


def test_an_implausibly_large_database_is_rejected(tmp_path):
    import io, tarfile as tf
    path = tmp_path / "big.tar.gz.part"
    with tf.open(path, "w:gz") as t:
        info = tf.TarInfo("settings/statistics.sqlite3.dbbk")
        info.size = B._MAX_DB_BYTES + 1
        t.addfile(info, io.BytesIO(b"\0" * info.size))
    with pytest.raises(B.BackupInvalid) as e:
        B.verify(str(path))
    assert "large" in str(e.value)
