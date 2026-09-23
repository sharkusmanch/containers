"""The nightly read-along run.

One book at a time through Storyteller: import -> align -> download -> gate
-> publish -> verify -> clean up. New books start only in the first
START_HOURS of the run (and only if their estimated alignment fits the run);
polling stops at RUN_HOURS or on SIGTERM and the run exits. Storyteller keeps
aligning, and the next run picks the book up from the state file. Every step
re-derives the truth from BookOrbit, Storyteller and the disk; the stage of a
book is read from the disk BEFORE anything is downloaded or linked.

Outcomes a person hears about (one push per run, only when something
happened; code sends it, never a model): published; refused (only for a real
grade the gate rejects -- remembered for that exact file pair); blocked (a
file that is not the book's holds a name we need: told once, retried every
run until it is gone); failed (retried the next run, given up after
ERROR_LIMIT tries on the same pair); abandoned (the book's files changed under
us); stuck (a book of ours, or someone else's, has held Storyteller for more
than STUCK_HOURS).
"""
import json
import logging
import os
import signal
import subprocess
import time
from datetime import datetime

import requests

from app.readalong import gate, patch, smil
from app.readalong.candidates import ERROR_LIMIT, is_readalong_file, pair_key, select
from app.readalong.flag import field_id, sync_flags
from app.readalong.publish import PublishConflict, PublishError, local_path, publish
from app.readalong.state import State

logger = logging.getLogger(__name__)

STUCK_HOURS = 36
QUERY_PAGE = 100
# CPU Storyteller (4 cores, CTC): ~3-5 min per audio-hour, measured on the pilot.
MINUTES_PER_AUDIO_HOUR = 6
EARLY_START_HOURS = 0.25          # a book too long for any night still starts at the top of a run


class JobError(Exception):
    """The run cannot do its job at all (exit 1)."""


# --- Storyteller status -----------------------------------------------------------
# beta.38: `readaloud.status` (QUEUED / PROCESSING / ALIGNED, the bulk run's
# contract) and, while a job exists, `processingJob.status` (QUEUED / RUNNING /
# PAUSED / DONE / ERROR / CANCELED; null once finished).
RUNNING, PAUSED, DONE, FAILED = "running", "paused", "done", "failed"


def phase(book):
    """The job's own status wins while a job exists: a PAUSED job still shows
    `readaloud.status` PROCESSING and would otherwise be waited on forever."""
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
    return FAILED                     # ERROR, CANCELED, or anything unknown: never a refusal


# --- BookOrbit adapter (the librarian's allowlisted client/writer) ------------------

class Bookorbit:
    def __init__(self, client, writer, *, scan_timeout=1800):
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
        return self.client.get(f"/books/{book_id}")

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


