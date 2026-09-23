"""The nightly read-along run.

One book at a time through Storyteller: import -> align -> download -> gate
-> publish -> verify, releasing Storyteller's copy once the read-along is
gated. New books start only in the first START_HOURS of the run and only if
their estimated alignment fits; polling stops at RUN_HOURS or on SIGTERM, and
no publish begins in the last FINISH_HOURS. Storyteller keeps aligning; the
next run picks the book up from the state file. Every step re-derives the
truth from BookOrbit, Storyteller and the disk, and a book's stage is read
from the disk BEFORE anything is downloaded or linked.

Only a Storyteller book this job created -- or provably adopted after a kill:
unprocessed, created within the hour after our request, titled exactly as
our import would be -- is ever processed, cancelled or deleted.

What a person hears (one push per run, only when something happened; code
sends it, never a model; lines are persisted as they happen, so a killed run
loses none and an undelivered push is re-sent): published; refused (a real
grade the gate rejects -- remembered for that exact file pair); blocked (a
file BookOrbit does not list holds a name we need: parked, told after a day
and weekly after that); failed (counted once a night, given up after
ERROR_LIMIT); abandoned (the files changed, a read-along appeared from
elsewhere, the book was deleted or opted out); stuck (Storyteller has held a
book for over STUCK_HOURS). A run that cannot work at all exits 1: the Job
retries once within the same window, then fails and alerts.
"""
import json
import logging
import os
import re
import signal
import socket
import subprocess
import time
from datetime import datetime, timezone

import requests

from app.readalong import gate, patch, smil
from app.readalong.candidates import OPT_OUT_TAG, is_readalong_file, opted_out, pair_key, select
from app.readalong.flag import field_id, sync_flags
from app.readalong.publish import (FilesChanged, PublishConflict, PublishError, local_path, publish, rekey,
                                   targets)
from app.readalong.state import ERROR_LIMIT, State
from app.readalong.storyteller import StorytellerHTTPError

logger = logging.getLogger(__name__)

STUCK_HOURS = 36
QUERY_PAGE = 100
# CPU Storyteller (4 cores, CTC): ~3-5 min per audio-hour, measured on the pilot.
MINUTES_PER_AUDIO_HOUR = 6
EARLY_START_HOURS = 0.25          # a book too long for any night still starts at the top of a run
ERROR_INTERVAL = 6 * 3600         # count at most one failure per book per night (the Job's retry pods)
ADOPT_SLACK = 120                 # seconds of clock skew allowed when adopting an import
ADOPT_WINDOW = 3600               # an import lands within this of its request (the POST copies the m4b first)
CANCEL_WAIT = 120                 # a cancel only signals the alignment to stop: wait before deleting
START_ERRORS_MAX = 3              # books in a row that cannot start: the job is broken, not the books
BLOCKED_TELL_AFTER = 20 * 3600    # a blocker often clears by itself (a scan, BookOrbit's own rename)
RETELL_BLOCKED = 7 * 86400
RELEASE_TELL_AFTER = 3 * 86400    # a Storyteller book we cannot delete, told once after this
PUSH_LINES_MAX = 40


class JobError(Exception):
    """The run cannot do its job at all (exit 1)."""


class BookGone(Exception):
    """BookOrbit answers 404 for the book."""


class StartFailed(Exception):
    """Storyteller certainly did not import the book (nothing to adopt)."""


# --- Storyteller status -----------------------------------------------------------
# beta.38: `readaloud.status` (CREATED / QUEUED / PROCESSING / ALIGNED / ERROR /
# STOPPED) and, while a job exists, `processingJob.status` (QUEUED / RUNNING /
# PAUSED / DONE / ERROR / CANCELED; null once finished or failed).
RUNNING, PAUSED, DONE, FAILED, NOT_STARTED = "running", "paused", "done", "failed", "not-started"


def phase(book):
    """The job's own status wins while a job exists: a PAUSED job shows
    `readaloud.status` STOPPED/PROCESSING and would otherwise be misread."""
    job = book.get("processingJob") if isinstance(book.get("processingJob"), dict) else {}
    ra = book.get("readaloud") if isinstance(book.get("readaloud"), dict) else {}
    js, rs = str(job.get("status") or "").upper(), str(ra.get("status") or "").upper()
    if js == "PAUSED":
        return PAUSED
    if js in ("QUEUED", "RUNNING"):
        return RUNNING
    if js in ("", "DONE"):
        if rs == "ALIGNED":
            return DONE
        if rs in ("QUEUED", "PROCESSING"):
            return RUNNING
        if rs == "CREATED" and not js:
            return NOT_STARTED                # imported, never processed (a run died in between)
    return FAILED                     # ERROR, STOPPED, CANCELED, or anything unknown: never a refusal


