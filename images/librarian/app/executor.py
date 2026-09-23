"""The executor: the only code that files arrivals into the live library.

Two sequences (spec §3.4):
  attach       snapshot -> guard 2 -> stage -> re-hash -> guard 3 (re-read
               folderPath) -> link+unlink into the book folder -> scan+wait ->
               locate our file -> guard 9 restore (guard 8 first, then PATCH
               + settle) -> guard 8 -> rename-files -> verify the pattern
               name -> intake cleanup
  create_book  guard 2 -> stage -> re-hash -> exclusive mkdir
               `<root>/<author>/<title> [lib-<sha12>]` -> link+unlink ->
               scan+wait -> locate the new book -> wait for BookOrbit's
               provider fetch -> guard 8 -> metadata+locks (identity fields;
               subtitle/series null when absent, publishedYear/language from
               the arrival's EPUB OPF or left out) -> BookOrbit's own async
               rename settles -> verify folder + file -> intake cleanup

Task 9c (live probe of BookOrbit 3.0.0): every PATCH that carries title,
authors, seriesName, seriesIndex or publishedYear makes BookOrbit move the
book to its rendered pattern ~3 s later, and a move onto an existing target
is a silent no-op. So guard 8 (the collision check, against the exact
renderer in app.bo_render) runs BEFORE any such PATCH -- a collision means
no PATCH and an attention note, the file stays filed where it is -- and
after the PATCH the executor polls until the folder settles and verifies
it is exactly the rendered target. A mismatch is attention, never a failure:
the file is filed either way. rename-files is kept only for attach.

Task 11 (go-live canary): /media/books is an NFS mount, and guard 8's lookup
of the not-yet-existing target folder leaves a cached negative entry that
this pod keeps answering ENOENT from after BookOrbit (another NFS client)
created the folder. So the on-disk check of a listed file polls for up to
VERIFY_MAX s, re-listing the directories above it on every look
(fsops.fresh_lstat), and a failed check made right after BookOrbit's move is
parked (`unverified`) rather than noted: a later successful check of the
same filing -- this run or a resume -- drops it.

Crash safety (Global "Crash-safe execution"): before every side effect the
arrival record is rewritten in state `executing` with an `exec` journal
`{intent_id, step, src, dst, dst_dir, snapshot, scan_after_id, book_id, ...}`.
`step` names the side effect ABOUT to happen:
  staged -> linked -> unlinked -> scanned -> located -> metadata -> renamed -> cleaned
`resume(rec)` re-derives the truth from the filesystem (and BookOrbit, once a
scan may have renamed the file) and continues -- it never moves a file twice.
A journal is "open" while work is pending; a closed journal carries the final
`outcome`, so resuming it again only replays that outcome.

Outcomes (from `execute`/`resume`): `filed`; `retryable` (nothing moved --
the arrival is restored to its intake path -- OR the move is done and only a
resumable BookOrbit step is pending, journal left open; calling execute()
again with the same intent resumes); `failed` (a human must look; `detail`
names the exact paths; files are never moved back automatically).
`execute_update` (Plan 2, Task 3) shares the `retryable`/`failed` vocabulary
but reports `updated`, never `filed`, on success -- a metadata-only PATCH
files nothing.

Never deletes under /media/books: the only library-side calls are
`os.makedirs(author dir, exist_ok=True)`, an exclusive `os.mkdir`, `os.link`,
and `os.rmdir` of our OWN still-empty `[lib-<sha12>]` dir on a failed create.
"""
import errno
import logging
import os
import re
import stat
import threading
import time
from dataclasses import dataclass, field

from app import bo_render, bookmeta, fsops, metrics, states
from app.bookorbit import ScanError
from app.fsops import sha12
from app.logutil import log_safe
from app.policy import render_folder

logger = logging.getLogger(__name__)

__all__ = ["ExecResult", "Executor", "sha12", "STEPS"]

STEPS = ("staged", "linked", "unlinked", "scanned", "located", "metadata", "renamed", "cleaned")
LIBRARY_IDS = {"Library": 7, "Kids Audiobooks": 8}
INTENT_LIBRARY = {"adult": "Library", "kids": "Kids Audiobooks"}

GUARD2_WAIT = 600        # s: wait at most 10 min for a foreign scan
GUARD2_POLL = 15         # s
SCAN_TIMEOUT = 1200      # s: our own scan (Global: 20 min)
BASE_LOCKS = bookmeta.BASE_LOCKS
IDENTITY = bookmeta.IDENTITY
# update_metadata may ask for these locks (policy._UPDATE_METADATA_LOCK_FIELDS)
UPDATE_LOCKABLE = frozenset(BASE_LOCKS) | frozenset(bookmeta.IDENTITY_LOCKS)

# Task 9c: BookOrbit renames a book ~3 s after any PATCH carrying a
# rename-relevant field (bo_render.RENAME_RELEVANT_FIELDS), asynchronously.
SETTLE_POLL = 3          # s between book-detail reads while the rename lands
SETTLE_MAX = 90          # s: give up waiting; the verification decides
SETTLE_MIN = 12          # s: a stable read that does not match yet only ends the wait after this
# ... and ~5-12 s after a scan ADDS a book it fetches provider metadata that
# overwrites unlocked fields. Wait for it to land before the create PATCH.
FETCH_POLL = 5           # s
FETCH_QUIET = 20         # s: updatedAt unchanged this long = fetch settled
FETCH_MAX = 90           # s
# Guard 8 predicts BookOrbit's target with a hardcoded pattern and
# sanitisation setting (app.bo_render); re-check the live settings at most
# this often and refuse every PATCH/rename while they differ.
NAMING_CHECK_TTL = 600   # s
# Task 11: a file BookOrbit lists but this pod's NFS client cannot see yet
# (a cached negative lookup; acdirmax is 60 s) is looked for this long
# before it counts as missing.
VERIFY_POLL = 3          # s between looks
VERIFY_MAX = 90          # s
# The failed on-disk check exactly as images before Task 11 journaled it,
# as an ordinary note (see Executor._adopt_legacy_unverified).
_LEGACY_UNVERIFIED = re.compile(
    r"BookOrbit lists .+ for book \S+ but it is missing or the wrong size on disk", re.DOTALL)

# One scan mutex for the process: the executor is the only BookOrbit writer
# and every filing sequence runs under it end to end.
_SCAN_MUTEX = threading.Lock()


@dataclass
class ExecResult:
    ok: bool
    state: str                      # "filed" | "updated" | "removed" | "retryable" | "failed"
                                     # ("updated" only from execute_update, "removed"
                                     # only from remove_duplicate)
    book_id: int | None
    detail: str
    moves: list = field(default_factory=list)   # [(src, dst, size)]
    escalate: str | None = None     # filed, but a human should look (e.g. rename skipped)


class _Retry(Exception):
    """Transient: try again later."""


class _Fail(Exception):
    """Permanent for this attempt: a human must look."""


class _Stop(Exception):
    """The service is stopping: never start another step."""


class _Attention(Exception):
    """Filed stands, but a human should look (e.g. the metadata PATCH was
    withheld because BookOrbit would move the book onto a collision)."""


class _Integrity(_Fail):
    """A correctness failure retrying cannot fix (hash mismatch, ambiguous
    locate, source still present after the move): failed at once, never
    counted against the retry budget."""


MAX_ATTEMPTS = 5                 # after-move attempts before `failed` (spec: 5 retries)
HASH_BEAT_BYTES = 64 << 20       # beat() at least every 64 MiB while hashing
_PERMANENT_ERRNOS = frozenset({errno.ENAMETOOLONG, errno.EACCES, errno.EPERM, errno.EROFS})


