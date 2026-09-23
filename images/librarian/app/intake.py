"""Scan intake dirs, stability windowing, arrival keys, sidecars, re-arrivals.

Watches /media/library_intake/{libation,kindle,manual} for new books. This
module only reads -- it never touches anything under the intake root, in
keeping with the plan's DRY_RUN guard (see app/config.py).

Untrusted input: `intake_root` is a directory tree an attacker with write
access to the NFS share controls (filenames, symlinks). `scan()` therefore
never follows a symlink out of the intake root: directory checks use
`os.scandir(..., follow_symlinks=False)` implicitly via `DirEntry.is_dir`,
and any entry that is itself a symlink is skipped outright rather than
traversed.
"""
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass

from app import states
from app.logutil import log_safe
from app.store import Store


logger = logging.getLogger(__name__)

# Also matches "*.aax.*" (e.g. "Foo.aax.tmp") per spec.
PARTIAL_SUFFIXES = (".aax", ".aaxc", ".tmp", ".part")

_LIBATION_DIR_RE = re.compile(r"^(?P<title>.+) \[(?P<id>[A-Za-z0-9]{10,13})\]$")

_KINDLE_EXTS = (".epub", ".cbz")
_MANUAL_PREFERRED_EXTS = (".m4b", ".epub", ".cbz")

_IGNORED_NAMES = {"_supplements"}


@dataclass
class Candidate:
    source: str  # "libation" | "kindle" | "manual"
    source_id: str
    path: str  # folder (libation, manual-folder) or file (kindle, manual-file)
    files: list[str]  # absolute paths, sorted
    sidecar: dict | None = None


def _is_ignored_name(name: str) -> bool:
    return name.startswith(".") or name in _IGNORED_NAMES


def _has_partial_suffix(name: str) -> bool:
    """True for a name ending in a PARTIAL_SUFFIXES entry, or containing one
    as a mid-name segment (the "*.aax.*" case, e.g. "Foo.aax.tmp")."""
    lower = name.lower()
    if lower.endswith(PARTIAL_SUFFIXES):
        return True
    parts = lower.split(".")
    return any(f".{p}" in PARTIAL_SUFFIXES for p in parts[1:-1])


def _iter_dir(path: str):
    """Yield (entry, is_dir) for non-symlink, non-hidden entries of `path`.

    Symlinks are skipped entirely -- this is untrusted (NFS-writable) input
    and a symlink could point outside the intake root. `follow_symlinks=False`
    on `is_dir`/`is_file` makes the type check itself not follow the link,
    and the explicit `is_symlink()` skip drops it before it's used at all.
    """
    try:
        with os.scandir(path) as it:
            entries = list(it)
    except (FileNotFoundError, NotADirectoryError):
        return
    for entry in sorted(entries, key=lambda e: e.name):
        if _is_ignored_name(entry.name):
            continue
        if entry.is_symlink():
            continue
        if entry.is_dir(follow_symlinks=False):
            yield entry, True
        elif entry.is_file(follow_symlinks=False):
            yield entry, False


def _list_files_recursive(root: str) -> list[str]:
    """All non-hidden, non-symlink files under `root`, sorted absolute paths."""
    out: list[str] = []
    for entry, is_dir in _iter_dir(root):
        if is_dir:
            out.extend(_list_files_recursive(entry.path))
        else:
            out.append(os.path.abspath(entry.path))
    return out


def _scan_libation(root: str) -> list[Candidate]:
    out = []
    for entry, is_dir in _iter_dir(root):
        if not is_dir:
            continue
        m = _LIBATION_DIR_RE.match(entry.name)
        if not m:
            logger.info("intake: ignoring libation dir not matching arrival pattern: %s", log_safe(entry.name))
            continue
        files = sorted(_list_files_recursive(entry.path))
        out.append(Candidate(
            source="libation",
            source_id=m.group("id"),
            path=os.path.abspath(entry.path),
            files=files,
        ))
    return out


def _scan_kindle(root: str) -> list[Candidate]:
    out = []
    for entry, is_dir in _iter_dir(root):
        if is_dir:
            continue
        stem, ext = os.path.splitext(entry.name)
        if ext.lower() not in _KINDLE_EXTS:
            continue
        sidecar_path = os.path.join(root, f"{stem}.json")
        if not os.path.isfile(sidecar_path) or os.path.islink(sidecar_path):
            continue  # no sidecar yet -> not a candidate
        try:
            with open(sidecar_path, "r", encoding="utf-8") as f:
                sidecar = json.load(f)
        except (OSError, ValueError) as e:
            logger.warning("intake: unreadable kindle sidecar %s: %s", log_safe(sidecar_path), log_safe(e))
            continue
        out.append(Candidate(
            source="kindle",
            source_id=stem,
            path=os.path.abspath(entry.path),
            files=[os.path.abspath(entry.path)],
            sidecar=sidecar,
        ))
    return out


def _scan_manual(root: str) -> list[Candidate]:
    out = []
    for entry, is_dir in _iter_dir(root):
        if is_dir:
            files = sorted(_list_files_recursive(entry.path))
            out.append(Candidate(
                source="manual",
                source_id=entry.name,
                path=os.path.abspath(entry.path),
                files=files,
            ))
        else:
            out.append(Candidate(
                source="manual",
                source_id=entry.name,
                path=os.path.abspath(entry.path),
                files=[os.path.abspath(entry.path)],
            ))
    return out


