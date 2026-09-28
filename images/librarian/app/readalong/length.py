"""Keep an audiobook's stored length filled from its measured audio file.

BookOrbit sums a book's length (metadata.service aggregateAudioDuration, 3.0.0 and
3.1.0) only while the field is unlocked AND the book's PRIMARY file is audio. An m4b
added to a book whose primary is an EPUB -- every audiobook the librarian attaches
to an existing ebook, and every read-along book -- never gets one: 11 books showed
no length on 2026-09-27 (and a stored 0 pinned 3.0.0's listening progress at 0 %).
BookOrbit's scan has measured the file by then, so its duration is the value
BookOrbit would itself have stored. The worker's nightly run fills it; a tick never
does (an ask waits whenever Storyteller is busy, so no tick is a reliable moment).
The audit (books repo, audio_duration_*) allows it a day and reports what is left."""
import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# BookOrbit's AUDIO_FORMAT_LIST (@bookorbit/types src/book.ts): the formats it measures
AUDIO_FORMATS = ("m4b", "mp3", "m4a", "opus", "ogg", "flac")
# BookOrbit stores whole seconds; a minute absorbs a hand-entered value
SLACK_S = 60
# A book with a file this new may still be mid-filing -- the executor writing its lock
# set (lockedFields replaces the whole set) -- so the sweep leaves it to the next night.
RECENT_S = 3600
# BookOrbit slow or failing: the sweep yields the night to the alignments
SWEEP_BUDGET_S = 300
SWEEP_FAILURES_MAX = 3


def _audio(files):
    return [f for f in files or [] if (f.get("format") or "").lower() in AUDIO_FORMATS
            and f.get("role") in ("primary", "content")]


def _seconds(value):
    return value if type(value) is int and value > 0 else None


def target_length(detail, libraries):
    """The length `detail` (GET /books/{id}) should store, or None: nothing to do,
    or no value that is certain. Only a book with exactly ONE audio file, measured,
    has one: several files (parts, a duplicate m4b, a set caught mid-copy, two
    editions) could add up to a wrong length, so they are left for a human."""
    if detail.get("libraryId") not in libraries:
        return None
    files = _audio(detail.get("files"))
    secs = _seconds(files[0].get("durationSeconds")) if len(files) == 1 else None
    if secs is None:
        return None
    stored = _seconds((detail.get("audioMetadata") or {}).get("durationSeconds"))
    return None if stored is not None and abs(stored - secs) <= SLACK_S else secs


def fill_length(bo, detail, *, libraries, dry_run):
    """Store `detail`'s length if it needs one; True when it did (or would)."""
    target = target_length(detail, libraries)
    if target is None:
        return False
    stored = (detail.get("audioMetadata") or {}).get("durationSeconds")
    if dry_run:
        logger.info("would set the length of book %s: %r -> %d s", detail.get("id"), stored, target)
    else:
        bo.set_length(detail["id"], target)
        logger.info("set the length of book %s: %r -> %d s", detail.get("id"), stored, target)
    return True


def _newest_file_age(detail, now):
    """Seconds since the book's newest file of ANY format arrived (an EPUB attached to
    an audiobook is a filing too). An unreadable date counts as brand new: the sweep
    then skips the book, and the audit shows a length never filled -- a lost lock
    would show nowhere."""
    ages = []
    for f in detail.get("files") or []:
        try:
            ts = datetime.fromisoformat(str(f.get("createdAt")).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            ages.append(now - ts.timestamp())
        except (ValueError, OverflowError, OSError):
            return 0.0
    return min(ages, default=0.0)


def fill_lengths(bo, books, *, libraries, dry_run, now=None, monotonic=time.monotonic,
                 stopping=lambda: False):
    """The nightly sweep over /books/query records -> (changed, failed). A record
    carries no durations and no library, so only a book holding an audio file costs
    a detail read (~290 of them, ~10 s). Bounded, as a slow BookOrbit must not eat
    the night: it stops after SWEEP_FAILURES_MAX failures in a row, after
    SWEEP_BUDGET_S, and on SIGTERM -- well inside the heartbeat's hour (metrics.py),
    so it needs no beat of its own. A book deleted since the listing is skipped;
    whatever is left, the next night tries again."""
    from app.readalong.job import BookGone      # job imports this module

    now = time.time() if now is None else now
    start = monotonic()
    changed = failed = in_a_row = 0
    for b in books:
        if not _audio(b.get("files")):
            continue
        if stopping() or monotonic() - start >= SWEEP_BUDGET_S:
            logger.warning("audiobook lengths: sweep stopped early (SIGTERM or its time budget); "
                           "the next night goes on")
            break
        try:
            d = bo.detail(b["id"])
            if _newest_file_age(d, now) < RECENT_S:
                continue
            if fill_length(bo, d, libraries=libraries, dry_run=dry_run):
                changed += 1
            in_a_row = 0
        except BookGone:
            continue
        except Exception as e:
            failed += 1
            in_a_row += 1
            logger.warning("length of book %s: %s", b["id"], e)
            if in_a_row >= SWEEP_FAILURES_MAX:
                logger.warning("audiobook lengths: %d failures in a row; the next night tries again", in_a_row)
                break
    return changed, failed