def st_created(book):
    """Storyteller writes `2026-09-22 07:53:21`: UTC, with no zone marker."""
    try:
        dt = datetime.fromisoformat(str(book.get("createdAt")).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def import_never_happened(e):
    """True when Storyteller certainly did not import: it answered 4xx, or the
    request never reached it. A timeout, a reset or a 5xx may have imported."""
    if isinstance(e, StorytellerHTTPError):
        return 400 <= e.status < 500
    reason = getattr(e, "reason", e)          # urllib wraps socket errors in URLError.reason
    return isinstance(reason, (ConnectionRefusedError, socket.gaierror))


# --- BookOrbit adapter (the librarian's allowlisted client/writer) ------------------

_DETAIL_404 = re.compile(r"GET /books/\d+ -> HTTP 404:")


class Bookorbit:
    def __init__(self, client, writer, *, scan_timeout=900):
        self.client, self.writer, self.scan_timeout = client, writer, scan_timeout

    def books(self):
        out, page = [], 0
        while True:
            r = self.client.post("/books/query", {"pagination": {"page": page, "size": QUERY_PAGE}})
            items, total = r.get("items") or [], r.get("total")
            out.extend(items)
            if not items or (isinstance(total, int) and len(out) >= total):
                if not isinstance(total, int) or len(out) != total:
                    raise JobError(f"book listing incomplete: {len(out)} of {total}")
                return out
            page += 1

    def detail(self, book_id):
        try:
            return self.client.get(f"/books/{book_id}")
        except RuntimeError as e:        # the client's message starts with "GET <path> -> HTTP <status>:"
            if _DETAIL_404.match(str(e)):
                raise BookGone(book_id) from None
            raise

    def scan_running(self, library_id):
        return self.writer.scan_running(library_id)

    def scan(self, library_id):
        after = self.writer.scan(library_id, timeout=self.scan_timeout)
        self.writer.wait_scan(library_id, after, timeout=self.scan_timeout)

    def set_flag(self, book_id, fid, value):
        self.writer.patch_metadata(book_id, {"customMetadata": [{"fieldId": fid, "value": value}]}, [])


def m4b_seconds(path, run=subprocess.run):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
              capture_output=True, text=True, timeout=300, check=True).stdout.strip()
    return float(out)


def send_push(url, title, body, *, post=requests.post, sleep=time.sleep):
    """Apprise answers 204 for an unknown key: only 200 counts as delivered."""
    last = None
    for attempt in range(3):
        try:
            r = post(url, json={"title": title, "body": body, "type": "info"}, timeout=30)
            if r.status_code == 200:
                return True
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        sleep(5 * (attempt + 1))
    logger.error("push failed after 3 attempts: %s", last)
    return False


# --- the run -------------------------------------------------------------------------

