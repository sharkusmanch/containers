"""The read-along worker's metrics and /healthz -- its own names, never the
librarian service's (a second pod exporting `librarian_heartbeat_timestamp`
would confuse the librarian's alerts).

The heartbeat is beaten by the loop and by every sleep inside a unit of work
(poll waits, scan waits), never by a background thread: a wedged unit must
read as stale. The longest legitimate gap is one blocking call (a Storyteller
request, up to its 900 s timeout), so STALE_AFTER defaults to an hour.
"""
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, generate_latest

KINDS = ("nightly", "now", "tick")
OUTCOMES = ("ok", "failed")

HEARTBEAT = Gauge("librarian_readalong_heartbeat_timestamp_seconds",
                  "Unix time the read-along worker's loop last showed signs of life")
LAST_SUCCESS = Gauge("librarian_readalong_last_success_timestamp_seconds",
                     "Unix time of the last successful unit of work, by kind (restored from state at start)",
                     ["kind"])
RUNS = Counter("librarian_readalong_runs", "Units of work by kind and outcome", ["kind", "outcome"])
for _k in KINDS:                    # created at 0: increase() must see the first failure after a restart
    for _o in OUTCOMES:
        RUNS.labels(kind=_k, outcome=_o)

_started = time.time()
_last_beat = 0.0


def beat() -> None:
    global _last_beat
    _last_beat = time.time()
    HEARTBEAT.set(_last_beat)


class _Handler(BaseHTTPRequestHandler):
    stale_after = 3600

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
            alive = (_last_beat > 0 and now - _last_beat < self.stale_after) or \
                (_last_beat == 0 and now - _started < self.stale_after)
            self.send_response(200 if alive else 503)
            self.end_headers()
            self.wfile.write(b"ok" if alive else b"stale")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


def serve(port: int, stale_after: int) -> ThreadingHTTPServer:
    _Handler.stale_after = stale_after
    srv = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True, name="metrics").start()
    return srv
