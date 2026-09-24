"""`python -m app.readalong`: one nightly run (the librarian release's
`readalong` CronJob). Exit 0 = the run did its job (books may still have been
refused or failed: those are in the push), or another run holds the lock;
1 = it could not (listing, login, push delivery, anything unexpected) -- the
Job fails and alerts."""
import fcntl
import logging
import os
import sys

from app.bookorbit import BookorbitClient, BookorbitWriter
from app.readalong.config import Settings
from app.readalong.job import Bookorbit, Job, install_sigterm
from app.readalong.storyteller import StorytellerClient


def main(env=os.environ) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("readalong")
    s = Settings.from_env(env)
    os.makedirs(s.state_dir, exist_ok=True)
    lock = open(os.path.join(s.state_dir, "readalong.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:              # e.g. a manual run still going at 00:30: its window, not an error
        log.warning("another read-along run holds the lock; nothing to do")
        return 0
    try:
        client = BookorbitClient(s.bookorbit_url, s.bookorbit_user, s.bookorbit_pass,
                                 cookie_path=os.path.join(s.state_dir, "bookorbit-cookies.txt"),
                                 writable=not s.dry_run)
        client.authenticate()
        writer = BookorbitWriter(client) if not s.dry_run else None
        job = Job(s, bo=Bookorbit(client, writer), st=StorytellerClient(s.storyteller_url))
        install_sigterm(job)
        return job.run()
    except Exception:
        log.exception("read-along run could not complete")
        return 1


if __name__ == "__main__":
    sys.exit(main())