class Job:
    def __init__(self, settings, *, bo, st, push=send_push, clock=time.time, sleep=time.sleep,
                 monotonic=time.monotonic, duration=m4b_seconds):
        self.s, self.bo, self.st, self._push = settings, bo, st, push
        self.clock, self.sleep, self.monotonic, self.duration = clock, sleep, monotonic, duration
        self.stopping = False
        self.handled = set()
        self.state = State.load(os.path.join(settings.state_dir, "readalong.json"))
        self.t0 = clock()
        run = self.state.run or {}
        # a retry pod of the same Job continues its window; any other run opens its own
        self.resumed_window = (bool(settings.job_name) and not settings.dry_run
                               and run.get("job") == settings.job_name
                               and isinstance(run.get("started"), (int, float)))
        if self.resumed_window:
            self.t0 = run["started"]

    def on_sigterm(self, *_):
        logger.warning("SIGTERM: stopping at the next safe point")
        self.stopping = True

    # time ----------------------------------------------------------------------
    def elapsed_hours(self):
        return (self.clock() - self.t0) / 3600

    def must_stop(self):
        return self.stopping or self.elapsed_hours() >= self.s.run_hours

    def late(self):
        """No publish begins now: it could outlast the run and be killed half-way."""
        return self.stopping or self.elapsed_hours() > self.s.run_hours - self.s.finish_hours

    def fits(self, seconds):
        """Start a book only if its estimated alignment ends inside this run --
        except at the very top of a run, so a book too long for any one night
        still gets its turn (it finishes after the run; the next run resumes)."""
        if self.stopping or self.elapsed_hours() >= self.s.start_hours:
            return False
        estimate = (seconds / 3600) * MINUTES_PER_AUDIO_HOUR / 60 + 10 / 60
        return self.elapsed_hours() < EARLY_START_HOURS or self.elapsed_hours() + estimate <= self.s.run_hours

    # Storyteller calls -------------------------------------------------------------------
    def _st(self, fn, *a):
        """One retry after re-authenticating on a 401 -- a request refused for
        its token was never executed, so even create_book is safe to repeat."""
        try:
            return fn(*a)
        except StorytellerHTTPError as e:
            if e.status != 401:
                raise
            self.st.relogin()
            return fn(*a)

    def _st_book(self, uuid):
        """None when Storyteller answers 404: the book is gone."""
        try:
            return self._st(self.st.book, uuid)
        except StorytellerHTTPError as e:
            if e.status == 404:
                return None
            raise

    def _free(self, uuid):
        """Cancel, wait for the alignment to stop (a cancel only signals it),
        delete. 404s are fine: already gone."""
        self._st(self.st.cancel_processing, uuid)
        deadline = self.monotonic() + CANCEL_WAIT
        while True:
            b = self._st_book(uuid)
            if b is None:
                return
            if phase(b) not in (RUNNING, PAUSED) or self.monotonic() >= deadline:
                break
            self.sleep(5)
        self._st(self.st.delete_book, uuid)

    # bookkeeping -----------------------------------------------------------------------
    def _save(self):
        self.state.save()

    def _tell(self, line, outcome=None, save=True):
        """Queue a line for this run's push -- persisted at once, so a run
        killed later still tells it, and an undelivered push goes next run."""
        p = self.state.pending_push
        if not (isinstance(p, dict) and isinstance(p.get("lines"), list)):
            p = {"lines": [], "published": 0, "refused": 0}
        p["lines"].append(line)
        if outcome in ("published", "refused"):
            p[outcome] = p.get(outcome, 0) + 1
        self.state.pending_push = p
        if save:
            self._save()

    def _title(self, fl, detail=None):
        return (detail or {}).get("title") or fl.get("title") or f"book {fl['book']}"

    def _staged(self, fl):
        return fl.get("staged") or os.path.join(self.s.staging_dir, f"{fl['book']}-{fl['uuid']}.epub")

    def _drop_staged(self, fl):
        """Our staging names only: a staged read-along already linked into the
        library keeps its library name."""
        if not fl.get("uuid") and not fl.get("staged"):
            return
        base = self._staged(fl)
        for p in (base, base + ".part", base + ".patched"):
            try:
                if os.path.lexists(p):
                    os.unlink(p)
            except OSError as e:
                logger.warning("could not remove %s: %s", p, e)

    def _release(self, fl):
        """Free our Storyteller book. Best effort: publishing never waits on it;
        a failure parks the uuid in state.to_release, retried every run."""
        uuid = fl.get("uuid")
        if not uuid or fl.get("st_released"):
            return
        try:
            self._free(uuid)
        except Exception as e:
            logger.warning("could not free Storyteller book %s: %s; retried next run", uuid, e)
            self.state.to_release.setdefault(uuid, {"book": fl["book"], "since": self.clock()})
        fl["st_released"] = True
        self._save()

    def _free_parked(self):
        for uuid in list(self.state.to_release):
            info = self.state.to_release[uuid]
            try:
                self._free(uuid)
            except Exception as e:
                logger.warning("still cannot free Storyteller book %s: %s", uuid, e)
                if self.clock() - info.get("since", 0) > RELEASE_TELL_AFTER and not info.get("told"):
                    info["told"] = True
                    self._tell(f"🧹 Storyteller book {uuid} (book {info.get('book')}) cannot be deleted "
                               f"({str(e)[:100]}); delete it in Storyteller")
                continue
            del self.state.to_release[uuid]
            self._save()

    def _close(self, fl, outcome, detail, line=None):
        """Finish with a book, telling `line`. Marked first (with its line), so
        a run killed half-way through is completed -- and told -- by the next.
        Never raises for Storyteller or the staging dir."""
        self.handled.add(fl["book"])
        if fl.get("closing") != outcome:
            fl["closing"], fl["closing_line"] = outcome, line
            self._save()
        self._release(fl)
        self._drop_staged(fl)
        self.state.record(outcome, fl["book"], detail, now=self.clock())
        if self.state.in_flight is fl:
            self.state.in_flight = None
        self.state.blocked.pop(str(fl["book"]), None)
        if line:
            self._tell(line, outcome, save=False)
        self._save()                            # closed and told in one write

    def _fail(self, fl, why, d=None):
        """One counted failure per book per night; given up at ERROR_LIMIT."""
        self.handled.add(fl["book"])
        n = self.state.add_error(fl["book"], fl["pair"], why, now=self.clock(), min_interval=ERROR_INTERVAL)
        if n >= ERROR_LIMIT:
            self._close(fl, "gave-up", {"uuid": fl.get("uuid"), "why": why},
                        f"⚠️ {self._title(fl, d)} — gave up after {n} tries: {why[:120]}")
        else:
            self._tell(f"⚠️ {self._title(fl, d)} — failed ({why[:120]}); retrying next run")

    def _guard(self, fl, step):
        """One book's step. A deleted book is closed; any other unexpected
        error counts against that book and never stops the run."""
        try:
            step(fl)
        except BookGone:
            self._close(fl, "abandoned", {"uuid": fl.get("uuid"), "why": "book deleted"},
                        f"🗑️ {self._title(fl)} — deleted from BookOrbit; its alignment is dropped")
        except Exception as e:
            logger.exception("book %s", fl["book"])
            self._fail(fl, f"{type(e).__name__}: {e}")

    # where a book stands ---------------------------------------------------------------
    def _stage(self, fl, d):
        """linked (our read-along is in the library), foreign (a read-along we
        did not make), changed (not the aligned pair any more), or pending."""
        staged = self._staged(fl)
        try:
            if os.lstat(staged).st_nlink > 1:
                return "linked"
        except FileNotFoundError:
            pass
        files = d.get("files") or []
        ra = [f for f in files if is_readalong_file(f)]
        if ra:
            ours = (len(ra) == 1 and ra[0].get("filename") == targets(d)["clean"]
                    and int(ra[0].get("sizeBytes") or -1) == fl.get("staged_bytes"))
            return "linked" if ours else "foreign"
        pk = pair_key(files)
        if pk is None or (pk != tuple(fl["pair"]) and rekey(d, fl["pair"], targets(d)) is None):
            return "changed"
        return "pending"

    def _moot(self, fl, d, stage):
        """Close a book whose alignment no longer applies. True when closed."""
        if stage == "foreign":
            why, told = "a read-along appeared from elsewhere", "a read-along appeared from elsewhere; mine is dropped"
        elif stage == "changed":
            why, told = "files changed", "its files changed during alignment; it will be looked at again"
        elif opted_out(d):
            why, told = "opted out", f"tagged {OPT_OUT_TAG}; its alignment is dropped"
        else:
            return False
        self._close(fl, "abandoned", {"uuid": fl.get("uuid"), "why": why}, f"↩️ {self._title(fl, d)} — {told}")
        return True

    # a tracked book (in flight, or blocked) ----------------------------------------------
    def advance(self, fl):
        """Move one tracked book as far as it goes in this run. An in-flight
        book may stay in flight: still aligning, failed and kept, done too late
        in the run to publish, or an import that may still be landing."""
        if fl.get("closing"):
            self._close(fl, fl["closing"], {"uuid": fl.get("uuid"), "resumed": True}, fl.get("closing_line"))
            return
        if not fl.get("uuid"):
            return self._adopt(fl)
        d = self.bo.detail(fl["book"])
        stage = self._stage(fl, d)
        if stage != "linked" and self._moot(fl, d, stage):
            return
        if stage == "linked" or fl.get("gated"):
            return self.finish(fl)             # gated: the staged copy is all it needs
        resumed = False
        while True:
            b = self._st_book(fl["uuid"])
            if b is None:
                fl["st_released"] = True        # deleted by someone: nothing left to free
                self._close(fl, "abandoned", {"uuid": fl["uuid"], "why": "Storyteller book deleted"},
                            f"↩️ {self._title(fl, d)} — its Storyteller book was deleted; "
                            f"it will be looked at again")
                return
            p = phase(b)
            if p == DONE:
                return self.finish(fl)
            if p == FAILED:
                self._fail(fl, "Storyteller could not align it", d)
                if self.state.in_flight is fl:  # not given up: Storyteller tries again, polled next run
                    try:
                        self._st(self.st.process, fl["uuid"])
                    except Exception as e:      # already told; the next run finds it failed again
                        logger.warning("re-processing %s: %s", fl["uuid"], e)
                return
            if p in (PAUSED, NOT_STARTED) and not resumed:
                self._st(self.st.process, fl["uuid"])
                resumed = True
            if self.must_stop():
                hours = (self.clock() - fl["started"]) / 3600
                if hours > STUCK_HOURS and not fl.get("stuck_told"):
                    fl["stuck_told"] = True
                    self._tell(f"⏳ {self._title(fl, d)} — still aligning after {hours:.0f} h")
                return
            self.sleep(self.s.poll_seconds)

    def _adopt(self, fl):
        """A run died between recording the import and learning its uuid. Adopt
        only a Storyteller book absent from the snapshot taken just before the
        import, never processed, created within ADOPT_WINDOW of the request,
        and titled exactly as our import (the EPUB's file name). Until the
        window has passed the import may still be landing: wait, never import
        again. Anything else is left alone -- it may be someone else's."""
        known = set(fl.get("known_uuids") or [])
        lo, hi = fl["started"] - ADOPT_SLACK, fl["started"] + ADOPT_WINDOW
        new = [b for b in self._st(self.st.books) or []
               if b.get("uuid") and b["uuid"] not in known and lo <= (st_created(b) or 0) <= hi]
        mine = [b for b in new if phase(b) == NOT_STARTED and b.get("title") == fl.get("st_title")]
        if len(mine) == 1:
            fl["uuid"] = mine[0]["uuid"]
            fl["staged"] = os.path.join(self.s.staging_dir, f"{fl['book']}-{fl['uuid']}.epub")
            self._save()
            logger.info("adopted Storyteller book %s for book %s", fl["uuid"], fl["book"])
            return self.advance(fl)
        if not mine and self.clock() < hi:
            logger.info("book %s: its import may still be landing; looking again next run", fl["book"])
            return
        self.state.in_flight = None
        if new:
            self._tell(f"⚠️ {self._title(fl)} — none of the Storyteller books made around its import "
                       f"({', '.join(str(b.get('title')) for b in new)[:120]}) is certainly its own; all are "
                       f"left alone and the book will be started again", save=False)
        self._save()

    def finish(self, fl):
        """Gate, release Storyteller, publish, verify, flag. Re-reads the book
        first: its files may have changed during hours of alignment."""
        if self.late():
            return
        d = self.bo.detail(fl["book"])
        stage = self._stage(fl, d)
        if stage != "linked" and self._moot(fl, d, stage):
            return
        try:
            if stage != "linked" and not fl.get("gated"):
                verdict, summary = self._gate(fl)
                if summary.grade is None:
                    self._fail(fl, "Storyteller gave no alignment report", d)
                    return
                if not verdict.passed:
                    self.state.refuse(fl["book"], fl["pair"], summary.grade, verdict.reasons, now=self.clock())
                    self._save()                # recorded before anything is deleted
                    self._close(fl, "refused", {"uuid": fl["uuid"], "grade": summary.grade,
                                                "reasons": verdict.reasons},
                                f"❌ {self._title(fl, d)} — refused: grade {summary.grade}; "
                                f"{verdict.reasons[0][:100]}. Retried only if a file changes")
                    return
                fl["gated"] = True              # passed and staged, fsync'ed: kept whatever happens next
                self._save()
            self._release(fl)                   # best effort: the staged copy is all the publish needs
            staged = self._staged(fl)
            if stage != "linked" and not os.path.exists(staged):
                self._close(fl, "abandoned", {"uuid": fl["uuid"], "why": "staged read-along lost"},
                            f"↩️ {self._title(fl, d)} — its staged read-along is gone; it will be aligned again")
                return
            done, pair = publish(self.bo, fl["book"], staged, fl["pair"], media_books=self.s.media_books,
                                 books_prefix=self.s.books_prefix, staging_dir=self.s.staging_dir,
                                 sleep=self.sleep, clock=self.monotonic)
        except FilesChanged as e:
            self._close(fl, "abandoned", {"uuid": fl.get("uuid"), "why": str(e)},
                        f"↩️ {self._title(fl, d)} — {e}; it will be looked at again")
            return
        except PublishConflict as e:
            self._block(fl, e.path)
            return
        except PublishError as e:
            self._fail(fl, str(e), d)
            return
        fl["pair"] = list(pair)
        ra = next(f for f in done["files"] if is_readalong_file(f))
        try:
            self.bo.set_flag(fl["book"], self._fid, True)
        except Exception as e:                  # published all the same; the next run's flag sync repairs it
            logger.warning("Read-Along flag on book %s: %s", fl["book"], e)
        self.state.clear_error(fl["book"])
        grade = fl.get("grade") or "?"
        self._close(fl, "published", {"uuid": fl["uuid"], "grade": grade, "file": ra["id"]},
                    f"📖🎧 {self._title(fl, d)} — read-along published (grade {grade})")

    def _block(self, fl, path):
        """Park a gated, staged read-along whose name is taken. It holds no
        Storyteller book, so the queue moves on; every run retries it. Told
        only about a file BookOrbit does not list for the book, once it has
        held for a day, and weekly after that."""
        self.handled.add(fl["book"])
        now = self.clock()
        fl.setdefault("blocked_since", now)
        if self.state.in_flight is fl:
            self.state.in_flight = None
        self.state.blocked[str(fl["book"])] = fl
        self._save()
        d = self.bo.detail(fl["book"])
        name = os.path.basename(path)
        if any((f.get("filename") or "").casefold() == name.casefold() for f in d.get("files") or []):
            return                              # the book's own file, mid-rename: just retry
        if now - fl["blocked_since"] < BLOCKED_TELL_AFTER:
            return
        if fl.get("blocked_told") == path and now - fl.get("blocked_told_at", 0) < RETELL_BLOCKED:
            return
        fl["blocked_told"], fl["blocked_told_at"] = path, now
        self._tell(f"🚧 {self._title(fl, d)} — read-along ready, but {path} is in the way (BookOrbit does "
                   f"not list it for this book). Check it and move it out of the folder; the next run publishes")

    def _gate(self, fl):
        """Download (unless a previous run already did) to a fresh .part, patch,
        then move it into place in our staging dir -- an existing staged name is
        never opened for writing (it may be linked into the library)."""
        staged = self._staged(fl)
        os.makedirs(self.s.staging_dir, exist_ok=True)
        view = self._st(self.st.alignment_report, fl["uuid"])
        summary = gate.summarize_report(view)
        if summary.grade is None:
            return None, summary
        have = os.path.getsize(staged) if os.path.exists(staged) else None
        if have is None or have != fl.get("staged_bytes"):
            if have is not None:
                os.unlink(staged)               # our partial or unknown copy, one link only
            part = staged + ".part"
            if os.path.lexists(part):
                os.unlink(part)
            self._st(self.st.download_readaloud, fl["uuid"], part)
            if smil.inspect_epub(part).zero_length_clips > 0:
                n = patch.patch_zero_length_clips(part, staged + ".patched")
                os.unlink(part)
                part = staged + ".patched"
                logger.info("patched %d zero-length clips for book %s", n, fl["book"])
            os.rename(part, staged)             # staged is absent here: rename cannot replace anything
            fl["staged"] = staged
            fl["staged_bytes"] = os.path.getsize(staged)
            self._save()
        verdict = gate.decide(summary, smil.inspect_epub(staged), fl["m4b_seconds"])
        fl["grade"] = summary.grade
        self._save()
        return verdict, summary

    # starting a book ---------------------------------------------------------------
    def start(self, rec):
        """True when a book was imported. An exception after the import was
        requested leaves `in_flight` set (uuid or None): the caller stops, and
        the next run adopts or resumes it -- never a second import. When
        Storyteller certainly did not import, raises StartFailed instead."""
        if rec["id"] in self.handled or str(rec["id"]) in self.state.blocked:
            return False
        try:
            d = self.bo.detail(rec["id"])
        except BookGone:
            return False
        if d.get("libraryId") not in self.s.libraries or opted_out(d):
            return False
        pair = pair_key(d.get("files") or [])
        # re-checked here: the candidate list is from the start of the run
        if pair is None or self.state.is_refused(d["id"], pair) or self.state.gave_up(d["id"], pair, self.clock()):
            return False
        plain = next(f for f in d["files"] if f["id"] == pair[0])
        m4b = next(f for f in d["files"] if f["id"] == pair[2])
        folder = d["folderPath"].rstrip("/")
        seconds = self.duration(os.path.join(local_path(self.s.media_books, self.s.books_prefix, folder),
                                             m4b["filename"]))
        if not self.fits(seconds):
            logger.info("book %s (%.1f h of audio) does not fit this run", d["id"], seconds / 3600)
            return False

        def st_path(f):
            return self.s.storyteller_library + folder[len(self.s.books_prefix):] + "/" + f["filename"]
        known = sorted(b["uuid"] for b in self._st(self.st.books) or [] if b.get("uuid"))
        # recorded BEFORE the import: a run killed right after it can find its book again
        self.state.in_flight = {"book": d["id"], "title": d.get("title"), "uuid": None, "pair": list(pair),
                                "started": self.clock(), "m4b_seconds": seconds, "known_uuids": known,
                                "st_title": os.path.splitext(plain["filename"])[0]}
        self._save()
        try:
            uuid = self._st(self.st.create_book, st_path(plain), st_path(m4b))
        except Exception as e:
            if import_never_happened(e):
                self.state.in_flight = None
                self._save()
                raise StartFailed(f"Storyteller did not import it: {e}") from e
            raise
        self.state.in_flight.update(uuid=uuid, staged=os.path.join(self.s.staging_dir, f"{d['id']}-{uuid}.epub"))
        self._save()
        self._st(self.st.process, uuid)
        logger.info("started book %s (%s) as Storyteller %s", d["id"], d.get("title"), uuid)
        return True

    def _start_failed(self, rec, e):
        """A start error charged to the book: counted once a night, given up at ERROR_LIMIT."""
        self.handled.add(rec["id"])
        pair = pair_key(rec.get("files") or [])
        why = f"start: {type(e).__name__}: {e}"
        n = 0
        if pair is not None:
            n = self.state.add_error(rec["id"], pair, why, now=self.clock(), min_interval=ERROR_INTERVAL)
        if n >= ERROR_LIMIT:
            self.state.record("gave-up", rec["id"], {"why": why}, now=self.clock())
            self._tell(f"⚠️ {rec.get('title')} — gave up after {n} tries to start it: {str(e)[:120]}")
        else:
            self._tell(f"⚠️ {rec.get('title')} — could not start ({str(e)[:120]}); retrying next run")

    def storyteller_busy(self):
        """Another client's book in flight. Told once after STUCK_HOURS."""
        ours = (self.state.in_flight or {}).get("uuid")
        busy = [b for b in self._st(self.st.books) or []
                if b.get("uuid") != ours and phase(b) in (RUNNING, PAUSED)]
        if not busy:
            if self.state.foreign_busy_since is not None:
                self.state.foreign_busy_since, self.state.foreign_told = None, False
                self._save()
            return None
        if self.state.foreign_busy_since is None:
            self.state.foreign_busy_since = self.clock()
        hours = (self.clock() - self.state.foreign_busy_since) / 3600
        if hours > STUCK_HOURS and not self.state.foreign_told:
            self.state.foreign_told = True
            self._tell(f"⏳ Storyteller has been busy with {busy[0].get('title') or busy[0].get('uuid')} "
                       f"(not mine) for over {STUCK_HOURS} h; no read-alongs meanwhile", save=False)
        self._save()
        return busy[0].get("title") or busy[0].get("uuid")

    # the whole run --------------------------------------------------------------------
    def run(self):
        books = self.bo.books()
        if not books:
            raise JobError("BookOrbit listed no books")
        epubs = [f for b in books for f in b.get("files") or [] if (f.get("format") or "").lower() == "epub"]
        if epubs and not any("mediaOverlay" in f for f in epubs):
            raise JobError("the book listing no longer carries files[].mediaOverlay; refusing to judge flags")
        self._fid = field_id(self.bo.client)
        # selection uses the listing from BEFORE the flag sync (a flag PATCH bumps updatedAt)
        chosen, funnel = select(books, self.state, self.clock(), quiet_hours=self.s.quiet_hours,
                                only=self.s.only)
        changed, failed = sync_flags(self.bo, books, self._fid, libraries=self.s.libraries,
                                     dry_run=self.s.dry_run)
        logger.info("Read-Along flags: %d set, %d failed", changed, failed)
        logger.info("candidates: %s; blocked: %s", json.dumps(funnel, sort_keys=True), sorted(self.state.blocked))
        self.st.login(self.s.storyteller_user, self.s.storyteller_pass)
        if self.s.dry_run:
            st_books = self._st(self.st.books) or []
            logger.info("Storyteller: %d books: %s", len(st_books),
                        json.dumps([[b.get("title"), phase(b), b.get("createdAt")] for b in st_books]))
            for b in chosen[: self.s.max_books]:
                logger.info("would align book %s (%s)", b["id"], b.get("title"))
            if self.state.in_flight:
                logger.info("in flight: %s", self.state.in_flight)
            return 0
        if not self.resumed_window:
            self.state.run = {"job": self.s.job_name, "started": self.t0}
        self._save()
        try:
            self._free_parked()
            for key in list(self.state.blocked):
                fl = self.state.blocked.get(key)
                if fl and not self.late():
                    self._guard(fl, self.advance)
            if self.state.in_flight:
                self._guard(self.state.in_flight, self.advance)
                if self.state.in_flight:         # still aligning, failed and kept, too late, or landing
                    return self.report()
            started = 0
            fails = []                           # tonight's start errors, charged once another book starts
            queue = [b for b in chosen if b["id"] != (self.state.in_flight or {}).get("book")]
            while queue and started < self.s.max_books and not self.stopping \
                    and self.elapsed_hours() < self.s.start_hours:
                busy = self.storyteller_busy()
                if busy:
                    logger.info("Storyteller is busy with %s; not starting a book", busy)
                    break
                rec = queue.pop(0)
                try:
                    if not self.start(rec):
                        continue
                except Exception as e:
                    fl = self.state.in_flight
                    if fl and fl["book"] == rec["id"]:
                        # the import may exist: kept (uuid or None) so the next run resumes or adopts it
                        logger.exception("start of book %s failed after its import was requested", rec["id"])
                        self._fail(fl, f"start: {type(e).__name__}: {e}")
                        break
                    logger.exception("start of book %s failed", rec["id"])
                    self.handled.add(rec["id"])
                    fails.append((rec, e))
                    if len(fails) >= START_ERRORS_MAX:
                        self._tell(f"⚠️ {len(fails)} books in a row could not start ({type(e).__name__}: "
                                   f"{str(e)[:100]}) -- the job's problem, not the books': nothing counted, "
                                   f"no more starts tonight")
                        fails = []
                        break
                    continue
                for f in fails:                  # another book started: those errors were the books' own
                    self._start_failed(*f)
                fails = []
                started += 1
                self._guard(self.state.in_flight, self.advance)
                if self.state.in_flight:         # one book at a time: never orphan the kept one
                    break
            for f in fails:                      # nothing to compare with: charged to the book
                self._start_failed(*f)
        except Exception as e:                   # not one book's failure (Storyteller or BookOrbit down)
            logger.exception("read-along run failed")
            if not self.state.run.get("failure_told"):
                self.state.run["failure_told"] = True
                self._tell(f"⚠️ run failed: {type(e).__name__}: {str(e)[:150]}")
            self.report()
            return 1
        return self.report()

    def report(self):
        p = self.state.pending_push
        lines = (p or {}).get("lines") if isinstance(p, dict) else None
        if not lines:
            logger.info("nothing to report")
            return 0
        title = f"Read-along: {p.get('published', 0)} published · {p.get('refused', 0)} refused"
        if len(lines) > PUSH_LINES_MAX:
            lines = lines[:PUSH_LINES_MAX] + [f"… and {len(lines) - PUSH_LINES_MAX} more (see the job's log)"]
        body = "\n".join(lines)
        logger.info("%s\n%s", title, body)
        if self._push(self.s.apprise_url, title, body):
            self.state.pending_push = None
            self._save()
            return 0
        return 1                                 # kept: the next run sends it


def install_sigterm(job):
    signal.signal(signal.SIGTERM, job.on_sigterm)
