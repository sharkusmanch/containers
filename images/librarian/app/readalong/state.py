"""The job's own memory, /state/readalong.json (its own small PVC).

Everything else is re-derived each run from BookOrbit, Storyteller and the
disk; this file only holds what cannot be: the book currently in Storyteller,
refusals and error counts -- each keyed on the exact file pair
(epub id, epub size, m4b id, m4b size), so a changed file clears it (never
persist "not eligible": the bookbridge exclusions rotted within two weeks) --
and a short history for the log.

A torn or unreadable file is an ERROR, never an empty state: forgetting the
refusals would re-align every one of them.
"""
import json
import os

HISTORY_MAX = 200
ERROR_LIMIT = 3                  # failed attempts on the same file pair before giving up
GIVE_UP_DAYS = 30                # a give-up is not forever: errors can be transient


def _pair(pair):
    return [int(x) for x in pair]


class State:
    def __init__(self, path, data):
        self.path = path
        self.in_flight = data.get("in_flight")
        self.refused = data.get("refused", {})
        self.errors = data.get("errors", {})
        self.history = data.get("history", [])
        self.foreign_busy_since = data.get("foreign_busy_since")   # another client holding Storyteller
        self.foreign_told = bool(data.get("foreign_told"))
        # gated, staged read-alongs waiting for a stray file to go (no Storyteller book held)
        self.blocked = data.get("blocked", {})
        # this run's push, persisted line by line so a kill loses none: {"lines", "published", "refused"}
        self.pending_push = data.get("pending_push")
        # uuids of our own Storyteller books whose delete failed: retried every run
        self.to_release = data.get("to_release", {})
        # the nightly run of a local date: {"date", "started", "done"} -- a restart resumes it, never repeats it
        self.last_nightly = data.get("last_nightly") or {}
        # {kind: unix time} of the last good nightly / on-demand run / tick (the metrics survive restarts)
        self.last_success = data.get("last_success") or {}
        self.tick_failure_told = data.get("tick_failure_told")      # a local date: told once a day
        # this Job's run window, shared with its retry pods: {"job", "started", "failure_told"}
        self.run = data.get("run") or {}

    @classmethod
    def load(cls, path, *, required=False) -> "State":
        """`required`: a missing file is an error -- a mis-mounted or mis-set
        state dir must never look like a fresh start that forgets refusals."""
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            if required:
                raise RuntimeError(f"the read-along state {path} is missing (STATE_REQUIRED)") from None
            return cls(path, {})
        except (OSError, ValueError) as e:
            raise RuntimeError(f"cannot read the read-along state {path}: {e}") from None
        if not isinstance(data, dict):
            raise RuntimeError(f"the read-along state {path} is not a JSON object")
        return cls(path, data)

    def save(self) -> None:
        data = {"in_flight": self.in_flight, "refused": self.refused, "errors": self.errors,
                "history": self.history[-HISTORY_MAX:], "foreign_busy_since": self.foreign_busy_since,
                "foreign_told": self.foreign_told, "blocked": self.blocked, "pending_push": self.pending_push,
                "run": self.run, "to_release": self.to_release, "last_nightly": self.last_nightly,
                "last_success": self.last_success, "tick_failure_told": self.tick_failure_told}
        d = os.path.dirname(self.path) or "."
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)
        fd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    # refusals ------------------------------------------------------------------
    def refuse(self, book, pair, grade, reasons, *, now) -> None:
        self.refused[str(book)] = {"pair": _pair(pair), "grade": grade, "reasons": list(reasons), "at": now}

    def is_refused(self, book, pair) -> bool:
        r = self.refused.get(str(book))
        return bool(r) and r.get("pair") == _pair(pair)

    # errors ----------------------------------------------------------------------
    def add_error(self, book, pair, message, *, now, min_interval=0) -> int:
        """Count a failed attempt; within `min_interval` seconds of the last
        counted one only the message is updated (a Job's retry pods must not
        triple-count one night)."""
        e = self.errors.get(str(book))
        if not e or e.get("pair") != _pair(pair):
            e = {"pair": _pair(pair), "count": 0}
        if e["count"] and now - e.get("at", 0) < min_interval:
            e["last"] = str(message)[:300]
        else:
            e.update(count=e["count"] + 1, last=str(message)[:300], at=now)
        self.errors[str(book)] = e
        return e["count"]

    def error_count(self, book, pair) -> int:
        e = self.errors.get(str(book))
        return e["count"] if e and e.get("pair") == _pair(pair) else 0

    def gave_up(self, book, pair, now) -> bool:
        """ERROR_LIMIT failures on this exact pair, the last within GIVE_UP_DAYS:
        after that the book gets one more try (and one failure gives up again)."""
        e = self.errors.get(str(book))
        return bool(e) and e.get("pair") == _pair(pair) and e["count"] >= ERROR_LIMIT \
            and now - e.get("at", 0) < GIVE_UP_DAYS * 86400

    def recent_error(self, book, pair, now, interval) -> bool:
        """A failure on this pair counted within `interval`: the nightly run owns its retry."""
        e = self.errors.get(str(book))
        return bool(e) and e.get("pair") == _pair(pair) and e.get("count", 0) > 0 \
            and now - e.get("at", 0) < interval

    def clear_error(self, book) -> None:
        self.errors.pop(str(book), None)

    # history ---------------------------------------------------------------------
    def record(self, outcome, book, detail, *, now) -> None:
        self.history.append({"outcome": outcome, "book": book, "detail": detail, "at": now})
        del self.history[:-HISTORY_MAX]
