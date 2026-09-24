"""`python -m app.readalong`: the read-along worker (the librarian release's
`readalong` Deployment, one replica). It runs until SIGTERM: the nightly run,
on-demand runs (`touch <STATE_DIR>/run-now`) and a look every TICK_SECONDS at
the librarian's asks and the book in Storyteller -- see app/readalong/worker.py.

It holds the state lock for its whole life: it is the only writer. Exit 1 =
it could not start (another worker holds the lock, a missing state, BookOrbit
unreachable); Kubernetes restarts it and the heartbeat alert fires if that
persists."""
import fcntl
import logging
import os
import sys

from app.bookorbit import BookorbitClient, BookorbitWriter
from app.readalong import metrics
from app.readalong.config import Settings
from app.readalong.job import Bookorbit
from app.readalong.storyteller import StorytellerClient
from app.readalong.worker import Worker


def main(env=os.environ, serve_metrics=metrics.serve, install=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("readalong")
    s = Settings.from_env(env)
    os.makedirs(s.state_dir, exist_ok=True)
    lock = open(os.path.join(s.state_dir, "readalong.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.error("another read-along worker holds the lock; exiting")
        return 1
    try:
        client = BookorbitClient(s.bookorbit_url, s.bookorbit_user, s.bookorbit_pass,
                                 cookie_path=os.path.join(s.state_dir, "bookorbit-cookies.txt"),
                                 writable=not s.dry_run)
        client.authenticate()
        writer = BookorbitWriter(client) if not s.dry_run else None
        bo = Bookorbit(client, writer)
        worker = Worker(s, bo=bo, st=StorytellerClient(s.storyteller_url))
        bo.sleep = worker.sleep                  # scan waits beat the heartbeat too
        serve_metrics(s.metrics_port, s.stale_after)
        (install or _install_sigterm)(worker)
        return worker.serve()
    except Exception:
        log.exception("read-along worker stopped")
        return 1


def _install_sigterm(worker):
    import signal
    signal.signal(signal.SIGTERM, worker.on_sigterm)


if __name__ == "__main__":
    sys.exit(main())