def _is_regular(path) -> bool:
    """A regular file itself -- never through a symlink (lstat)."""
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def _epub_of(dossier) -> dict | None:
    """The arrival's EPUB OPF metadata from its dossier (`untrusted.epub`),
    or None (no dossier, an audio-only arrival, or a malformed entry)."""
    untrusted = dossier.get("untrusted") if isinstance(dossier, dict) else None
    epub = untrusted.get("epub") if isinstance(untrusted, dict) else None
    return epub if isinstance(epub, dict) else None


def _not_our_hard_link(src, dst) -> str | None:
    """None iff `src` and `dst` are both regular files (lstat, symlinks not
    followed) sharing one (st_dev, st_ino); else why not."""
    try:
        s, d = os.lstat(src), os.lstat(dst)
    except OSError as e:
        return f"cannot lstat source/destination: {type(e).__name__}"
    if not (stat.S_ISREG(s.st_mode) and stat.S_ISREG(d.st_mode)):
        return "source or destination is not a regular file (symlink?)"
    if (s.st_dev, s.st_ino) != (d.st_dev, d.st_ino):
        return "source and destination are different files"
    return None


class Executor:
    def __init__(self, settings, writer, index, arrivals, clock=time.time, sleep=time.sleep,
                 beat=metrics.beat, stopping=lambda: False):
        self.settings = settings
        self.writer = writer
        self.index = index
        self.arrivals = arrivals
        self.clock = clock
        self._sleep_fn = sleep
        self.beat = beat
        self.stopping = stopping
        self.intake_root = os.path.abspath(settings.intake_root)
        self.books_root = os.path.abspath(settings.local_books_root)
        self._naming = {}               # library id -> (checked_at, problem | None)
        self._naming_logged = set()     # problems already logged

    # --- public ---------------------------------------------------------------
    def execute(self, intent: dict, arrival_rec: dict, dossier: dict | None = None) -> ExecResult:
        """File one arrival per its approved intent record (`intent_id` +
        `payload`, or a bare payload carrying `intent_id`). An open journal
        for the same intent is resumed rather than started again.
        `dossier` is the arrival's stored dossier: a create_book takes a
        language/publishedYear the intent left out from its `untrusted.epub`
        (Task 11), resolved once, before the move, into the journal."""
        payload = intent.get("payload") or intent
        iid = intent.get("intent_id") or payload.get("intent_id")
        key = arrival_rec["key"]
        with _SCAN_MUTEX:
            cur = self.arrivals.get(key) or arrival_rec
            j = cur.get("exec")
            if isinstance(j, dict) and j.get("open"):
                if j.get("intent_id") == iid:
                    return self._resume_locked(cur)
                return ExecResult(False, "failed", None,
                                  f"arrival {key} has an open journal for intent "
                                  f"{j.get('intent_id')}; refusing to start {iid}")
            if isinstance(j, dict) and (
                    (j.get("outcome") or {}).get("state") == "filed"
                    or j.get("moved") or j.get("linked")):
                # filed, or the file already reached the library: never
                # restage or refile, and never overwrite that journal
                if j.get("intent_id") == iid:
                    return self._resume_locked(cur)       # replays the outcome
                return ExecResult(False, "failed", j.get("book_id"),
                                  f"refusing intent {iid}: arrival {key} was already handled by "
                                  f"intent {j.get('intent_id')} (its file reached the library)")
            return self._execute(iid, payload, cur, dossier)

    def resume(self, rec: dict) -> ExecResult:
        """Startup recovery for an arrival left in `executing`."""
        with _SCAN_MUTEX:
            return self._resume_locked(self.arrivals.get(rec["key"]) or rec)

    # --- update_metadata (Plan 2, Task 3) --------------------------------------
    def execute_update(self, intent: dict, arrival_rec: dict, book_id: int) -> ExecResult:
        """Patch identity/series metadata on `book_id` per an approved
        `update_metadata` intent -- called by the service right after the
        paired attach has filed successfully. No file moves, so none of the
        attach/create_book crash-safety journal applies: `patch_metadata`
        always re-GETs and merges the current `lockedFields` before writing
        (Global "Locks merge, never replace"), and the read-back comparison
        below is what decides success, so a re-run after a crash is simply
        another call with the same effect (patching is naturally idempotent
        here, unlike a file move). On success `state` is `"updated"`, not
        `"filed"` -- a metadata-only PATCH never filed anything (fix round
        1, Minor #5); the caller (Task 4) maps this to whatever intent/
        arrival state it uses for a completed correction.

        Fix round 1, Minor #2: refuses to PATCH anything -- with `state`
        `"failed"` and no BookOrbit call at all -- unless `intent`, the
        live arrival record, and `book_id` all agree this is a genuine,
        already-filed pairing: `intent["kind"]` must be `update_metadata`,
        the payload's own `arrival` must match the arrival record's key,
        and that arrival's exec journal must show a `filed` outcome for
        this EXACT `book_id` (never a different book, a retryable/failed
        outcome, or no journal at all -- e.g. calling this before the
        paired attach has actually completed).
        """
        if intent.get("kind") != states.UPDATE_METADATA:
            return ExecResult(False, "failed", book_id,
                              f"execute_update called with kind {intent.get('kind')!r}, expected "
                              f"{states.UPDATE_METADATA!r}")

        payload = intent.get("payload") or intent
        cur = self.arrivals.get(arrival_rec.get("key")) or arrival_rec
        if payload.get("arrival") != cur.get("key"):
            return ExecResult(False, "failed", book_id,
                              f"update_metadata payload arrival {payload.get('arrival')!r} does not "
                              f"match the arrival record {cur.get('key')!r}")

        journal = cur.get("exec")
        outcome = journal.get("outcome") if isinstance(journal, dict) else None
        if not (isinstance(outcome, dict) and outcome.get("state") == "filed"
                and outcome.get("book_id") == book_id):
            return ExecResult(False, "failed", book_id,
                              f"arrival {cur.get('key')!r} has no successful filing to book "
                              f"{book_id} recorded in its exec journal")

        payload_book_id = payload.get("book_id")
        if payload_book_id is not None and payload_book_id != book_id:
            return ExecResult(False, "failed", book_id,
                              f"update_metadata payload book_id {payload_book_id!r} does not match "
                              f"the attached book {book_id!r}")

        mapped = bookmeta.update_metadata_fields(payload.get("metadata") or {})
        if not mapped:
            return ExecResult(False, "failed", book_id,
                              "update_metadata has no writable metadata fields after mapping")
        # Task 9c (b): every identity field written is locked too
        lock = sorted({f for f in (payload.get("lock") or []) if f in UPDATE_LOCKABLE}
                      | (set(mapped) & set(bookmeta.IDENTITY_LOCKS)))
        moves = outcome.get("moves") or []
        filed = None                     # (ext, size) of the filed file, to find it after a rename
        if moves and isinstance(moves[0], (list, tuple)) and len(moves[0]) == 3:
            filed = (os.path.splitext(str(moves[0][1]))[1].lower(), moves[0][2])

        note = None
        try:
            with _SCAN_MUTEX:
                self._check_stop()
                d = self.index.detail(book_id, fresh=True)
                library = d.get("libraryName")
                if library not in LIBRARY_IDS:
                    return ExecResult(False, "failed", book_id,
                                      f"book {book_id} is in library {library!r}, not a filing target")
                self._guard2(LIBRARY_IDS[library])
                try:
                    plan = self._plan_patch(book_id, library, mapped)
                except _Attention as e:
                    return ExecResult(False, "failed", book_id, str(e))
                self.writer.patch_metadata(book_id, mapped, lock)
                after = self._settle(plan, filed)
                got = bookmeta.norm_for_compare(bookmeta.identity(after))
                want = bookmeta.norm_for_compare(mapped)
                bad = [k for k in want if got.get(k) != want[k]]
                if "audibleId" in mapped and bookmeta.audible_of(after) != mapped["audibleId"]:
                    bad.append("audibleId")
                if bad:
                    return ExecResult(False, "failed", book_id,
                                      f"update_metadata read-back mismatch on book {book_id}: "
                                      f"{', '.join(bad)}")
                missing = set(lock) - set(after.get("lockedFields") or [])
                if missing:
                    return ExecResult(False, "failed", book_id,
                                      f"locks missing on book {book_id} after PATCH: "
                                      f"{', '.join(sorted(missing))}")
                note = self._placement_problem(after, plan, filed)
        except (_Stop, _Retry) as e:
            return ExecResult(False, "retryable", book_id, str(e))
        except Exception as e:
            return ExecResult(False, "failed", book_id, f"{type(e).__name__}: {log_safe(e)}")

        detail = f"patched metadata on book {book_id}: {', '.join(sorted(mapped))}"
        if note:
            detail += f"; ESCALATE: {note}"
        return ExecResult(True, "updated", book_id, detail, escalate=note)

    # --- duplicates (final review M3) -------------------------------------------
    def remove_duplicate(self, arrival_rec: dict) -> ExecResult:
        """Remove the intake copy of a `duplicate` arrival (Global: the
        executor may remove intake copies of duplicate arrivals) -- only
        after a file of its book, in a filing library, is proven on disk to
        be a regular file with the arrival's sha256. Never touches the
        library. The arrival is staged into `.executing/<sha12>/` first
        (journaled as `dup` on the record); the staged primary is re-hashed
        before its unlink, and the leftovers go the way a filing's do
        (`fsops.cleanup`). Outcomes: `removed`, `retryable` (nothing
        removed), `failed` (intake copy kept -- restored if it was staged)."""
        key = arrival_rec["key"]
        with _SCAN_MUTEX:
            cur = self.arrivals.get(key) or arrival_rec
            if cur.get("dup_removed"):
                return ExecResult(True, "removed", cur.get("book_id"), "intake copy already removed")
            if cur.get("state") != states.DUPLICATE:
                return ExecResult(False, "failed", cur.get("book_id"),
                                  f"arrival {key} is {cur.get('state')!r}, not a duplicate")
            sha, book_id = cur.get("sha256"), cur.get("book_id")
            j = cur.get("dup") if isinstance(cur.get("dup"), dict) else None
            staged = False
            try:
                if not sha or type(book_id) is not int:
                    raise _Fail(f"duplicate {key} has no sha256/book_id")
                self._check_stop()
                where = self._library_copy(book_id, sha)
                sdir = fsops.staging_dir(self.intake_root, key)
                if os.path.lexists(sdir):
                    if j is None or j.get("staging_dir") != sdir:
                        raise _Fail(f"{sdir} exists but is not this duplicate's staging dir")
                    src, items = j["src"], j["staged"]
                    staged = True
                else:
                    sdir, items, src = fsops.plan_staging(cur, self.intake_root)
                    if not _is_regular(cur["primary"]) or self._hash(cur["primary"]) != sha:
                        raise _Fail(f"intake copy {cur['primary']} changed since it was hashed")
                    self.arrivals.record(key, states.DUPLICATE,
                                         dup={"staging_dir": sdir, "staged": items, "src": src})
                    staged = True
                    fsops.stage(sdir, items, self.intake_root)
                if os.path.lexists(src):
                    fsops.require_under(src, sdir, "duplicate copy")
                    if not _is_regular(src) or self._hash(src) != sha:
                        raise _Fail(f"staged copy {src} is not identical to {where}")
                    os.unlink(src)
                staged = False                  # the primary is gone: never unstage now
                summary = fsops.cleanup(cur.get("source"), sdir, self.intake_root,
                                        self._supplement_id({"key": key, "source": cur.get("source"),
                                                             "source_id": cur.get("source_id")}))
            except Exception as e:
                permanent = isinstance(e, (_Fail, fsops.UnsafePath)) or (
                    isinstance(e, OSError) and e.errno in _PERMANENT_ERRNOS)
                msg = str(e) if isinstance(e, (_Retry, _Stop, _Fail, fsops.UnsafePath)) else \
                    f"{type(e).__name__}: {log_safe(e)}"
                note = ""
                if staged:
                    err = fsops.unstage(sdir, items, self.intake_root)
                    if err:
                        permanent, note = True, f"; {err}"
                return ExecResult(False, "failed" if permanent else "retryable", book_id,
                                  f"duplicate intake copy kept: {msg}{note}")
            detail = f"removed the intake copy of {cur.get('primary')} (identical to {where})"
            if summary["supplements"]:
                detail += f"; supplements: {', '.join(summary['supplements'])}"
            if summary["left"]:
                detail += f"; left in intake: {', '.join(summary['left'])}"
            return ExecResult(True, "removed", book_id, detail)

    def _library_copy(self, book_id: int, sha: str) -> str:
        """The on-disk path of a file of `book_id` whose bytes hash to
        `sha` (regular file, inside a filing library), else _Fail."""
        d = self.index.detail(book_id, fresh=True)
        library = d.get("libraryName")
        if library not in LIBRARY_IDS:
            raise _Fail(f"book {book_id} is in library {library!r}, not a filing library")
        folder = self._local_folder(d, library)
        for f in d.get("files") or []:
            name = f.get("filename") if isinstance(f, dict) else None
            if not isinstance(name, str) or not name:
                continue
            p = os.path.join(folder, name)
            if fsops.is_under(p, self._lib_root(library)) and _is_regular(p) and self._hash(p) == sha:
                return p
        raise _Fail(f"no file of book {book_id} on disk has this arrival's sha256")

    # --- journal ------------------------------------------------------------
    def _journal(self, ctx: dict, step: str | None = None) -> None:
        if step is not None:
            ctx["step"] = step
        self.arrivals.record(ctx["key"], states.EXECUTING, exec=dict(ctx))

    def _close(self, ctx: dict, res: ExecResult) -> ExecResult:
        ctx["open"] = False
        ctx["outcome"] = {"state": res.state, "book_id": res.book_id, "detail": res.detail,
                          "moves": [list(m) for m in res.moves], "escalate": res.escalate}
        self._journal(ctx)
        return res

    def _moves(self, ctx) -> list:
        if ctx.get("moved"):
            return [(ctx["orig_primary"], ctx.get("final_path") or ctx["dst"], ctx["size"])]
        return []

    def _hash(self, path) -> str:
        """sha256 of a (possibly multi-GB) file, beating the heartbeat."""
        return fsops.hash_file(path, self.beat, HASH_BEAT_BYTES)

    # --- liveness -----------------------------------------------------------
    def _sleep(self, s):
        self.beat()
        if self.stopping():
            raise _Stop("service stopping")
        self._sleep_fn(s)

    def _check_stop(self):
        self.beat()
        if self.stopping():
            raise _Stop("service stopping")

    def _guard2(self, library_id: int) -> None:
        """Never write while any scan of the library runs; wait <= 10 min."""
        deadline = self.clock() + GUARD2_WAIT
        while self.writer.scan_running(library_id):
            if self.clock() >= deadline:
                raise _Retry(f"a scan of library {library_id} is still running after "
                             f"{GUARD2_WAIT // 60} min")
            self._sleep(GUARD2_POLL)

    @staticmethod
    def _segment(value, what):
        try:
            return bookmeta.safe_segment(value, what)
        except ValueError as e:
            raise _Fail(str(e)) from None

    # --- paths ---------------------------------------------------------------
    def _lib_root(self, library: str) -> str:
        return os.path.join(self.books_root, library)

    def _local_folder(self, d: dict, library: str) -> str:
        fp = d.get("folderPath")
        if not isinstance(fp, str) or not fp:
            raise _Fail(f"book {d.get('id')} has no folderPath")
        local = os.path.abspath(self.index.local_path(fp))
        if not fsops.is_under(local, self._lib_root(library)):
            raise _Fail(f"book {d.get('id')} folder {local} is outside {self._lib_root(library)}")
        return local

    # --- execute --------------------------------------------------------------
    def _execute(self, iid, payload, arrival, dossier=None) -> ExecResult:
        kind = payload.get("kind")
        key = arrival["key"]
        ctx = {"intent_id": iid, "key": key, "kind": kind, "open": True, "step": None,
               "source": arrival.get("source"), "source_id": arrival.get("source_id"),
               "sha256": arrival.get("sha256"), "orig_primary": arrival.get("primary"),
               "src": None, "dst": None, "dst_dir": None, "snapshot": None,
               "scan_after_id": None, "book_id": None, "moved": False, "created_dir": False}
        staged = False
        try:
            if kind not in (states.ATTACH, states.CREATE_BOOK):
                raise _Fail(f"executor cannot run intent kind {kind!r}")
            if not ctx["sha256"]:
                raise _Fail(f"arrival {key} has no sha256")
            self._check_stop()
            if kind == states.ATTACH:
                self._prepare_attach(ctx, payload)
            else:
                self._prepare_create(ctx, payload, arrival, dossier)
            self._guard2(ctx["library_id"])
            self._check_stop()
            if kind == states.ATTACH:
                self._prepare_attach(ctx, payload)     # re-snapshot AFTER the wait

            sdir, items, staged_primary = fsops.plan_staging(arrival, self.intake_root)
            ctx.update(staging_dir=sdir, staged=items, src=staged_primary,
                       filename=os.path.basename(staged_primary))
            self._journal(ctx, "staged")
            staged = True               # from here a failure restores (even a partial stage)
            try:
                fsops.stage(sdir, items, self.intake_root)
            except FileExistsError as e:
                raise _Fail(f"cannot stage the arrival: {e}")

            if not _is_regular(ctx["src"]):
                # final review M2: never hash/link THROUGH a symlink -- its
                # target (anywhere) would be linked into the library
                raise _Fail(f"staged primary {ctx['src']} is not a regular file (symlink?)")
            if self._hash(ctx["src"]) != ctx["sha256"]:
                raise _Fail(f"sha256 of {ctx['src']} no longer matches the arrival record")
            ctx["size"] = os.path.getsize(ctx["src"])
            self._check_stop()

            if kind == states.ATTACH:
                # guard 3: re-read folderPath immediately before the move
                d = self.index.detail(ctx["book_id"], fresh=True)
                folder = self._local_folder(d, ctx["library"])
                if not os.path.isdir(folder) or os.path.islink(folder):
                    raise _Fail(f"book folder {folder} is not a directory")
                ctx["dst_dir"] = folder
            ctx["dst"] = os.path.join(ctx["dst_dir"], ctx["filename"])
            if os.path.lexists(ctx["dst"]):
                raise _Fail(f"destination {ctx['dst']} already exists; never overwriting")

            self._journal(ctx, "linked")
            if kind == states.CREATE_BOOK:
                author_dir = os.path.dirname(ctx["dst_dir"])
                ctx["created_author"] = not os.path.lexists(author_dir)
                os.makedirs(author_dir, exist_ok=True)
                try:
                    os.mkdir(ctx["dst_dir"])                   # exclusive
                except FileExistsError:
                    raise _Fail(f"new book folder {ctx['dst_dir']} appeared (EEXIST)")
                ctx["created_dir"] = True
                self._journal(ctx)
            try:
                os.link(ctx["src"], ctx["dst"], follow_symlinks=False)
                ctx["linked"] = True
            except FileExistsError:
                raise _Fail(f"destination {ctx['dst']} appeared (EEXIST); never overwriting")
            except OSError as e:
                if e.errno == errno.EXDEV:
                    raise _Fail(f"EXDEV: {ctx['src']} and {ctx['dst']} are on different "
                                f"filesystems; refusing to copy")
                raise
            if self._hash(ctx["dst"]) != ctx["sha256"]:
                return self._close(ctx, ExecResult(
                    False, "failed", ctx["book_id"],
                    f"linked {ctx['src']} -> {ctx['dst']} but the destination hash does not "
                    f"match; both left in place for a human"))
            self._journal(ctx, "unlinked")
            fsops.require_under(ctx["src"], ctx["staging_dir"], "unlink source")
            os.unlink(ctx["src"])
            ctx["moved"] = True
            if os.path.getsize(ctx["dst"]) != ctx["size"]:
                raise _Fail(f"size of {ctx['dst']} differs after the move")
        except Exception as e:
            if ctx.get("moved"):
                return self._after_move_error(ctx, e)
            if ctx.get("linked"):
                # the library already holds a link to our file: never restore
                # the intake copy -- a human decides which one survives
                return self._close(ctx, ExecResult(
                    False, "failed", ctx.get("book_id"),
                    f"linked {ctx['src']} -> {ctx['dst']} but could not finish the move: "
                    f"{type(e).__name__}: {log_safe(e)}; both left in place"))
            return self._before_move_error(ctx, e, staged)

        return self._continue(ctx, "scanned")

    def _prepare_attach(self, ctx, payload):
        bid = payload.get("book_id")
        if type(bid) is not int:
            raise _Fail(f"attach needs an int book_id, got {bid!r}")
        d = self.index.detail(bid, fresh=True)
        library = d.get("libraryName")
        if library not in LIBRARY_IDS:
            raise _Fail(f"book {bid} is in library {library!r}, not a filing target")
        ctx.update(book_id=bid, library=library, library_id=LIBRARY_IDS[library])
        ctx["snapshot"] = dict(bookmeta.render_identity(d), files=bookmeta.files_of(d),
                               lockedFields=list(d.get("lockedFields") or []))

    def _prepare_create(self, ctx, payload, arrival, dossier=None):
        library = INTENT_LIBRARY.get(payload.get("library"))
        if library is None:
            raise _Fail(f"create_book library must be adult|kids, got {payload.get('library')!r}")
        md = payload.get("metadata") or {}
        authors = md.get("authors") or []
        author = self._segment(authors[0] if authors else None, "first author")
        title = self._segment(md.get("title"), "title")
        ctx.update(library=library, library_id=LIBRARY_IDS[library])
        root = self._lib_root(library)
        author_dir = os.path.join(root, author)
        self.index.refresh(now=self.clock(), force=True)
        if os.path.lexists(author_dir) and (os.path.islink(author_dir) or not os.path.isdir(author_dir)):
            raise _Fail(f"author path {author_dir} exists and is not a plain directory")
        real_author = os.path.realpath(author_dir)
        for b in self.index.books():
            fp = b.get("folderPath")
            if not isinstance(fp, str):
                continue
            try:
                if os.path.realpath(self.index.local_path(fp)) == real_author:
                    raise _Fail(f"author dir {author_dir} is itself a book folder (book {b.get('id')})")
            except ValueError:
                continue
        ctx["dst_dir"] = os.path.join(author_dir, f"{title} [lib-{sha12(ctx['key'])}]")
        if os.path.lexists(ctx["dst_dir"]):
            raise _Fail(f"new book folder {ctx['dst_dir']} already exists")
        ctx["max_book_id"] = max((int(b["id"]) for b in self.index.books()
                                  if isinstance(b.get("id"), int)), default=0)
        ctx["meta"] = bookmeta.create_metadata(md, arrival, _epub_of(dossier))

    # --- error handling -------------------------------------------------------
    def _before_move_error(self, ctx, e, staged) -> ExecResult:
        permanent = isinstance(e, (_Fail, fsops.UnsafePath)) or (
            isinstance(e, OSError) and e.errno in _PERMANENT_ERRNOS)
        state = "failed" if permanent else "retryable"
        msg = str(e) if isinstance(e, (_Retry, _Stop, _Fail, fsops.UnsafePath)) else \
            f"{type(e).__name__}: {log_safe(e)}"
        notes = []
        if ctx.get("created_dir"):
            note = self._rmdir_own(ctx)
            if note:
                notes.append(note)
            author_dir = os.path.dirname(ctx.get("dst_dir") or "")
            if author_dir and ctx.get("created_author") and os.path.isdir(author_dir) \
                    and not os.listdir(author_dir):
                notes.append(f"empty author dir {author_dir} left in the library (created by "
                             f"this attempt; not removed)")
        if staged:
            err = fsops.unstage(ctx["staging_dir"], ctx["staged"], self.intake_root)
            if err:
                state = "failed"
                notes.append(err)
        res = ExecResult(False, state, ctx.get("book_id"),
                         "; ".join([f"nothing moved: {msg}"] + notes))
        if ctx.get("step") is None:
            return res                      # no journal was ever written
        return self._close(ctx, res)

    def _after_move_error(self, ctx, e) -> ExecResult:
        """The file is in the library. Integrity failures close as `failed`
        at once; anything else keeps the journal open at the current step
        (resume continues there, never re-moving) until MAX_ATTEMPTS."""
        where = (f"file is at {ctx.get('final_path') or ctx['dst']} (from {ctx['orig_primary']}); "
                 f"staging {ctx.get('staging_dir')}")
        msg = str(e) if isinstance(e, (_Retry, _Stop, _Fail, ScanError)) else \
            f"{type(e).__name__}: {log_safe(e)}"
        if isinstance(e, _Integrity):
            return self._close(ctx, ExecResult(False, "failed", ctx.get("book_id"),
                                               f"step {ctx['step']}: {msg}; {where}", self._moves(ctx)))
        if isinstance(e, _Stop):
            self._journal(ctx)              # a stop is not an attempt
            return ExecResult(False, "retryable", ctx.get("book_id"),
                              f"step {ctx['step']} pending: {msg}; {where}", self._moves(ctx))
        ctx["attempts"] = int(ctx.get("attempts") or 0) + 1
        ctx["last_error"] = msg
        if ctx["attempts"] >= MAX_ATTEMPTS:
            return self._close(ctx, ExecResult(
                False, "failed", ctx.get("book_id"),
                f"step {ctx['step']} failed {ctx['attempts']} times, last: {msg}; {where}",
                self._moves(ctx)))
        self._journal(ctx)                  # stays open: resume continues at this step
        return ExecResult(False, "retryable", ctx.get("book_id"),
                          f"step {ctx['step']} pending (attempt {ctx['attempts']}/{MAX_ATTEMPTS}): "
                          f"{msg}; {where}", self._moves(ctx))

    def _rmdir_own(self, ctx) -> str | None:
        d = ctx.get("dst_dir")
        if not d or not os.path.basename(d).endswith(f"[lib-{sha12(ctx['key'])}]"):
            return None
        if not os.path.isdir(d) or os.path.islink(d):
            return None
        try:
            os.rmdir(d)                       # only succeeds when empty
        except FileNotFoundError:
            return None                       # already gone: a stale NFS view still showed it
        except OSError:
            return f"left non-empty {d}"
        return None

    # --- the post-move sequence ----------------------------------------------
    def _continue(self, ctx, from_step: str) -> ExecResult:
        steps = STEPS[STEPS.index(from_step):]
        self._adopt_legacy_unverified(ctx)
        notes = list(ctx.get("notes") or [])
        summary = None

        def note(n):
            if n:
                notes.append(n)
                ctx["notes"] = list(notes)
                self._journal(ctx)
        try:
            if STEPS.index(from_step) > STEPS.index("located"):
                self._locate(ctx)              # re-verify before anything else
            for step in steps:
                self._check_stop()
                self._journal(ctx, step)
                if step == "scanned":
                    self._scan(ctx)
                elif step == "located":
                    self._locate(ctx)
                    self._journal(ctx)         # persist book_id
                elif step == "metadata":
                    if ctx["kind"] == states.ATTACH:
                        note(self._guard9(ctx))
                    else:
                        note(self._write_metadata(ctx))
                elif step == "renamed":
                    note(self._rename(ctx))
                elif step == "cleaned":
                    try:
                        summary = fsops.cleanup(ctx["source"], ctx["staging_dir"],
                                                self.intake_root, self._supplement_id(ctx))
                    except Exception as ce:     # the book IS filed and verified
                        notes.append(f"intake cleanup of {ctx['staging_dir']} failed: "
                                     f"{type(ce).__name__}: {log_safe(ce)}")
        except Exception as e:
            return self._after_move_error(ctx, e)
        # a parked failed on-disk check no later check disproved (attach whose
        # rename step returned early) is still a reason to look
        notes += [ctx["unverified"]] if ctx.get("unverified") else []
        escalate = "; ".join(notes) if notes else None
        detail = f"filed {ctx['dst']} into book {ctx['book_id']}"
        if ctx.get("final_path"):
            detail += f" (now {ctx['final_path']})"
        if ctx.get("restored"):
            detail += f"; guard 9 restored {', '.join(ctx['restored'])}"
        if summary:
            if summary["supplements"]:
                detail += f"; supplements: {', '.join(summary['supplements'])}"
            if summary["deleted"]:
                detail += f"; removed: {', '.join(summary['deleted'])}"
            if summary["left"]:
                detail += f"; left in intake: {', '.join(summary['left'])}"
        if escalate:
            detail += f"; ESCALATE: {escalate}"
        return self._close(ctx, ExecResult(True, "filed", ctx["book_id"], detail,
                                           self._moves(ctx), escalate))

    @staticmethod
    def _adopt_legacy_unverified(ctx) -> None:
        """A journal written before Task 11 carries a failed on-disk check as
        an ordinary `notes` entry (the go-live canary's did, and its
        successful retry escalated it). Park it as `unverified` -- what the
        check produces today -- so the re-verify that follows drops it."""
        notes = ctx.get("notes") or []
        stale = [n for n in notes if isinstance(n, str) and _LEGACY_UNVERIFIED.fullmatch(n)]
        if stale:
            ctx["notes"] = [n for n in notes if n not in stale]
            parked = ([ctx["unverified"]] if ctx.get("unverified") else []) + stale
            ctx["unverified"] = "; ".join(parked)

    def _supplement_id(self, ctx) -> str:
        sid = ctx.get("source_id")
        if ctx.get("source") in ("libation", "kindle") and isinstance(sid, str) and bookmeta.ASIN_RE.match(sid):
            return sid
        return f"{ctx.get('source') or 'arrival'}-{sha12(ctx['key'])}"

    def _scan(self, ctx):
        """Trigger + wait. Any failure here is resumable: the move is done and
        resume() retries the scan, never the move."""
        lib = ctx["library_id"]
        try:
            ctx["scan_after_id"] = self.writer.scan(lib, timeout=SCAN_TIMEOUT, sleep=self._sleep,
                                                    clock=self.clock)
            self._journal(ctx)
            self.writer.wait_scan(lib, ctx["scan_after_id"], timeout=SCAN_TIMEOUT,
                                  sleep=self._sleep, clock=self.clock)
        except (_Stop, _Retry):
            raise
        except Exception as e:
            raise _Retry(f"scan of library {lib}: {log_safe(e)}") from e

    # --- locate -----------------------------------------------------------------
    def _match(self, d, ctx):
        """Our file in book `d`: by filename+size, else (a rename happened)
        by size+extension among files the book did not have before."""
        name, size = ctx["filename"], ctx["size"]
        ext = os.path.splitext(name)[1].lower()
        files = [f for f in d.get("files") or [] if isinstance(f, dict)]
        exact = [f for f in files if f.get("filename") == name and f.get("sizeBytes") == size]
        if len(exact) == 1:
            return exact[0], False
        before = {tuple(x) for x in (ctx.get("snapshot") or {}).get("files") or []}
        loose = [f for f in files if f.get("sizeBytes") == size
                 and str(f.get("filename") or "").lower().endswith(ext)
                 and (f.get("filename"), f.get("sizeBytes")) not in before]
        return (loose[0], True) if len(loose) == 1 else (None, False)

    def _verify_local(self, d, f, ctx, loose=False) -> str:
        """The on-disk path of file `f` BookOrbit lists for book `d`: a
        regular file (lstat -- never through a symlink) of the arrival's size
        inside the library, and, matched only by size+extension (`loose`),
        of the arrival's sha256.

        Task 11: BookOrbit may have moved the book seconds ago, and this
        pod's NFS client can still answer ENOENT for the new folder from a
        cached negative lookup (guard 8 looked it up before the PATCH). So
        the disk is polled for up to VERIFY_MAX s, VERIFY_POLL s apart
        (beating, and honouring stop, via _sleep), every look re-listing the
        directories above the file first (fsops.fresh_lstat), before the
        file counts as missing or the wrong size."""
        folder = self._local_folder(d, ctx["library"])
        p = os.path.join(folder, f["filename"])
        root = self._lib_root(ctx["library"])
        if not fsops.is_under(p, root):
            raise _Fail(f"listed file {p} is outside the library")
        start = self.clock()
        while True:
            st = fsops.fresh_lstat(p, root)
            if st is not None and stat.S_ISREG(st.st_mode) and st.st_size == ctx["size"]:
                break
            waited = self.clock() - start
            if waited >= VERIFY_MAX:
                raise _Fail(f"BookOrbit lists {p} for book {d.get('id')} but it is missing or the "
                            f"wrong size on disk (looked for {waited:.0f} s)")
            self._sleep(VERIFY_POLL)
        if self.clock() > start:
            logger.info("%s showed up on disk after %.0f s", log_safe(p), self.clock() - start)
        if not fsops.is_under(p, root):          # again, now that the whole path resolves
            raise _Fail(f"listed file {p} is outside the library")
        if loose and self._hash(p) != ctx["sha256"]:
            # matched only by size+extension (a rename happened): prove it's ours
            raise _Integrity(f"{p} matched by size only and its sha256 is not the arrival's")
        return p

    def _locate(self, ctx):
        if ctx.get("book_id") is not None:
            d = self.index.detail(ctx["book_id"], fresh=True)
            f, loose = self._match(d, ctx)
            if f is None:
                raise _Fail(f"book {ctx['book_id']} does not list {ctx['filename']} "
                            f"({ctx['size']} bytes) after the scan")
        else:
            d, f, loose = self._find_new_book(ctx)
        if d.get("libraryName") != ctx["library"]:
            raise _Fail(f"book {d.get('id')} is in {d.get('libraryName')!r}, expected {ctx['library']!r}")
        ctx["book_id"] = d["id"]
        ctx["final_path"] = self._verify_local(d, f, ctx, loose)
        ctx.pop("unverified", None)           # verified on disk now (see _placement_note)
        return d

    def _find_new_book(self, ctx):
        self.index.refresh(now=self.clock(), force=True)
        name, size = ctx["filename"], ctx["size"]
        ext = os.path.splitext(name)[1].lower()
        mine = os.path.realpath(ctx["dst_dir"])
        exact, loose = [], []
        for b in self.index.books():
            if b.get("libraryName") != ctx["library"]:
                continue
            new = isinstance(b.get("id"), int) and b["id"] > ctx.get("max_book_id", 0)
            try:
                here = os.path.realpath(self.index.local_path(b.get("folderPath") or "")) == mine
            except ValueError:
                here = False
            for f in b.get("files") or []:
                if not isinstance(f, dict) or f.get("sizeBytes") != size:
                    continue
                if f.get("filename") == name and (new or here):
                    exact.append((b, f))
                elif new and str(f.get("filename") or "").lower().endswith(ext):
                    loose.append((b, f))
        pick = exact if exact else loose
        if len(pick) > 1:
            raise _Integrity(f"could not locate exactly one new book holding {ctx['filename']} "
                             f"({size} bytes); found {len(pick)}: "
                             f"{sorted(b.get('id') for b, _f in pick)}")
        if not pick:
            raise _Fail(f"could not locate exactly one new book holding {ctx['filename']} "
                        f"({size} bytes); found none")
        b, f = pick[0]
        return self.index.detail(b["id"], fresh=True), f, not exact

    # --- metadata ---------------------------------------------------------------
    def _guard9(self, ctx) -> str | None:
        """Re-apply any identity field the new file changed, lock it, verify.
        Guard 8 first: a restore that would make BookOrbit move the book onto
        a collision is withheld (attention; the rename step is skipped too)."""
        snap = ctx["snapshot"]
        d = self.index.detail(ctx["book_id"], fresh=True)
        norm_snap = bookmeta.norm_for_compare(snap)
        cur = bookmeta.norm_for_compare(bookmeta.identity(d))
        changed = [k for k in IDENTITY if cur[k] != norm_snap[k]]
        if not changed:
            return None
        if "seriesName" in changed or "seriesIndex" in changed:
            changed = sorted(set(changed) | {"seriesName", "seriesIndex"}, key=IDENTITY.index)
        meta = {k: snap[k] for k in changed}
        locks = set(BASE_LOCKS) | set(changed)          # Task 9c (b): lock what we restore
        self._guard2(ctx["library_id"])
        try:
            plan = self._plan_patch(ctx["book_id"], ctx["library"], meta)
        except _Attention as e:
            ctx["no_rename"] = True
            return f"guard 9 restore of {', '.join(changed)}: {e}"
        self.writer.patch_metadata(ctx["book_id"], meta, sorted(locks))
        after = self._settle(plan, self._want(ctx))
        got = bookmeta.norm_for_compare(bookmeta.identity(after))
        still = [k for k in IDENTITY if got[k] != norm_snap[k]]
        if still:
            raise _Fail(f"guard 9: could not restore {', '.join(still)} on book {ctx['book_id']}")
        self._check_locks(after, locks | set(snap.get("lockedFields") or []))
        ctx["restored"] = changed
        return self._placement_note(ctx, after, plan)

    def _write_metadata(self, ctx) -> str | None:
        self._await_fetch(ctx["book_id"])
        meta = dict(ctx["meta"]["fields"])
        locks = bookmeta.create_locks(meta)      # Task 11: an omitted field stays unlocked
        d = self.index.detail(ctx["book_id"], fresh=True)
        tag = ctx["meta"].get("asin_tag")
        if tag:
            meta["tags"] = sorted(set(bookmeta.tag_names(d)) | {f"asin:{tag}"})
            locks.add("tags")
        self._guard2(ctx["library_id"])
        try:
            plan = self._plan_patch(ctx["book_id"], ctx["library"], meta)
        except _Attention as e:
            ctx["no_rename"] = True
            return str(e)
        self.writer.patch_metadata(ctx["book_id"], meta, sorted(locks))
        after = self._settle(plan, self._want(ctx))
        got = bookmeta.norm_for_compare(bookmeta.identity(after))
        want = bookmeta.norm_for_compare(meta)
        bad = [k for k in want if got[k] != want[k]]
        if "audibleId" in meta and bookmeta.audible_of(after) != meta["audibleId"]:
            bad.append("audibleId")
        if tag and f"asin:{tag}" not in bookmeta.tag_names(after):
            bad.append("tags")
        if bad:
            raise _Fail(f"metadata read-back mismatch on book {ctx['book_id']}: {', '.join(bad)}")
        self._check_locks(after, locks | set(d.get("lockedFields") or []))
        return self._placement_note(ctx, after, plan)

    def _await_fetch(self, book_id) -> None:
        """Task 9c (d): BookOrbit fetches provider metadata ~5-12 s after the
        scan that added the book and overwrites unlocked fields. Wait until
        the book's updatedAt has been still for FETCH_QUIET s (at most
        FETCH_MAX s) so our PATCH lands after it, not under it."""
        start = self.clock()
        last = self.index.detail(book_id, fresh=True).get("updatedAt")
        since = start
        while self.clock() - since < FETCH_QUIET and self.clock() - start < FETCH_MAX:
            self._sleep(FETCH_POLL)
            cur = self.index.detail(book_id, fresh=True).get("updatedAt")
            if cur != last:
                last, since = cur, self.clock()

    @staticmethod
    def _check_locks(d, want):
        have = set(d.get("lockedFields") or [])
        missing = set(want) - have
        if missing:
            raise _Fail(f"locks missing on book {d.get('id')} after PATCH: {', '.join(sorted(missing))}")

    # --- guard 8 + BookOrbit's own rename (Task 9c) ------------------------------
    @staticmethod
    def _want(ctx):
        """(extension, size) of the filed file -- how it is found after
        BookOrbit renamed it."""
        return (os.path.splitext(ctx["filename"])[1].lower(), ctx["size"])

    def _render(self, ident: dict, library: str, ext: str | None = None):
        """(folder rel, local folder, file name) BookOrbit renders for `ident`."""
        rel = render_folder(ident.get("authors") or [], ident.get("seriesName"),
                            ident.get("seriesIndex"), ident.get("title"))
        local = os.path.normpath(os.path.join(self._lib_root(library), rel))
        name = None
        if ext:
            path = bo_render.render_book_path(ident.get("authors") or [], ident.get("seriesName"),
                                              ident.get("seriesIndex"), ident.get("title"), ext)
            name = os.path.basename(path) if path else None
        return rel, local, name

    def _plan_patch(self, book_id: int, library: str, meta: dict) -> dict:
        """Guard 8 BEFORE a metadata PATCH, on fresh data. When the PATCH
        carries a rename-relevant field, render the folder BookOrbit will
        move the book to (current identity overlaid with `meta`) and run the
        collision check against it; a clash raises _Attention and nothing is
        written. Returns the plan `_settle`/`_placement_problem` use."""
        self._check_naming(library)
        self.index.refresh(now=self.clock(), force=True)
        d = self.index.detail(book_id, fresh=True)
        own = os.path.normpath(self._local_folder(d, library))
        plan = {"book_id": book_id, "library": library, "pre": own,
                "renames": any(k in meta for k in bo_render.RENAME_RELEVANT_FIELDS)}
        if not plan["renames"]:
            return plan
        ident = bookmeta.render_identity(d)      # stored seriesIndex string, verbatim
        ident.update({k: meta[k] for k in IDENTITY if k in meta})
        try:
            rel, target, _n = self._render(ident, library)
        except (TypeError, ValueError) as e:
            raise _Attention(f"metadata not written to book {book_id}: cannot render the folder "
                             f"BookOrbit would move it to ({e}); it stays at {own}") from None
        plan.update(ident=ident, rel=rel, target=target, change=target != own)
        if plan["change"]:
            clash = fsops.rename_collision(self.index, book_id, library, rel,
                                           self._lib_root(library), own)
            if clash:
                raise _Attention(f"metadata not written to book {book_id}: BookOrbit would move it "
                                 f"to {rel!r}, but {clash}; it stays filed at {own}")
        return plan

    def _check_naming(self, library: str) -> None:
        """Refuse (_Attention) while BookOrbit's naming settings differ from
        what app.bo_render hardcodes -- a wrong prediction could let
        BookOrbit move a book onto another book's folder and merge them.
        Cached per library for NAMING_CHECK_TTL s; each distinct problem is
        logged once. A failed read is transient (_Retry)."""
        lid = LIBRARY_IDS[library]
        now = self.clock()
        cached = self._naming.get(lid)
        if cached is None or now - cached[0] >= NAMING_CHECK_TTL:
            try:
                got = self.index.naming_settings(lid)
            except Exception as e:
                raise _Retry(f"cannot read BookOrbit's naming settings for library {lid}: "
                             f"{type(e).__name__}: {log_safe(e)}") from e
            lib = got.get("library") or {}
            san = (got.get("sanitization") or {}).get("enabled")
            bad = []
            if lib.get("fileNamingPattern") != bo_render.PATTERN:
                bad.append(f"fileNamingPattern is {lib.get('fileNamingPattern')!r}")
            if lib.get("fileRenameEnabled") is not True:
                bad.append(f"fileRenameEnabled is {lib.get('fileRenameEnabled')!r}")
            if lib.get("organizationMode") != "book_per_folder":
                bad.append(f"organizationMode is {lib.get('organizationMode')!r}")
            if san is not bo_render.SANITIZE:
                bad.append(f"cross-platform path sanitization is {san!r}")
            problem = None
            if bad:
                problem = (f"BookOrbit naming settings changed -- librarian paused filing "
                           f"(library {library}: {'; '.join(bad)}); no metadata or rename was "
                           f"sent; update app/bo_render.py to match, then re-file")
            cached = (now, problem)
            self._naming[lid] = cached
        problem = cached[1]
        if problem:
            if problem not in self._naming_logged:
                self._naming_logged.add(problem)
                logger.warning("%s", problem)
            raise _Attention(problem)

    def _sig(self, d):
        return (d.get("folderPath"), tuple(sorted((str(f.get("filename")), f.get("sizeBytes"))
                                                  for f in d.get("files") or [] if isinstance(f, dict))))

    def _settle(self, plan: dict, want=None) -> dict:
        """After the PATCH: poll the book every SETTLE_POLL s until its folder
        and files are the same on two consecutive reads AND (when a move was
        expected) the folder left the pre-PATCH path -- or, short of that,
        the placement already matches the plan / SETTLE_MIN s passed; give up
        after SETTLE_MAX s. Returns the last detail (verification decides)."""
        bid = plan["book_id"]
        if not plan["renames"]:
            return self.index.detail(bid, fresh=True)
        start, prev = self.clock(), None
        while True:
            self._sleep(SETTLE_POLL)
            d = self.index.detail(bid, fresh=True)
            sig = self._sig(d)
            elapsed = self.clock() - start
            if sig == prev:
                try:
                    moved = not plan["change"] or os.path.normpath(
                        self.index.local_path(d.get("folderPath") or "")) != plan["pre"]
                except ValueError:
                    moved = False
                if moved and (elapsed >= SETTLE_MIN or self._placement_problem(d, plan, want) is None):
                    return d
            if elapsed >= SETTLE_MAX:
                return d
            prev = sig

    def _placement_problem(self, d: dict, plan: dict, want=None) -> str | None:
        """None iff BookOrbit put the book exactly where the plan rendered it
        (folderPath normalised) and lists the filed file -- by (extension,
        size) -- under the pattern's file name."""
        if not plan.get("renames"):
            return None
        bid = plan["book_id"]
        fp = d.get("folderPath") or ""
        try:
            local = os.path.normpath(self.index.local_path(fp))
        except ValueError:
            local = None
        if local != plan["target"]:
            return (f"BookOrbit left book {bid} at {fp!r} instead of moving it to {plan['rel']!r} "
                    f"(rename skipped or still pending); its file stays filed there")
        if want is None:
            return None
        ext, size = want
        mine = [f for f in d.get("files") or [] if isinstance(f, dict) and f.get("sizeBytes") == size
                and str(f.get("filename") or "").lower().endswith(ext)]
        if not mine:
            return f"book {bid} no longer lists a {ext} file of {size} bytes after BookOrbit's rename"
        _r, _l, name = self._render(plan["ident"], plan["library"], ext)
        if name and not any(f.get("filename") == name for f in mine):
            return (f"book {bid}'s file is {mine[0].get('filename')!r}, not the pattern name "
                    f"{name!r}")
        return None

    def _placement_note(self, ctx, d, plan) -> str | None:
        """_placement_problem for a filing (returned: attention), then
        re-locate the file on disk (final_path) wherever it ended up.

        Task 11: a failed re-locate is NOT returned as a note. It is parked
        in ctx["unverified"] (journaled with the rest of ctx) and the next
        successful _locate -- the rename step's, or a resume's re-verify --
        drops it, so a slow NFS view never outlives the check that
        disproves it. A create_book always re-locates in its rename step
        (still failing = retryable); only one still parked when a filing
        completes escalates (_continue)."""
        problem = self._placement_problem(d, plan, self._want(ctx))
        try:
            self._locate(ctx)
        except _Integrity:
            raise
        except _Fail as e:
            ctx["unverified"] = str(e)
        return problem

    # --- rename-files (attach only) ---------------------------------------------
    def _rename(self, ctx) -> str | None:
        """create_book: BookOrbit's own async rename already placed the book
        (verified in the metadata step); only drop our emptied [lib-] dir.
        attach: guard 8 on fresh data, then rename-files so the new file
        takes the pattern name, then verify folder + name. Returns an
        attention note (file stays filed) or None."""
        if ctx.get("no_rename"):
            return None
        library = ctx["library"]
        if ctx["kind"] == states.CREATE_BOOK:
            after = self._locate(ctx)
            if ctx.get("dst_dir"):
                new_folder = self._local_folder(after, library)
                if os.path.realpath(ctx["dst_dir"]) != os.path.realpath(new_folder):
                    n = self._rmdir_own(ctx)     # our [lib-] dir, if BookOrbit left it
                    if n:
                        return f"after BookOrbit's rename: {n}"
            return None
        try:
            self._check_naming(library)
        except _Attention as e:
            return str(e)
        self.index.refresh(now=self.clock(), force=True)
        d = self.index.detail(ctx["book_id"], fresh=True)
        ident = bookmeta.render_identity(d)
        try:
            rel, target, _n = self._render(ident, library)
        except (TypeError, ValueError) as e:
            return f"rename-files skipped for book {ctx['book_id']}: cannot render its folder ({e})"
        own = self._local_folder(d, library)
        clash = fsops.rename_collision(self.index, ctx["book_id"], library, rel,
                                       self._lib_root(library), own)
        if clash:
            return f"rename-files skipped for book {ctx['book_id']}: {clash}"
        self._guard2(ctx["library_id"])
        self.writer.rename_files(ctx["book_id"])
        after = self._locate(ctx)               # re-read folderPath + verify on disk
        plan = {"book_id": ctx["book_id"], "library": library, "renames": True, "ident": ident,
                "rel": rel, "target": target}
        problem = self._placement_problem(after, plan, self._want(ctx))
        return f"rename-files did not give the expected pattern: {problem}" if problem else None

    # --- resume -----------------------------------------------------------------
    def _resume_locked(self, rec) -> ExecResult:
        j = rec.get("exec")
        if not isinstance(j, dict):
            return ExecResult(False, "failed", None, f"arrival {rec.get('key')} has no exec journal")
        ctx = dict(j)
        if not ctx.get("open"):
            o = ctx.get("outcome") or {}
            return ExecResult(o.get("state") == "filed", o.get("state") or "failed",
                              o.get("book_id"), o.get("detail") or "",
                              [tuple(m) for m in o.get("moves") or []], o.get("escalate"))
        step = ctx.get("step")
        src, dst = ctx.get("src"), ctx.get("dst")
        src_p = bool(src) and os.path.lexists(src)
        dst_p = bool(dst) and os.path.lexists(dst)
        where = (f"src {src} ({'present' if src_p else 'absent'}), "
                 f"dst {dst} ({'present' if dst_p else 'absent'})")

        def fail(why):
            return self._close(ctx, ExecResult(False, "failed", ctx.get("book_id"),
                                               f"resume at step {step}: {why}; {where}",
                                               self._moves(ctx)))

        def restore():
            # nothing reached the library: remove our own empty [lib-] dir
            # (it may exist even if the journal never recorded created_dir)
            # and put the arrival back where the watcher found it.
            if ctx.get("kind") == states.CREATE_BOOK and step in ("linked", "unlinked"):
                ctx["created_dir"] = True
            return self._before_move_error(ctx, _Retry("interrupted before the move"), True)

        try:
            if step in (None, "staged"):
                staged = os.path.lexists(ctx.get("staging_dir") or "")
                at_origin = all(os.path.lexists(o) for o, _s in ctx.get("staged") or [])
                if staged or at_origin:
                    return restore()
                return fail("the arrival is neither staged nor at its intake path")

            if step in ("linked", "unlinked", "scanned"):
                if src_p and not dst_p and step != "scanned":
                    return restore()
                if src_p and dst_p and step in ("linked", "unlinked"):
                    # final review C1: lstat identity, never samefile (which
                    # follows symlinks -- a symlink at dst pointing at src
                    # would have passed and src, the only copy, been unlinked)
                    why = _not_our_hard_link(src, dst)
                    if why:
                        return fail(why)
                    if self._hash(dst) != ctx.get("sha256"):
                        return fail("the destination's sha256 does not match the arrival; "
                                    "nothing unlinked")
                    # our own hard link: finishing the unlink is the rest of the move
                    fsops.require_under(src, ctx["staging_dir"], "unlink source")
                    ctx["linked"] = True
                    self._journal(ctx, "unlinked")
                    os.unlink(src)
                    ctx["moved"] = True
                    return self._continue(ctx, "scanned")
                if not src_p and dst_p:
                    if not _is_regular(dst):
                        return fail("the destination is not a regular file")
                    if self._hash(dst) != ctx.get("sha256"):
                        return fail("the destination's sha256 does not match the arrival")
                    ctx["moved"] = True
                    return self._continue(ctx, "scanned")
                if not src_p and not dst_p and step == "scanned":
                    # the scan may have renamed the file (fileRenameEnabled):
                    # only BookOrbit can say where it went
                    ctx["moved"] = True
                    try:
                        self._locate(ctx)
                    except _Integrity as e:
                        return fail(str(e))
                    return self._continue(ctx, "located")
                return fail("source/destination are not in a state resume can act on")

            if step not in STEPS:
                return fail(f"unknown journal step {step!r}")
            if src_p:
                return fail("the source is still in the intake after the move step")
            ctx["moved"] = True
            return self._continue(ctx, step)
        except Exception as e:
            return self._after_move_error(ctx, e) if ctx.get("moved") else fail(str(e))
