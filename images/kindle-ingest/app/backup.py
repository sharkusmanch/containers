"""Snapshot the Kindle's KOReader config into the K8up-backed state volume.

The device carries ~290KB of hand-built configuration that exists nowhere else:
reading layout, gestures, months of reading statistics, and one locally patched
plugin. KOReader has no backup feature. `/state` is already labelled
`k8up.io/backup: "true"`, so a snapshot dropped here inherits versioned,
encrypted, offsite backups without any new infrastructure.

Design: docs/superpowers/specs/2026-08-27-kindle-config-backup-design.md
"""
import json
import logging
import os
import sqlite3
import tarfile
import tempfile
import time

log = logging.getLogger("kindle-ingest")

STATE_FILE = "backup-state.json"
SUBDIR = "backups"
PREFIX = "koreader-"
SUFFIX = ".tar.gz"

KEEP = 14
DUE_AFTER = 24 * 3600      # a successful snapshot is good for a day
RETRY_AFTER = 3600         # a failed one retries sooner, but not every cycle

_DB_SUFFIX = ".sqlite3.dbbk"
_SQLITE_MAGIC = b"SQLite format 3\x00"
# The real databases are ~100KB; this only stops a berserk device from
# turning a backup into an OOM.
_MAX_DB_BYTES = 64 * 1024 * 1024


class BackupInvalid(Exception):
    """The archive arrived, but is not something worth keeping."""


def _state_path(state_dir: str) -> str:
    return os.path.join(state_dir, STATE_FILE)


def _read_state(state_dir: str) -> dict:
    try:
        with open(_state_path(state_dir)) as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        # An unreadable state file must not mean "never back up again".
        return {}


def is_due(state_dir: str, now: float | None = None) -> bool:
    """Should a snapshot be taken now?

    A success is good for DUE_AFTER; a failure retries after RETRY_AFTER, so a
    deterministic failure neither hammers the device every cycle nor waits a
    full day.

    A stamp in the FUTURE means the clock stepped backward. Such a stamp simply
    does not suppress -- it is never treated as "recent". Note the backoff is
    checked first and on its own terms, so a backward clock step cannot turn a
    repeatedly-failing backup into a retry on every 10-minute cycle.
    """
    now = time.time() if now is None else now
    s = _read_state(state_dir)

    def stamp(key):
        v = s.get(key)
        if isinstance(v, bool):          # float(True) == 1.0 would read as epoch+1
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        if f != f:                       # NaN compares false against everything
            return None
        return f

    for key, window in (("last_attempt", RETRY_AFTER), ("last_success", DUE_AFTER)):
        f = stamp(key)
        if f is not None and f <= now and now - f < window:
            return False
    return True


def record(state_dir: str, ok: bool, now: float | None = None) -> None:
    """Persist the outcome. Written to a temp file and renamed so a crash
    mid-write cannot leave state that parses as 'recently succeeded'."""
    now = time.time() if now is None else now
    s = _read_state(state_dir)
    s["last_attempt"] = now
    if ok:
        s["last_success"] = now
    os.makedirs(state_dir, exist_ok=True)
    tmp = _state_path(state_dir) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, _state_path(state_dir))


def verify(archive: str, expect_dbs: tuple[str, ...] = ()) -> None:
    """Reject an archive that would restore badly.

    `tar tzf` alone is not enough: it passes on a zero-byte database member,
    which is the same silent-stale failure the capture side exists to prevent,
    moved one layer out. Every database is checked for the SQLite header and
    run through PRAGMA integrity_check.
    """
    try:
        with tarfile.open(archive, "r:gz") as t:
            members = t.getmembers()
            names = [m.name for m in members]
            if not names:
                raise BackupInvalid("archive is empty")
            dbs = [m for m in members if m.name.endswith(_DB_SUFFIX)]
            if not dbs and not any(n.endswith(".lua") for n in names):
                raise BackupInvalid("archive carries neither settings nor databases")
            for m in dbs:
                _verify_db(t, m)
            # A database that is simply absent is the silent-stale failure this
            # design exists to prevent, so say so. It is a warning rather than a
            # rejection because the design's sqlite3-missing path deliberately
            # ships the Lua config without databases.
            present = {os.path.basename(m.name)[:-len(_DB_SUFFIX)] for m in dbs}
            for want in expect_dbs:
                if want not in present:
                    log.warning("backup carries no %s database", want)
    except BackupInvalid:
        raise
    except (tarfile.TarError, EOFError, OSError, KeyError) as e:
        raise BackupInvalid(f"unreadable archive: {type(e).__name__}: {e}") from e


