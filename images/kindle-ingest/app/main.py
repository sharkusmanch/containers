"""Orchestrator: the poll loop and one cycle of work.

Cycle order matters. The heartbeat is set first so a wedge anywhere later is
visible; an unreachable device returns cleanly (it is the normal state, not an
error); and cleanup runs last, gated on the full verification conjunction.
"""
import logging
import os
import shutil
import signal
import sys
import time
from dataclasses import dataclass, field

from . import metrics
from .bookorbit import AuthExpired, BookOrbit, Duplicate, Transport, UploadRejected
from .config import Config
from .convert import ConvertFailed, classify, epub_to_cbz, to_epub
from .decrypt import DecryptFailed, decrypt_archive
from .device import Device, DeviceUnreachable, TruncatedPull
from .ledger import (FAILED, Ledger, NEEDS_DECISION, OK, RETRYABLE, UPLOADING)
from .notify import Notifier
from .verify import ArtifactInvalid, archive_intact, sha256_file, verify_artifact

log = logging.getLogger("kindle-ingest")
MAX_ATTEMPTS = 5
_PROBE_GAP = 5.0   # between startup reachability probes


class Stopping(Exception):
    """SIGTERM arrived; abandon the in-flight book cleanly."""


@dataclass
class Ctx:
    cfg: Config
    device: Device
    api: BookOrbit
    ledger: Ledger
    notifier: Notifier
    stop: dict = field(default_factory=lambda: {"now": False})

    @staticmethod
    def build(cfg: Config) -> "Ctx":
        return Ctx(cfg, Device(cfg), BookOrbit(cfg), Ledger(cfg.ledger_path),
                   Notifier(cfg.apprise_url))

    def check_stop(self):
        if self.stop["now"]:
            raise Stopping()


@dataclass
class CycleResult:
    uploaded: int = 0
    failed: int = 0
    needs_decision: int = 0
    skipped: int = 0
    deleted: int = 0
    errors: list = field(default_factory=list)


def _paths(cfg, asin):
    return {
        "enc": os.path.join(cfg.work_dir, f"{asin}.enc.kfx-zip"),
        "archive": os.path.join(cfg.data_dir, "archive", f"{asin}.kfx-zip"),
        "epub": os.path.join(cfg.data_dir, "epub", f"{asin}.epub"),
        "cbz": os.path.join(cfg.data_dir, "cbz", f"{asin}.cbz"),
        "src": os.path.join(cfg.work_dir, asin),
    }


def _cleanup_partials(p):
    for k in ("enc", "src"):
        t = p[k]
        shutil.rmtree(t, ignore_errors=True) if os.path.isdir(t) else (
            os.path.exists(t) and os.unlink(t))
    for k in ("archive", "epub", "cbz"):
        part = p[k] + ".part"
        if os.path.exists(part):
            os.unlink(part)


def reconcile_startup(ctx: Ctx) -> int:
    """Resolve intents left by a crash between the POST and the ledger write.

    This is the case an interrupted upload actually produces -- node drain,
    image bump, OOM -- and without it the next cycle re-uploads and creates a
    duplicate that only a destructive library delete can undo.
    """
    n = 0
    for rec in ctx.ledger.by_outcome(UPLOADING):
        asin = rec["asin"]
        try:
            found = ctx.api.find_by_asin(asin)
        except (AuthExpired, Transport) as e:
            log.warning("reconcile %s deferred: %s", asin, e)
            continue
        if found:
            ctx.ledger.record(asin, OK, bookorbit_id=found.get("id"),
                              detail="reconciled after interrupted upload")
        else:
            ctx.ledger.record(asin, RETRYABLE, detail="upload intent did not land")
        n += 1
    if n:
        log.info("reconciled %d interrupted upload(s)", n)
    return n


