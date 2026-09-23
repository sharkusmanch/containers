"""Entrypoint: `python -m app.main`.

Settings.from_env (refuses DRY_RUN=false) -> BookOrbit client -> library
index -> Service (which starts its own loopback ApiServer) -> metrics ->
serve_forever. SIGTERM/SIGINT stop the loop; if a `claude -p` child is
running, `Stopping` is raised into the runner so run_claude's cleanup kills
the child's process group and the cycle is discarded (its arrivals are
re-offered after restart). Exit code 0.
"""
import logging
import os
import signal
import sys
import time

from app import metrics
from app.bookorbit import BookorbitClient, LibraryIndex
from app.config import Settings
from app.service import Service, Stopping

log = logging.getLogger("librarian")

# BookOrbit login is throttled 5/min, shared with every other client --
# never retry faster than this.
AUTH_RETRY_SECONDS = 300


def authenticate(client, stop) -> bool:
    """Authenticate once (refresh cookie preferred, see BookorbitClient).
    On failure wait AUTH_RETRY_SECONDS and try again, beating the heartbeat
    so liveness does not kill a pod that is only waiting on BookOrbit."""
    while not stop["now"]:
        try:
            client.authenticate()
            return True
        except Exception as e:
            log.error("BookOrbit authentication failed (%s); retrying in %ss", e, AUTH_RETRY_SECONDS)
            for _ in range(AUTH_RETRY_SECONDS):
                if stop["now"]:
                    return False
                metrics.beat()
                time.sleep(1)
    return False


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env(os.environ)
    os.makedirs(settings.state_dir, exist_ok=True)

    client = BookorbitClient(settings.bookorbit_url, settings.bookorbit_user, settings.bookorbit_pass,
                             cookie_path=os.path.join(settings.state_dir, "bookorbit-cookies.txt"))
    stop = {"now": False}

    def early_signal(signum, _frame):
        stop["now"] = True

    signal.signal(signal.SIGTERM, early_signal)
    signal.signal(signal.SIGINT, early_signal)
    metrics.serve(settings.metrics_port, stale_after=3 * settings.poll_interval + settings.run_timeout)
    if not authenticate(client, stop):
        return 0

    index = LibraryIndex(client, state_path=os.path.join(settings.state_dir, "library-index.json"),
                         path_prefix=settings.bookorbit_path_prefix,
                         local_root=settings.local_books_root)
    service = Service(settings, index=index)
    log.info("librarian started (dry-run), api on 127.0.0.1:%s, metrics on :%s",
             service.api_port, settings.metrics_port)

    def on_signal(signum, _frame):
        log.info("signal %s: stopping", signum)
        if service.request_stop():
            raise Stopping()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        service.serve_forever()
    finally:
        service.stop()
    log.info("librarian stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
