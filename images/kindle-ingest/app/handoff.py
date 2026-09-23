"""Intake hand-off: give a converted EPUB to the librarian instead of BookOrbit.

Once cleanup deletes the device copy, the intake file is the only copy of the
book outside the local archive, so every write here is crash-durable: a hidden
temp file (the librarian's scanner ignores dot-names), flush + fsync, an
explicit 0664 (the librarian shares the group; umask must not decide), an
atomic os.replace and a directory fsync so the new entry survives a crash.

The EPUB lands before its sidecar, and the sidecar carries the EPUB's hash, so
a sidecar never describes a file that is not fully there.
"""
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass

from .verify import sha256_file

FILE_MODE = 0o664
STALE_TEMP_AGE = 3600
# Only our own hidden temp names: `.<ASIN>.epub.tmp` / `.<ASIN>.json.tmp`.
_TEMP_RE = re.compile(r"^\.B[0-9A-Z]{9}\.(?:epub|json)\.tmp$")

log = logging.getLogger(__name__)


class HandoffFailed(Exception):
    """The intake write did not complete or did not verify. Retryable."""


class IntakeConflict(Exception):
    """The intake already holds a different file under this ASIN."""


@dataclass(frozen=True)
class Handoff:
    path: str
    sha256: str
    sidecar: str


def _fsync_dir(d: str) -> None:
    fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(dir_: str, name: str, write, before_replace=None) -> str:
    """Write via `.<name>.tmp` then os.replace onto `<name>`; returns the path.

    `before_replace` runs after the temp is durable and before it becomes
    visible under its real name -- the write-ahead hook.
    """
    final = os.path.join(dir_, name)
    tmp = os.path.join(dir_, f".{name}.tmp")
    try:
        with open(tmp, "wb") as f:
            write(f)
            f.flush()
            os.fchmod(f.fileno(), FILE_MODE)
            os.fsync(f.fileno())
        if before_replace is not None:
            before_replace()
        os.replace(tmp, final)
        _fsync_dir(dir_)
    except BaseException as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        if isinstance(e, OSError):
            raise HandoffFailed(f"writing {name}: {e}") from e
        raise
    return final


def _write_sidecar(dir_: str, asin: str, title: str, authors: list, sha: str) -> str:
    body = json.dumps({"asin": asin, "title": title, "authors": list(authors),
                       "source": "kindle", "sha256": sha, "kind": "epub"},
                      sort_keys=True).encode("utf-8")
    return _atomic_write(dir_, f"{asin}.json", lambda f: f.write(body))


def _sidecar_matches(path: str, sha: str) -> bool:
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("sha256") == sha


def to_intake(intake_dir: str, asin: str, epub: str, title: str,
              authors: list, pending_sha: str | None = None,
              on_pending=None) -> Handoff:
    """Place `<asin>.epub` + `<asin>.json` in the intake; idempotent.

    Write-ahead: `on_pending(sha)` is called (the caller persists it) before
    the EPUB becomes visible. calibre output is not byte-reproducible, so a
    retry cannot recognise its own earlier file by re-converting; an existing
    `<asin>.epub` hashing to this attempt's sha OR to `pending_sha` is ours and
    is adopted as-is (its sidecar written or repaired). Any other file under
    the same name is never overwritten.
    """
    try:
        want = sha256_file(epub)
    except OSError as e:
        raise HandoffFailed(f"reading converted epub: {e}") from e
    dst = os.path.join(intake_dir, f"{asin}.epub")
    side = os.path.join(intake_dir, f"{asin}.json")
    try:
        present = os.path.exists(dst)
        have = sha256_file(dst) if present else None
    except OSError as e:
        raise HandoffFailed(f"reading existing intake file: {e}") from e

    if present:
        if have != want and not (pending_sha and have == pending_sha):
            raise IntakeConflict("intake already holds a different file for this ASIN")
        if not _sidecar_matches(side, have):
            _write_sidecar(intake_dir, asin, title, authors, have)
        return Handoff(dst, have, side)

    def _copy(f):
        with open(epub, "rb") as src:
            shutil.copyfileobj(src, f, 1 << 20)
    _atomic_write(intake_dir, f"{asin}.epub", _copy,
                  before_replace=(lambda: on_pending(want)) if on_pending else None)
    try:
        got = sha256_file(dst)
    except OSError as e:
        raise HandoffFailed(f"re-reading intake file: {e}") from e
    if got != want:
        raise HandoffFailed(f"intake copy hashes {got[:12]}, expected {want[:12]}")
    _write_sidecar(intake_dir, asin, title, authors, got)
    return Handoff(dst, got, side)


def intake_still_consistent(path: str | None, sha: str | None) -> bool:
    """Cleanup gate for intake records.

    True when the intake file still hashes to the recorded sha, or is gone
    (the librarian moved it into the library). False when there is nothing
    recorded to vouch with, or the file there now is something else.
    """
    if not path or not sha:
        return False
    if not os.path.exists(path):
        # "Moved" only if the intake itself is there; a missing mount makes
        # every file look absent.
        return os.path.isdir(os.path.dirname(path))
    try:
        return sha256_file(path) == sha
    except FileNotFoundError:                # moved between the check and the read
        return os.path.isdir(os.path.dirname(path))
    except OSError:
        return False


def sweep_stale_temps(intake_dir: str, max_age: float = STALE_TEMP_AGE) -> int:
    """Remove our own hidden temps older than `max_age` (left by a crash).

    Matches only `.<ASIN>.epub.tmp` / `.<ASIN>.json.tmp`; anything else in the
    intake belongs to someone else and is left alone.
    """
    try:
        names = os.listdir(intake_dir)
    except OSError as e:
        log.warning("intake temp sweep skipped: %s", e)
        return 0
    cutoff = time.time() - max_age
    n = 0
    for name in names:
        if not _TEMP_RE.match(name):
            continue
        path = os.path.join(intake_dir, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.unlink(path)
                n += 1
        except OSError as e:
            log.warning("could not remove stale temp %s: %s", name, e)
    if n:
        log.info("removed %d stale intake temp file(s)", n)
    return n
