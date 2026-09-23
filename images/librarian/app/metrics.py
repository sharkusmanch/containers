"""Prometheus metrics and /healthz (kindle-ingest style).

The heartbeat is the load-bearing signal: `/metrics` keeps answering 200 even
when the poll loop is wedged, so liveness is judged on the loop's own
timestamp. `beat()` is called at the top of every tick AND as the runner's
`on_tick` while a `claude -p` child is running, so a legitimately long run
does not read as a stall. `stale_after` must therefore exceed the longest
legitimate gap between beats -- the service passes
`3 * poll_interval + run_timeout`.
"""
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, generate_latest

from app.states import ARRIVAL_STATES

HEARTBEAT = Gauge("librarian_heartbeat_timestamp", "Unix time of the last loop heartbeat")
ARRIVALS = Gauge("librarian_arrivals", "Arrivals by state (rebuilt from the store each tick)", ["state"])
RUNS = Counter("librarian_runs", "claude -p runs by mode and outcome", ["mode", "outcome"])
RUN_COST = Counter("librarian_run_cost_usd", "Reported claude -p cost in USD")
INTENTS = Counter("librarian_intents", "Intents by kind and final status", ["kind", "status"])
INDEX_BOOKS = Gauge("librarian_index_books", "Books in the BookOrbit library index")

_started = time.time()
_last_beat = 0.0   # mirrors HEARTBEAT without reaching into prometheus internals


def beat() -> None:
    global _last_beat
    _last_beat = time.time()
    HEARTBEAT.set(_last_beat)


def rebuild_arrivals(store) -> None:
    """Gauges are process-local; rebuild from the durable store so a restart
    (or a state no tick has touched yet) reports the truth."""
    counts = store.counts()
    for state in ARRIVAL_STATES:
        ARRIVALS.labels(state=state).set(counts.get(state, 0))


class _Handler(BaseHTTPRequestHandler):
    stale_after = 3 * 120 + 2700

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
            now = time.time()
            hb = _last_beat
            alive = hb > 0 and (now - hb) < self.stale_after
            if hb == 0 and (now - _started) < self.stale_after:
                alive = True     # startup grace: the first tick may be slow
            self.send_response(200 if alive else 503)
            self.end_headers()
            self.wfile.write(b"ok" if alive else b"stale")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


def serve(port: int, stale_after: int | None = None) -> ThreadingHTTPServer:
    """Threaded (final review minor 10): a hung or slow scrape must never
    block the kubelet's /healthz probe behind it."""
    if stale_after is not None:
        _Handler.stale_after = stale_after
    srv = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True, name="metrics").start()
    return srv