def scan(intake_root: str) -> list[Candidate]:
    """Scan `intake_root` for candidates in libation/, kindle/, manual/.

    A missing intake root, or a missing subdir, yields no candidates for
    that source rather than raising -- the intake root may not exist yet on
    a fresh volume, and a missing subdir shouldn't stop the others.
    """
    out: list[Candidate] = []
    out.extend(_scan_libation(os.path.join(intake_root, "libation")))
    out.extend(_scan_kindle(os.path.join(intake_root, "kindle")))
    out.extend(_scan_manual(os.path.join(intake_root, "manual")))
    return out


def signature(c: Candidate) -> tuple:
    sig = []
    for f in c.files:
        try:
            st = os.stat(f, follow_symlinks=False)
        except FileNotFoundError:
            return None  # a file vanished -- caller treats this as "unstable"
        sig.append((f, st.st_size, st.st_mtime_ns))
    return tuple(sig)


def _candidate_id(c: Candidate) -> tuple:
    return (c.source, c.source_id)


class Stability:
    """Tracks per-candidate quiet-period windows, in-memory only.

    A restart simply re-waits the quiet period -- safe, since nothing is
    acted on until `observe` returns True.
    """

    def __init__(self, quiet_period: int):
        self.quiet_period = quiet_period
        # id -> (signature, first_seen_stable_at)
        self._seen: dict[tuple, tuple] = {}

    def observe(self, c: Candidate, now: float) -> bool:
        cid = _candidate_id(c)
        sig = signature(c)
        if sig is None:
            # files disappeared out from under us -- forget the candidate.
            self._seen.pop(cid, None)
            return False

        has_partial = any(_has_partial_suffix(os.path.basename(f)) for f in c.files)

        prev = self._seen.get(cid)
        if prev is None or prev[0] != sig:
            self._seen[cid] = (sig, now)
            return False

        _, since = prev
        if has_partial:
            return False
        return (now - since) >= self.quiet_period


def primary_file(c: Candidate) -> str:
    """The file intake treats as "the book" for a candidate.

    libation: largest .m4b (Libation's base file is usually the truncated
    one, per spec -- the largest one is the real book).
    kindle: the .epub/.cbz (there is exactly one).
    manual: largest of .m4b/.epub/.cbz if any exist, else largest file.
    """
    if c.source == "kindle":
        return c.files[0]

    def size(f: str) -> int:
        try:
            return os.path.getsize(f)
        except OSError:
            return -1

    if c.source == "libation":
        m4bs = [f for f in c.files if f.lower().endswith(".m4b")]
        pool = m4bs or c.files
        return max(pool, key=size)

    # manual
    preferred = [f for f in c.files if f.lower().endswith(_MANUAL_PREFERRED_EXTS)]
    pool = preferred or c.files
    return max(pool, key=size)


def sha256_file(path: str, chunk: int = 8 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def arrival_key(c, sha: str) -> str:
    return f"{c.source}:{c.source_id}:{sha[:12]}"


def verify_sidecar(c: Candidate, sha: str) -> str | None:
    """Kindle-only: check the sidecar's declared sha256 against the real one.

    Returns an error string on mismatch (or a missing/malformed sidecar),
    else None. Non-kindle candidates always pass (None).
    """
    if c.source != "kindle":
        return None
    sidecar = c.sidecar or {}
    expected = sidecar.get("sha256")
    if not expected:
        return f"kindle sidecar for {c.source_id} has no sha256"
    if expected != sha:
        return f"kindle sidecar sha256 mismatch for {c.source_id}: expected {expected}, got {sha}"
    return None


def classify(key: str, c, sha: str, arrivals: Store, filed_hashes: dict) -> tuple[str, dict]:
    """Decide what to do with a freshly-hashed candidate.

    - "skip": an arrival already exists for this exact key (any state) --
      nothing new to do, re-scanning the same stable file is a no-op.
    - "duplicate": this exact content (by sha256) has already been filed
      under some other arrival -- `filed_hashes` maps sha256 -> book_id.
    - "new": genuinely new content. `previously_filed` is set to the book_id
      of an earlier FILED arrival sharing this candidate's `source:source_id`
      prefix (a re-arrival: same book, different bytes/sha -- e.g. a
      re-download), else None.
    """
    if arrivals.get(key) is not None:
        return ("skip", {})

    if sha in filed_hashes:
        return ("duplicate", {"book_id": filed_hashes[sha]})

    return ("new", {"previously_filed": previously_filed(key, c, arrivals)})


def previously_filed(key: str, c, arrivals: Store):
    """book_id of an earlier FILED arrival sharing `c`'s `source:source_id`
    prefix (a re-arrival of the same book with different bytes), else None."""
    prefix = f"{c.source}:{c.source_id}:"
    for rec in arrivals.all():
        rkey = rec.get(arrivals.key_field)
        if not isinstance(rkey, str) or not rkey.startswith(prefix):
            continue
        if rkey == key:
            continue
        if rec.get("state") != states.FILED:
            continue
        return rec.get("book_id")
    return None
