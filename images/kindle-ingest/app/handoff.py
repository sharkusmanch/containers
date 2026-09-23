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
import os
import shutil
from dataclasses import dataclass

from .verify import sha256_file

FILE_MODE = 0o664


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


def _atomic_write(dir_: str, name: str, write) -> str:
    """Write via `.<name>.tmp` then os.replace onto `<name>`; returns the path."""
    final = os.path.join(dir_, name)
    tmp = os.path.join(dir_, f".{name}.tmp")
    try:
        with open(tmp, "wb") as f:
            write(f)
            f.flush()
            os.fchmod(f.fileno(), FILE_MODE)
            os.fsync(f.fileno())
        os.replace(tmp, final)
        _fsync_dir(dir_)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise HandoffFailed(f"writing {name}: {e}") from e
    return final


def _write_sidecar(dir_: str, asin: str, title: str, authors: list, sha: str) -> str:
    body = json.dumps({"asin": asin, "title": title, "authors": list(authors),
                       "source": "kindle", "sha256": sha, "kind": "epub"},
                      sort_keys=True).encode("utf-8")
    return _atomic_write(dir_, f"{asin}.json", lambda f: f.write(body))


def to_intake(intake_dir: str, asin: str, epub: str, title: str,
              authors: list) -> Handoff:
    """Place `<asin>.epub` + `<asin>.json` in the intake; idempotent.

    An identical `<asin>.epub` already present counts as done (a crash after
    the replace but before the ledger write); only a missing sidecar is then
    written. A different file under the same name is never overwritten.
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
        if have != want:
            raise IntakeConflict("intake already holds a different file for this ASIN")
        if not os.path.exists(side):
            _write_sidecar(intake_dir, asin, title, authors, have)
        return Handoff(dst, have, side)

    def _copy(f):
        with open(epub, "rb") as src:
            shutil.copyfileobj(src, f, 1 << 20)
    _atomic_write(intake_dir, f"{asin}.epub", _copy)
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
        return True
    try:
        return sha256_file(path) == sha
    except FileNotFoundError:
        return True                          # moved between the check and the read
    except OSError:
        return False
