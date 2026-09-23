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

    @classmethod
    def load(cls, path) -> "State":
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return cls(path, {})
        except (OSError, ValueError) as e:
            raise RuntimeError(f"cannot read the read-along state {path}: {e}") from None
        if not isinstance(data, dict):
            raise RuntimeError(f"the read-along state {path} is not a JSON object")
        return cls(path, data)

    def save(self) -> None:
        data = {"in_flight": self.in_flight, "refused": self.refused, "errors": self.errors,
                "history": self.history[-HISTORY_MAX:], "foreign_busy_since": self.foreign_busy_since,
                "foreign_told": self.foreign_told}
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
    def add_error(self, book, pair, message, *, now) -> int:
        e = self.errors.get(str(book))
        if not e or e.get("pair") != _pair(pair):
            e = {"pair": _pair(pair), "count": 0}
        e.update(count=e["count"] + 1, last=str(message)[:300], at=now)
        self.errors[str(book)] = e
        return e["count"]

    def error_count(self, book, pair) -> int:
        e = self.errors.get(str(book))
        return e["count"] if e and e.get("pair") == _pair(pair) else 0

    def clear_error(self, book) -> None:
        self.errors.pop(str(book), None)

    # history ---------------------------------------------------------------------
    def record(self, outcome, book, detail, *, now) -> None:
        self.history.append({"outcome": outcome, "book": book, "detail": detail, "at": now})
        del self.history[:-HISTORY_MAX]
