"""Metrics and health.

The heartbeat is the load-bearing signal. A worker blocked on a hung ssh keeps
serving 200 on /metrics, so `up == 0` never fires; and pending_books is only
updated BY the loop, so it sits at 0 forever. Without a loop-iteration
timestamp, a wedged pipeline is invisible to every alert.

last_success cannot double as liveness: it legitimately stays stale for days
when the Kindle is asleep, which is the normal state.
"""
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST

HEARTBEAT = Gauge("kindle_pipeline_heartbeat_timestamp",
                  "Unix time of the last completed loop iteration")
BOOKS = Counter("kindle_pipeline_books_total", "Books processed", ["stage", "outcome"])
PENDING = Gauge("kindle_pipeline_pending_books", "Discovered but not yet uploaded")
NEEDS_DECISION = Gauge("kindle_pipeline_needs_decision_books", "Awaiting a human")
FAILED = Gauge("kindle_pipeline_failed_books", "Terminal failures", ["category"])
REACHABLE = Gauge("kindle_pipeline_device_reachable", "1 if the Kindle answered")
LAST_SUCCESS = Gauge("kindle_pipeline_last_success_timestamp_seconds",
                     "Unix time of the last successful upload")
STAGE = Histogram("kindle_pipeline_stage_duration_seconds", "Stage duration", ["stage"])
ARCHIVE_BYTES = Gauge("kindle_pipeline_archive_bytes", "Bytes held in the archive")
CLASSIFY_DISAGREE = Counter("kindle_pipeline_classify_disagree_total",
                            "Structural verdict disagreed with calibre's log string")

_started = time.time()


def beat() -> None:
    HEARTBEAT.set(time.time())


def rebuild_from_ledger(ledger) -> None:
    """Gauges are process-local and reset on restart, which would restart the
    stall window on every crash. Rebuild from durable state BEFORE serving."""
    from .ledger import OK, NEEDS_DECISION as ND, FAILED as F, RETRYABLE, UPLOADING
    c = ledger.counts()
    PENDING.set(c.get(RETRYABLE, 0) + c.get(UPLOADING, 0))
    NEEDS_DECISION.set(c.get(ND, 0))
    FAILED.labels(category="all").set(c.get(F, 0))


class _Handler(BaseHTTPRequestHandler):
    stale_after = 1800          # ~3 poll intervals

    def do_GET(self):
        if self.path.startswith("/metrics"):
            body = generate_latest()
            self.send_response(200)
            self.send_header("Content-Type", CONTENT_TYPE_LATEST)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/healthz"):
            # Liveness asserts the LOOP is alive, not that HTTP works. Grace on
            # startup so a first slow cycle does not trigger a crashloop.
            hb = HEARTBEAT._value.get()
            alive = hb > 0 and (time.time() - hb) < self.stale_after
            if hb == 0 and (time.time() - _started) < self.stale_after:
                alive = True
            self.send_response(200 if alive else 503)
            self.end_headers()
            self.wfile.write(b"ok" if alive else b"stale")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass                     # probes must not spam the log


def serve(port: int) -> HTTPServer:
    """Runs on its own thread so a blocking ssh or a 30-minute conversion does
    not make the probe fail and kill the pod mid-book."""
    srv = HTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True, name="metrics").start()
    return srv
