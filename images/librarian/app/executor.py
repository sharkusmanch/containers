"""The executor: the only code that files arrivals into the live library.

Two sequences (spec §3.4):
  attach       snapshot -> guard 2 -> stage -> re-hash -> guard 3 (re-read
               folderPath) -> link+unlink into the book folder -> scan+wait ->
               locate our file -> guard 9 restore -> rename-files -> verify ->
               intake cleanup
  create_book  guard 2 -> stage -> re-hash -> exclusive mkdir
               `<root>/<author>/<title> [lib-<sha12>]` -> link+unlink ->
               scan+wait -> locate the new book -> metadata+locks -> read back
               -> rename-files -> verify -> intake cleanup

Crash safety (Global "Crash-safe execution"): before every side effect the
arrival record is rewritten in state `executing` with an `exec` journal
`{intent_id, step, src, dst, dst_dir, snapshot, scan_after_id, book_id, ...}`.
`step` names the side effect ABOUT to happen:
  staged -> linked -> unlinked -> scanned -> located -> metadata -> renamed -> cleaned
`resume(rec)` re-derives the truth from the filesystem (and BookOrbit, once a
scan may have renamed the file) and continues -- it never moves a file twice.
A journal is "open" while work is pending; a closed journal carries the final
`outcome`, so resuming it again only replays that outcome.

Outcomes: `filed`; `retryable` (nothing moved -- the arrival is restored to
its intake path -- OR the move is done and only a resumable BookOrbit step is
pending, journal left open; calling execute() again with the same intent
resumes); `failed` (a human must look; `detail` names the exact paths; files
are never moved back automatically).

Never deletes under /media/books: the only library-side calls are
`os.makedirs(author dir, exist_ok=True)`, an exclusive `os.mkdir`, `os.link`,
and `os.rmdir` of our OWN still-empty `[lib-<sha12>]` dir on a failed create.
"""
import errno
import os
import threading
import time
from dataclasses import dataclass, field

from app import bookmeta, fsops, metrics, states
from app.bookorbit import ScanError
from app.fsops import sha12
from app.logutil import log_safe
from app.policy import render_folder

__all__ = ["ExecResult", "Executor", "sha12", "STEPS"]

STEPS = ("staged", "linked", "unlinked", "scanned", "located", "metadata", "renamed", "cleaned")
LIBRARY_IDS = {"Library": 7, "Kids Audiobooks": 8}
INTENT_LIBRARY = {"adult": "Library", "kids": "Kids Audiobooks"}

GUARD2_WAIT = 600        # s: wait at most 10 min for a foreign scan
GUARD2_POLL = 15         # s
SCAN_TIMEOUT = 1200      # s: our own scan (Global: 20 min)
BASE_LOCKS = ("title", "subtitle", "description")
IDENTITY = bookmeta.IDENTITY

# One scan mutex for the process: the executor is the only BookOrbit writer
# and every filing sequence runs under it end to end.
_SCAN_MUTEX = threading.Lock()


@dataclass
class ExecResult:
    ok: bool
    state: str                      # "filed" | "retryable" | "failed"
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


class _Integrity(_Fail):
    """A correctness failure retrying cannot fix (hash mismatch, ambiguous
    locate, source still present after the move): failed at once, never
    counted against the retry budget."""