def _process(ctx: Ctx, book, keyfile: str, res: CycleResult) -> None:
    cfg, asin = ctx.cfg, book.asin
    p = _paths(cfg, asin)
    prev = ctx.ledger.get(asin) or {}
    attempts = int(prev.get("attempts", 0)) + 1
    if attempts > MAX_ATTEMPTS:
        ctx.ledger.record(asin, FAILED, attempts=attempts,
                          error=f"gave up after {MAX_ATTEMPTS} attempts")
        res.failed += 1
        return

    for d in ("archive", "epub", "cbz"):
        os.makedirs(os.path.dirname(p[d]), exist_ok=True)
    os.makedirs(cfg.work_dir, exist_ok=True)

    try:
        ctx.check_stop()
        # --- pull + decrypt ------------------------------------------------
        with metrics.STAGE.labels(stage="pull").time():
            ctx.device.fetch_book(book, p["src"])
            enc = ctx.device.build_archive(p["src"], p["enc"])
        ctx.check_stop()
        with metrics.STAGE.labels(stage="decrypt").time():
            decrypt_archive(enc, keyfile, p["archive"])
        sha = sha256_file(p["archive"])
        ctx.ledger.record(asin, RETRYABLE, attempts=attempts,
                          device_kfx_size=book.kfx_size, archive_sha256=sha,
                          title=book.basename, detail="decrypted")
        metrics.BOOKS.labels(stage="decrypt", outcome=OK).inc()

        # --- convert -------------------------------------------------------
        ctx.check_stop()
        with metrics.STAGE.labels(stage="convert").time():
            log_text = to_epub(p["archive"], p["epub"], cfg.convert_timeout)
            cls = classify(p["epub"])
            if ("fixed layout comic" in (log_text or "").lower()) != cls.is_comic:
                metrics.CLASSIFY_DISAGREE.inc()
            if cls.confidence == "ambiguous":
                ctx.ledger.record(asin, NEEDS_DECISION, attempts=attempts,
                                  title=book.basename,
                                  detail=f"ambiguous classification: {cls.reasons}")
                res.needs_decision += 1
                return
            if cls.is_comic:
                pages = epub_to_cbz(p["epub"], p["cbz"])
                artifact, kind, expect = p["cbz"], "cbz", pages
                os.path.exists(p["epub"]) and os.unlink(p["epub"])   # largest artifact
            else:
                artifact, kind, expect = p["epub"], "epub", None
        verify_artifact(artifact, kind, expect)
        metrics.BOOKS.labels(stage="convert", outcome=OK).inc()

        # --- reconcile-then-POST -------------------------------------------
        ctx.check_stop()
        existing = ctx.api.find_by_asin(asin)
        if existing:
            ctx.ledger.record(asin, NEEDS_DECISION, attempts=attempts,
                              title=book.basename,
                              detail=f"already in library as #{existing.get('id')}")
            res.needs_decision += 1
            return
        ctx.ledger.record(asin, UPLOADING, attempts=attempts, title=book.basename)
        with metrics.STAGE.labels(stage="upload").time():
            up = ctx.api.upload(artifact)
        book_id = up.get("bookId")

        # --- the verification conjunction ----------------------------------
        ok = (book_id is not None
              and ctx.api.verify(book_id, artifact)
              and archive_intact(p["archive"], sha))
        if not ok:
            ctx.ledger.record(asin, RETRYABLE, attempts=attempts,
                              error="post-upload verification failed")
            res.errors.append((asin, "verification"))
            return
        ctx.ledger.record(asin, OK, attempts=attempts, bookorbit_id=book_id,
                          artifact=artifact, kind=kind, title=book.basename)
        metrics.BOOKS.labels(stage="upload", outcome=OK).inc()
        metrics.LAST_SUCCESS.set(time.time())
        res.uploaded += 1

    except Stopping:
        _cleanup_partials(p)
        raise
    except Duplicate as e:
        ctx.ledger.record(asin, NEEDS_DECISION, attempts=attempts,
                          title=book.basename, detail=f"duplicate: {e}")
        res.needs_decision += 1
    except (AuthExpired, Transport) as e:
        ctx.api._token = None
        ctx.ledger.record(asin, RETRYABLE, attempts=attempts, error=str(e)[:200])
        res.errors.append((asin, str(e)[:80]))
    except (DecryptFailed, ConvertFailed, ArtifactInvalid, UploadRejected) as e:
        ctx.ledger.record(asin, FAILED, attempts=attempts, title=book.basename,
                          error=f"{type(e).__name__}: {str(e)[:200]}")
        metrics.BOOKS.labels(stage="convert", outcome=FAILED).inc()
        res.failed += 1
    except (DeviceUnreachable, TruncatedPull) as e:
        ctx.ledger.record(asin, RETRYABLE, attempts=attempts, error=f"transfer: {e}")
        res.errors.append((asin, "device"))
    except Exception as e:
        # Nothing a single book does may take the cycle down. Without this an
        # unexpected exception escaped, aborted the loop before the remaining
        # books, and -- writing no ledger record -- left attempts unchanged, so
        # the same book crashed every cycle forever. RETRYABLE (not FAILED) so a
        # transient cause still recovers; MAX_ATTEMPTS ends it either way.
        log.exception("unexpected error processing %s", asin)
        ctx.ledger.record(asin, RETRYABLE, attempts=attempts, title=book.basename,
                          error=f"unexpected {type(e).__name__}: {str(e)[:200]}")
        res.errors.append((asin, type(e).__name__))
    finally:
        _cleanup_partials(p)


def _cleanup(ctx: Ctx, books: dict, res: CycleResult) -> None:
    """Delete device sources for books that passed the FULL conjunction.

    Capped per cycle, and it deletes an explicit path list -- never a glob,
    because the ASIN glob used for remediation would take unrelated files.
    """
    if not ctx.cfg.cleanup_enabled:
        return
    done = 0
    for rec in ctx.ledger.by_outcome(OK):
        if done >= ctx.cfg.max_deletes_per_cycle:
            break
        asin = rec["asin"]
        book = books.get(asin)
        if not book or rec.get("cleaned"):
            continue
        art, sha = rec.get("artifact"), rec.get("archive_sha256")
        p = _paths(ctx.cfg, asin)
        if not art or not os.path.exists(art):
            continue
        try:
            verify_artifact(art, rec.get("kind") or "epub")
        except ArtifactInvalid:
            continue
        if not archive_intact(p["archive"], sha):
            continue
        if not ctx.api.verify(rec.get("bookorbit_id"), art):
            continue
        ctx.device.delete_book(book)          # .kfx + assets/ ONLY, never .sdr
        ctx.ledger.record(asin, OK, cleaned=True, **{k: rec[k] for k in
                          ("bookorbit_id", "artifact", "kind") if k in rec})
        res.deleted += 1
        done += 1