def _st_created(book):
    try:
        return datetime.fromisoformat(str(book.get("createdAt")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --- the run -------------------------------------------------------------------------

class Job:
    def __init__(self, settings, *, bo, st, push=send_push, clock=time.time, sleep=time.sleep,
                 duration=m4b_seconds):
        self.s, self.bo, self.st, self._push = settings, bo, st, push
        self.clock, self.sleep, self.duration = clock, sleep, duration
        self.t0 = clock()
        self.stopping = False
        self.lines, self.published, self.refused = [], 0, 0
        self.handled = set()
        self.state = State.load(os.path.join(settings.state_dir, "readalong.json"))

    def on_sigterm(self, *_):
        logger.warning("SIGTERM: stopping at the next safe point")
        self.stopping = True

    # time ----------------------------------------------------------------------
    def elapsed_hours(self):
        return (self.clock() - self.t0) / 3600

    def must_stop(self):
        return self.stopping or self.elapsed_hours() >= self.s.run_hours

    def fits(self, seconds):
        """Start a book only if its estimated alignment ends inside this run --
        except at the very top of a run, so a book too long for any one night
        still gets its turn (it finishes after the run; the next run resumes)."""
        if self.stopping or self.elapsed_hours() >= self.s.start_hours:
            return False
        estimate = (seconds / 3600) * MINUTES_PER_AUDIO_HOUR / 60 + 10 / 60
        return self.elapsed_hours() < EARLY_START_HOURS or self.elapsed_hours() + estimate <= self.s.run_hours

    # helpers ------------------------------------------------------------------------
    def _save(self):
        self.state.save()

    def _title(self, fl, detail=None):
        return (detail or {}).get("title") or fl.get("title") or f"book {fl['book']}"

    def _staged(self, fl):
        return os.path.join(self.s.staging_dir, f"{fl['book']}-{fl['uuid']}.epub")

    def _drop_staged(self, fl):
        """Our staging names only; a staged read-along already linked into the
        library keeps its library name."""
        for p in (self._staged(fl), self._staged(fl) + ".part", self._staged(fl) + ".patched"):
            if os.path.lexists(p):
                os.unlink(p)

    def _st(self, fn, *a, **k):
        try:
            return fn(*a, **k)
        except RuntimeError as e:
            if "401" not in str(e):
                raise
            self.st.relogin()
            return fn(*a, **k)

    def _close(self, fl, outcome, detail):
        """The Storyteller book is ours (its uuid is in our state): delete it."""
        self.handled.add(fl["book"])
        if fl.get("uuid"):
            self._st(self.st.delete_book, fl["uuid"])
            self._drop_staged(fl)
        self.state.record(outcome, fl["book"], detail, now=self.clock())
        self.state.in_flight = None
        self._save()

    def _fail(self, fl, why, d=None):
        self.handled.add(fl["book"])            # one attempt per book per run
        n = self.state.add_error(fl["book"], fl["pair"], why, now=self.clock())
        if n >= ERROR_LIMIT:
            self._close(fl, "gave-up", why)
            self.lines.append(f"⚠️ {self._title(fl, d)} — gave up after {n} tries: {why[:120]}")
        else:
            self._save()
            self.lines.append(f"⚠️ {self._title(fl, d)} — failed ({why[:120]}); retrying next run")

    def _linked(self, fl, d):
        """True when the staged read-along is already in the library (a run was
        killed after the link): never download or gate it again."""
        staged = self._staged(fl)
        try:
            if os.lstat(staged).st_nlink > 1:
                return True
        except FileNotFoundError:
            pass
        return any(is_readalong_file(f) for f in d.get("files") or [])

    # the in-flight book -------------------------------------------------------------------
    def drive(self):
        """Advance state.in_flight as far as possible. Returns when this run is
        done with it (the book may still be in flight: kept for the next run
        while aligning, after a failure, or while blocked)."""
        fl = self.state.in_flight
        if not fl.get("uuid"):
            return self._adopt(fl)
        try:
            d = self.bo.detail(fl["book"])
        except Exception as e:
            if "404" in str(e):
                self._close(fl, "abandoned", "book deleted")
                self.lines.append(f"🗑️ {self._title(fl)} — book was deleted; alignment dropped")
                return
            raise
        if self._linked(fl, d):
            return self.finish(fl, d)
        if pair_key(d.get("files") or []) != tuple(fl["pair"]):
            self._close(fl, "abandoned", "files changed")
            self.lines.append(f"↩️ {self._title(fl, d)} — files changed during alignment; "
                              f"it will be looked at again")
            return
        resumed = False
        while True:
            p = phase(self._st(self.st.book, fl["uuid"]))
            if p == DONE:
                break
            if p == FAILED:
                self._fail(fl, "Storyteller could not align it", d)
                if self.state.in_flight:        # not given up: have Storyteller try again
                    self._st(self.st.process, fl["uuid"])
                return
            if p == PAUSED and not resumed:
                self._st(self.st.process, fl["uuid"])
                resumed = True
            if self.must_stop():
                hours = (self.clock() - fl["started"]) / 3600
                if hours > STUCK_HOURS and not fl.get("stuck_told"):
                    fl["stuck_told"] = True
                    self._save()
                    self.lines.append(f"⏳ {self._title(fl, d)} — still aligning after {hours:.0f} h")
                return
            self.sleep(self.s.poll_seconds)
        return self.finish(fl, d)

    def _adopt(self, fl):
        """A run died between recording the import and learning its uuid: find
        the Storyteller book it created, or conclude that none was created."""
        known = {h["detail"].get("uuid") for h in self.state.history if isinstance(h.get("detail"), dict)}
        mine = [b for b in self._st(self.st.books) or []
                if (_st_created(b) or 0) >= fl["started"] - 120 and b.get("uuid") not in known]
        if len(mine) == 1:
            fl["uuid"] = mine[0]["uuid"]
            self._save()
            logger.info("adopted Storyteller book %s for book %s", fl["uuid"], fl["book"])
            return self.drive()
        if not mine:
            self.state.in_flight = None
            self._save()
            return
        self.handled.add(fl["book"])
        self.lines.append(f"⚠️ {self._title(fl)} — its import is ambiguous in Storyteller; left for a human")

    def finish(self, fl, d):
        staged = self._staged(fl)
        try:
            if not self._linked(fl, d):
                verdict, summary = self._gate(fl, staged)
                if summary.grade is None:
                    self._fail(fl, "Storyteller gave no alignment report", d)
                    return
                if not verdict.passed:
                    self.state.refuse(fl["book"], fl["pair"], summary.grade, verdict.reasons, now=self.clock())
                    self.refused += 1
                    self._close(fl, "refused", {"uuid": fl["uuid"], "grade": summary.grade,
                                                "reasons": verdict.reasons})
                    self.lines.append(f"❌ {self._title(fl, d)} — refused: grade {summary.grade}; "
                                      f"{verdict.reasons[0][:100]}. Retried only if a file changes")
                    return
            done, pair = publish(self.bo, fl["book"], staged, fl["pair"], media_books=self.s.media_books,
                                 books_prefix=self.s.books_prefix, staging_dir=self.s.staging_dir,
                                 sleep=self.sleep)
        except PublishConflict as e:
            self.handled.add(fl["book"])
            if fl.get("blocked") != e.path:     # tell once per blocker; retried every run
                fl["blocked"] = e.path
                self.lines.append(f"🚧 {self._title(fl, d)} — waiting: {e.path} is in the way "
                                  f"(not one of the book's files); remove or rename it")
            self._save()
            return
        except PublishError as e:
            self._fail(fl, str(e), d)
            return
        fl["pair"] = list(pair)
        ra = next(f for f in done["files"] if is_readalong_file(f))
        self.bo.set_flag(fl["book"], self._fid, True)
        self.state.clear_error(fl["book"])
        grade = fl.get("grade") or "?"
        self._close(fl, "published", {"uuid": fl["uuid"], "grade": grade, "file": ra["id"]})
        self.published += 1
        self.lines.append(f"📖🎧 {self._title(fl, d)} — read-along published (grade {grade})")

    def _gate(self, fl, staged):
        """Download (unless a previous run already did) to a fresh .part, patch,
        then move it into place in our staging dir -- an existing staged name is
        never opened for writing (it may be linked into the library)."""
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
            fl["staged_bytes"] = os.path.getsize(staged)
            self._save()
        verdict = gate.decide(summary, smil.inspect_epub(staged), fl["m4b_seconds"])
        fl["grade"] = summary.grade
        self._save()
        return verdict, summary

    # starting a book ---------------------------------------------------------------
    def start(self, rec):
        if rec["id"] in self.handled:           # finished, refused or failed earlier this run
            return False
        d = self.bo.detail(rec["id"])
        if d.get("libraryId") not in self.s.libraries:
            return False
        pair = pair_key(d.get("files") or [])
        # re-checked here: the candidate list is from the start of the run
        if pair is None or self.state.is_refused(d["id"], pair) \
                or self.state.error_count(d["id"], pair) >= ERROR_LIMIT:
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
        # recorded BEFORE the import: a run killed right after it can find its book again
        self.state.in_flight = {"book": d["id"], "title": d.get("title"), "uuid": None, "pair": list(pair),
                                "started": self.clock(), "m4b_seconds": seconds}
        self._save()
        uuid = self._st(self.st.create_book, st_path(plain), st_path(m4b))
        self.state.in_flight["uuid"] = uuid
        self._save()
        self._st(self.st.process, uuid)
        logger.info("started book %s (%s) as Storyteller %s", d["id"], d.get("title"), uuid)
        return True

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
            self.lines.append(f"⏳ Storyteller has been busy with {busy[0].get('title') or busy[0].get('uuid')} "
                              f"(not mine) for over {STUCK_HOURS} h; no read-alongs meanwhile")
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
        logger.info("candidates: %s", json.dumps(funnel, sort_keys=True))
        self.st.login(self.s.storyteller_user, self.s.storyteller_pass)
        if self.s.dry_run:
            st_books = self._st(self.st.books) or []
            logger.info("Storyteller: %d books, phases %s", len(st_books),
                        json.dumps(sorted(phase(b) for b in st_books)))
            for b in chosen[: self.s.max_books]:
                logger.info("would align book %s (%s)", b["id"], b.get("title"))
            if self.state.in_flight:
                logger.info("in flight: %s", self.state.in_flight)
            return 0
        try:
            if self.state.in_flight:
                self.drive()
                if self.state.in_flight:         # still aligning, blocked, or failed and kept
                    return self.report()
            started = 0
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
                except Exception as e:           # this book could not even start: count it, try the next
                    pair = pair_key(rec.get("files") or [])
                    if self.state.in_flight and not self.state.in_flight.get("uuid"):
                        self.state.in_flight = None     # nothing was created
                    if pair is not None:
                        self.state.add_error(rec["id"], pair, f"start: {e}", now=self.clock())
                    self._save()
                    self.lines.append(f"⚠️ {rec.get('title')} — could not start: {str(e)[:120]}")
                    continue
                started += 1
                self.drive()
                if self.state.in_flight:         # one book at a time: never orphan the kept one
                    break
        except Exception as e:                   # unexpected: keep what we have, report, exit 1
            logger.exception("read-along run failed")
            fl = self.state.in_flight
            if fl and fl.get("pair"):
                self.state.add_error(fl["book"], fl["pair"], f"{type(e).__name__}: {e}", now=self.clock())
                self._save()
            self.lines.append(f"⚠️ run failed: {type(e).__name__}: {str(e)[:150]}")
            self.report()
            return 1
        return self.report()

    def report(self):
        if not self.lines:
            logger.info("nothing to report")
            return 0
        title = f"Read-along: {self.published} published · {self.refused} refused"
        body = "\n".join(self.lines)
        logger.info("%s\n%s", title, body)
        return 0 if self._push(self.s.apprise_url, title, body) else 1


def install_sigterm(job):
    signal.signal(signal.SIGTERM, job.on_sigterm)