def _verify_db(tar: tarfile.TarFile, member: tarfile.TarInfo) -> None:
    # isreg first: directories and links also report size 0, and "is empty"
    # would be a misleading diagnosis for them.
    if not member.isreg():
        raise BackupInvalid(f"{member.name} is not a regular file")
    if member.size == 0:
        raise BackupInvalid(f"{member.name} is empty")
    if member.size > _MAX_DB_BYTES:
        raise BackupInvalid(f"{member.name} is implausibly large ({member.size} bytes)")
    fh = tar.extractfile(member)
    if fh is None:
        raise BackupInvalid(f"{member.name} could not be read")
    blob = fh.read()
    if not blob.startswith(_SQLITE_MAGIC):
        raise BackupInvalid(f"{member.name} is not a SQLite database")
    # integrity_check needs a real file; the databases are ~100KB.
    with tempfile.NamedTemporaryFile(suffix=".sqlite3") as tmp:
        tmp.write(blob)
        tmp.flush()
        try:
            con = sqlite3.connect(tmp.name)
            try:
                row = con.execute("PRAGMA integrity_check").fetchone()
            finally:
                con.close()
        except sqlite3.Error as e:
            raise BackupInvalid(f"{member.name}: {e}") from e
    if not row or row[0] != "ok":
        raise BackupInvalid(f"{member.name}: integrity_check said {row and row[0]!r}")


def rotate(backup_dir: str, keep: int = KEEP) -> list[str]:
    """Keep the newest `keep` snapshots. Returns what was removed.

    Only completed snapshots are considered: a `.part` belongs to a run still in
    flight and is never a rotation candidate.
    """
    try:
        names = os.listdir(backup_dir)
    except FileNotFoundError:
        return []
    # Ordered by the date in the name, not mtime. Names are
    # koreader-YYYYMMDD.tar.gz -- fixed width and zero padded, so lexicographic
    # order IS chronological, and unlike mtime it survives a restore that does
    # not preserve timestamps (restoring from restic into a rebuilt PVC would
    # otherwise stamp every file with `now` and rotation could delete the
    # newest). Directories matching the prefix are skipped: unlink would fail
    # on them and a real snapshot would die in their place.
    snaps = sorted(n for n in names
                   if n.startswith(PREFIX) and n.endswith(SUFFIX)
                   and os.path.isfile(os.path.join(backup_dir, n)))
    removed = []
    for n in snaps[:max(0, len(snaps) - keep)]:
        try:
            os.unlink(os.path.join(backup_dir, n))
            removed.append(n)
        except OSError as e:
            log.warning("could not prune %s: %s", n, e)
    return removed


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def run(device, state_dir: str, now: float | None = None,
        keep: int = KEEP, expect_dbs: tuple[str, ...] = ()) -> str | None:
    """Take a snapshot if one is due. Returns its path, or None.

    Raises only BackupInvalid or whatever `device` raises; the caller is
    expected to treat any failure as non-fatal.
    """
    now = time.time() if now is None else now
    if not is_due(state_dir, now):
        return None
    backup_dir = os.path.join(state_dir, SUBDIR)
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d", time.localtime(now))
    final = os.path.join(backup_dir, f"{PREFIX}{stamp}{SUFFIX}")
    part = None
    try:
        part = device.backup_config(final)
        verify(part, expect_dbs=expect_dbs)
        os.replace(part, final)      # only a verified archive gets the real name
        part = None
    except Exception:
        # Ownership of the .part transfers to us the moment backup_config
        # returns it, and rotate() deliberately ignores .part files -- so
        # without this a failing verify would mint a new date-stamped orphan
        # every day, in a directory K8up ships offsite. That is the same hazard
        # the .part exists to avoid.
        if part:
            _unlink_quietly(part)
        # The attempt is recorded even on failure, so a deterministic problem
        # backs off instead of retrying every cycle.
        record(state_dir, ok=False, now=now)
        raise
    record(state_dir, ok=True, now=now)
    dropped = rotate(backup_dir, keep)
    try:
        size = os.path.getsize(final)
    except OSError:                  # pruned from under us; the backup still worked
        size = -1
    log.info("koreader config backed up to %s (%d bytes)%s",
             os.path.basename(final), size,
             f", pruned {len(dropped)}" if dropped else "")
    return final
