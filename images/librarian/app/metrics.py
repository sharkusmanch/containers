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

from app.states import ARRIVAL_STATES, NEEDS_DECISION

HEARTBEAT = Gauge("librarian_heartbeat_timestamp", "Unix time of the last loop heartbeat")
ARRIVALS = Gauge("librarian_arrivals", "Arrivals by state (rebuilt from the store each tick)", ["state"])
RUNS = Counter("librarian_runs", "claude -p runs by mode and outcome", ["mode", "outcome"])
RUN_COST = Counter("librarian_run_cost_usd", "Reported claude -p cost in USD")
INTENTS = Counter("librarian_intents", "Intents by kind and final status", ["kind", "status"])
INDEX_BOOKS = Gauge("librarian_index_books", "Books in the BookOrbit library index")
NOTIFY_FAILURES = Counter("librarian_notify_failures_total",
                          "Apprise pushes that gave up after MAX_ATTEMPTS retries")

VIKUNJA_ERRORS = Counter("librarian_vikunja_errors_total",
                         "Vikunja API calls that failed (escalation tasks, replies, closes)")

# Final review I4: alerting. Outcome counters carry `source`; every label is
# created at 0 up front so `increase()` sees the first filing/failure
# (a labelled counter that appears at 1 has no increase to measure).
FILED = Counter("librarian_filed_total", "Arrivals the executor filed into BookOrbit", ["source"])
EXEC_FAILED = Counter("librarian_exec_failed_total",
                      "Filings the executor gave up on (arrival failed; a human must look)", ["source"])
_SOURCE_LABELS = ("manual", "libation", "kindle")      # app.config.SOURCES
for _src in _SOURCE_LABELS:
    FILED.labels(source=_src)
    EXEC_FAILED.labels(source=_src)
ESCALATIONS_OPEN = Gauge("librarian_escalations_open",
                         "needs-decision arrivals a human is being asked about (live sources)")
ESCALATION_OLDEST_AGE = Gauge("librarian_escalation_oldest_age_seconds",
                              "Age of the oldest open question (seconds since its escalation "
                              "was recorded); 0 when none is open")

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


def count_outcome(counter, source) -> None:
    """Increment an outcome counter; an unknown source is labelled "other"."""
    counter.labels(source=source if source in _SOURCE_LABELS else "other").inc()


def rebuild_escalations(arrivals, intents, asked, now: float | None = None,
                        live_since=None) -> None:
    """`librarian_escalations_open` / `..._oldest_age_seconds` from the
    durable stores: needs-decision arrivals for which `asked(rec)` is true
    (live sources -- non-live ones wait silently and must not page), aged
    from their latest escalation's record time (wall clock, like the
    store's own `ts`) -- or from the source's go-live (`live_since(source)`,
    the live-since marker time) when that is later, so an escalation
    recorded during the dry run does not page the moment its source goes
    live."""
    now = time.time() if now is None else now
    open_n = 0
    oldest = 0.0
    for rec in arrivals.by_state(NEEDS_DECISION):
        if not asked(rec):
            continue
        open_n += 1
        try:
            esc = intents.latest_escalation(rec["key"])
        except Exception:          # a bad record must not cost the tick its metrics
            esc = None
        since = (esc or {}).get("ts") or rec.get("ts") or now
        try:
            went_live = live_since(rec.get("source")) if live_since is not None else None
        except Exception:
            went_live = None
        if isinstance(went_live, (int, float)):
            since = max(since, went_live)
        oldest = max(oldest, now - since)
    ESCALATIONS_OPEN.set(open_n)
    ESCALATION_OLDEST_AGE.set(max(0.0, oldest))


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