MAX_ATTEMPTS = 5                 # after-move attempts before `failed` (spec: 5 retries)
HASH_BEAT_BYTES = 64 << 20       # beat() at least every 64 MiB while hashing
_PERMANENT_ERRNOS = frozenset({errno.ENAMETOOLONG, errno.EACCES, errno.EPERM, errno.EROFS})


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

    # --- public ---------------------------------------------------------------
    def execute(self, intent: dict, arrival_rec: dict, dossier: dict | None = None) -> ExecResult:
        """File one arrival per its approved intent record (`intent_id` +
        `payload`, or a bare payload carrying `intent_id`). An open journal
        for the same intent is resumed rather than started again."""
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
            return self._execute(iid, payload, cur)

    def resume(self, rec: dict) -> ExecResult:
        """Startup recovery for an arrival left in `executing`."""
        with _SCAN_MUTEX:
            return self._resume_locked(self.arrivals.get(rec["key"]) or rec)

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
    def _execute(self, iid, payload, arrival) -> ExecResult:
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
                self._prepare_create(ctx, payload, arrival)
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
                os.link(ctx["src"], ctx["dst"])
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
        ctx["snapshot"] = dict(bookmeta.identity(d), files=bookmeta.files_of(d),
                               lockedFields=list(d.get("lockedFields") or []))

    def _prepare_create(self, ctx, payload, arrival):
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
        ctx["meta"] = bookmeta.create_metadata(md, arrival)

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
        except OSError:
            return f"left non-empty {d}"
        return None

    # --- the post-move sequence ----------------------------------------------
    def _continue(self, ctx, from_step: str) -> ExecResult:
        steps = STEPS[STEPS.index(from_step):]
        escalate = None
        summary = None
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
                        self._guard9(ctx)
                    else:
                        self._write_metadata(ctx)
                elif step == "renamed":
                    escalate = self._rename(ctx)
                elif step == "cleaned":
                    try:
                        summary = fsops.cleanup(ctx["source"], ctx["staging_dir"],
                                                self.intake_root, self._supplement_id(ctx))
                    except Exception as ce:     # the book IS filed and verified
                        note = (f"intake cleanup of {ctx['staging_dir']} failed: "
                                f"{type(ce).__name__}: {log_safe(ce)}")
                        escalate = f"{escalate}; {note}" if escalate else note
        except Exception as e:
            return self._after_move_error(ctx, e)
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
        folder = self._local_folder(d, ctx["library"])
        p = os.path.join(folder, f["filename"])
        if not fsops.is_under(p, self._lib_root(ctx["library"])):
            raise _Fail(f"listed file {p} is outside the library")
        if os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) != ctx["size"]:
            raise _Fail(f"BookOrbit lists {p} for book {d.get('id')} but it is missing or the "
                        f"wrong size on disk")
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
    def _guard9(self, ctx):
        """Re-apply any identity field the new file changed, lock, verify."""
        snap = ctx["snapshot"]
        d = self.index.detail(ctx["book_id"], fresh=True)
        norm_snap = bookmeta.norm_for_compare(snap)
        cur = bookmeta.norm_for_compare(bookmeta.identity(d))
        changed = [k for k in IDENTITY if cur[k] != norm_snap[k]]
        if not changed:
            return
        if "seriesName" in changed or "seriesIndex" in changed:
            changed = sorted(set(changed) | {"seriesName", "seriesIndex"}, key=IDENTITY.index)
        self._guard2(ctx["library_id"])
        self.writer.patch_metadata(ctx["book_id"], {k: snap[k] for k in changed}, list(BASE_LOCKS))
        after = self.index.detail(ctx["book_id"], fresh=True)
        got = bookmeta.norm_for_compare(bookmeta.identity(after))
        still = [k for k in IDENTITY if got[k] != norm_snap[k]]
        if still:
            raise _Fail(f"guard 9: could not restore {', '.join(still)} on book {ctx['book_id']}")
        self._check_locks(after, set(BASE_LOCKS) | set(snap.get("lockedFields") or []))
        ctx["restored"] = changed

    def _write_metadata(self, ctx):
        meta = dict(ctx["meta"]["fields"])
        locks = set(BASE_LOCKS)
        d = self.index.detail(ctx["book_id"], fresh=True)
        tag = ctx["meta"].get("asin_tag")
        if tag:
            meta["tags"] = sorted(set(bookmeta.tag_names(d)) | {f"asin:{tag}"})
            locks.add("tags")
        self._guard2(ctx["library_id"])
        self.writer.patch_metadata(ctx["book_id"], meta, sorted(locks))
        after = self.index.detail(ctx["book_id"], fresh=True)
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

    @staticmethod
    def _check_locks(d, want):
        have = set(d.get("lockedFields") or [])
        missing = set(want) - have
        if missing:
            raise _Fail(f"locks missing on book {d.get('id')} after PATCH: {', '.join(sorted(missing))}")

    # --- rename-files -------------------------------------------------------------
    def _rename(self, ctx) -> str | None:
        """Guard 8 on fresh data, then rename-files, then re-verify. Returns an
        escalation note when the rename was skipped (file stays filed)."""
        self.index.refresh(now=self.clock(), force=True)
        d = self.index.detail(ctx["book_id"], fresh=True)
        ident = bookmeta.identity(d)
        library = ctx["library"]
        try:
            rendered = render_folder(ident["authors"][0], ident["seriesName"],
                                     d.get("seriesIndex"), ident["title"])
        except (IndexError, TypeError, ValueError) as e:
            return f"rename-files skipped for book {ctx['book_id']}: cannot render its folder ({e})"
        own = self._local_folder(d, library)
        clash = fsops.rename_collision(self.index, ctx["book_id"], library, rendered,
                                       self._lib_root(library), own)
        if clash:
            return f"rename-files skipped for book {ctx['book_id']}: {clash}"
        self._guard2(ctx["library_id"])
        self.writer.rename_files(ctx["book_id"])
        after = self._locate(ctx)               # re-read folderPath + verify on disk
        if ctx["kind"] == states.CREATE_BOOK and ctx.get("dst_dir"):
            new_folder = self._local_folder(after, library)
            if os.path.realpath(ctx["dst_dir"]) != os.path.realpath(new_folder):
                note = self._rmdir_own(ctx)     # our [lib-] dir, now empty
                if note:
                    return f"after rename-files: {note}"
        return None

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
                    if not os.path.samefile(src, dst):
                        return fail("source and destination are different files")
                    # our own hard link: finishing the unlink is the rest of the move
                    fsops.require_under(src, ctx["staging_dir"], "unlink source")
                    ctx["linked"] = True
                    self._journal(ctx, "unlinked")
                    os.unlink(src)
                    ctx["moved"] = True
                    return self._continue(ctx, "scanned")
                if not src_p and dst_p:
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