def run_cycle(ctx: Ctx) -> CycleResult:
    res = CycleResult()
    metrics.beat()
    if not ctx.device.reachable():
        metrics.REACHABLE.set(0)
        log.info("device unreachable; skipping cycle")     # normal, not an error
        return res
    metrics.REACHABLE.set(1)

    reconcile_startup(ctx)
    books = ctx.device.list_books()
    known = ctx.ledger.asins()
    todo = []
    for asin, b in books.items():
        rec = ctx.ledger.get(asin)
        if rec and rec.get("outcome") in (OK, FAILED, NEEDS_DECISION):
            if rec.get("outcome") == OK and rec.get("device_kfx_size") not in (None, b.kfx_size):
                todo.append(b)                # re-downloaded: size changed
            continue
        todo.append(b)

    for b in list(todo):
        if not b.complete:                    # Amazon never delivered the assets
            ctx.ledger.record(b.asin, RETRYABLE, title=b.basename,
                              error="incomplete download: no asset containers")
            res.skipped += 1
            todo.remove(b)

    if todo:
        with metrics.STAGE.labels(stage="keys").time():
            ctx.device.emit_keys()
        keyfile = ctx.device.fetch_keyfile(os.path.join(ctx.cfg.work_dir, "keys.txt"))
        uploaded_titles = []
        for b in todo:
            try:
                before = res.uploaded
                _process(ctx, b, keyfile, res)
                if res.uploaded > before:
                    uploaded_titles.append(b.basename)
            except Stopping:
                log.info("stopping; abandoned %s cleanly", b.asin)
                break
        ctx.notifier.batch_success(uploaded_titles)

    _cleanup(ctx, books, res)
    _notify_once(ctx)
    metrics.rebuild_from_ledger(ctx.ledger)
    metrics.ARCHIVE_BYTES.set(_dir_bytes(os.path.join(ctx.cfg.data_dir, "archive")))
    metrics.beat()
    return res


def _notify_once(ctx: Ctx) -> None:
    """Durable dedup: notified state lives on the record, not in memory."""
    for outcome, fn in ((FAILED, ctx.notifier.failure),
                        (NEEDS_DECISION, ctx.notifier.needs_decision)):
        for rec in ctx.ledger.by_outcome(outcome):
            if rec.get("notified"):
                continue
            fn(rec["asin"], rec.get("title", rec["asin"]),
               rec.get("error") or rec.get("detail") or "")
            ctx.ledger.record(rec["asin"], outcome, notified=True)


def _dir_bytes(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def await_device(device: Device, timeout: float = 60.0) -> bool:
    """Poll the device until it answers, or give up.

    The userspace tailscaled sidecar opens its SOCKS listener during process
    init but only registers with Headscale seconds later, so a TCP probe of the
    proxy port proves nothing -- it accepts while the proxy still answers
    "General SOCKS server failure". Only an end-to-end probe distinguishes the
    two, so this asks the real question: can we ssh to the Kindle?

    Without this the first cycle after every restart lost the race, logged
    "device unreachable", and then slept a full poll_interval -- so a rollout
    cost up to ten idle minutes. Giving up is not fatal: a sleeping Kindle is
    the normal state, and the loop already retries.
    """
    deadline = time.monotonic() + timeout
    attempts = 0
    while True:
        attempts += 1
        if device.reachable():
            log.info("device reachable after %d probe(s); starting", attempts)
            return True
        if time.monotonic() >= deadline:
            log.info("device still unreachable after %.0fs (%d probes); "
                     "starting anyway", timeout, attempts)
            return False
        time.sleep(_PROBE_GAP)


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config.from_env()
    ctx = Ctx.build(cfg)
    metrics.rebuild_from_ledger(ctx.ledger)     # before serving, so a restart
    metrics.serve(cfg.metrics_port)             # does not reset the stall window
    await_device(ctx.device)                    # else cycle 1 loses the race

    def _stop(signum, _frame):
        log.info("signal %s: finishing the current book then exiting", signum)
        ctx.stop["now"] = True
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    while not ctx.stop["now"]:
        started = time.time()
        try:
            r = run_cycle(ctx)
            log.info("cycle: uploaded=%d failed=%d needs_decision=%d skipped=%d deleted=%d",
                     r.uploaded, r.failed, r.needs_decision, r.skipped, r.deleted)
        except Stopping:
            break
        except Exception:
            log.exception("cycle failed")
        slept = 0.0
        while slept < max(1, cfg.poll_interval - (time.time() - started)) and not ctx.stop["now"]:
            time.sleep(1)
            slept += 1
    log.info("exiting cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
