"""Generic crash-safe, append-only JSONL store.

Generalised from kindle-ingest's app/ledger.py (see that file's docstring for
the original rationale). The ledger there is keyed by ASIN and tracks an
"outcome" field; this store is used for both arrivals and intents, so the key
field name is configurable and the set of allowed values is passed in by the
caller rather than hard-coded. The status field itself is always named
"state" here (ledger.py used "outcome").

Differences from ledger.py:
  * key field name is configurable (`key_field`), not hard-coded to "asin"
  * the status field is always named "state" (ledger.py used "outcome")
  * the per-attempt fields cleared on a state change are ("error", "detail")
    -- there is no bookorbit_id concept here
  * `record` does not keep a "history" list on the record itself; the JSONL
    file IS the history (one line per call to `record`)
  * `record` is guarded by a threading.Lock -- Claude Code issues MCP calls in
    parallel and ThreadingHTTPServer serves them concurrently, so concurrent
    writers are a real scenario here, unlike kindle-ingest's single-threaded
    poll loop
  * `all`/`by_state`/`counts` snapshot under that same lock too (fix round 1,
    M1) -- a reader iterating `dict.values()` while `record()` resizes the
    dict on another thread can otherwise raise "dictionary changed size
    during iteration"; this is a real race under concurrent requests (e.g.
    app/api.py's `_visible_arrivals`/`IntentBook.proposals` path)

Durability rules (unchanged from ledger.py):
  * append-only: a torn final line is discarded, and the damage from a
    partial write does not scale with batch size
  * a torn tail is REPAIRED before the next append, because gluing a new
    record onto an unterminated one loses that record and then corrupts the
    file permanently on the following write
  * the parent directory is fsynced when the file is created, otherwise a
    crash can leave the directory entry unwritten and the store simply
    absent -- the one corruption path that would NOT halt
  * corruption anywhere but the final line HALTS
"""
import json
import os
import threading
import time

# Cleared whenever `state` changes, so a later record cannot inherit a stale
# error/detail from a previous attempt.
_PER_ATTEMPT = ("error", "detail")


class StoreCorrupt(Exception):
    """Store unreadable. NEVER treat this as an empty store."""


# --- module-level JSONL helpers -------------------------------------------------
# Shared by `Store` and by app/runs.py + app/service.py for runs.jsonl (final
# review I2): an append-only log that is not a keyed state table still needs
# the same torn-tail discipline, or one torn run record glues itself onto the
# next one and both are lost.


def fsync_dir(path: str) -> None:
    """fsync the directory containing `path` (makes a new entry durable)."""
    d = os.path.dirname(str(path)) or "."
    fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def repair_tail(path: str) -> None:
    """Discard an unterminated final line before appending after it.

    An unterminated line is an incomplete record: the process died partway
    through writing it. It must be TRUNCATED, not terminated. Adding a
    newline would preserve unparseable bytes as a permanent mid-file line,
    which halts every future load -- turning a recoverable torn write into
    an unrecoverable store.
    """
    path = str(path)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return
    with open(path, "r+b") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(-1, os.SEEK_END)
        if f.read(1) == b"\n":
            return
        # walk back to the last newline and cut there
        pos = size - 1
        chunk = 4096
        while pos > 0:
            start = max(0, pos - chunk)
            f.seek(start)
            buf = f.read(pos - start)
            idx = buf.rfind(b"\n")
            if idx != -1:
                pos = start + idx + 1
                break
            pos = start
        f.truncate(pos)
        f.flush()
        os.fsync(f.fileno())


def append_record(path: str, rec: dict) -> None:
    """Durably append one JSON object as a line: repair a torn tail first,
    fsync the line, and fsync the directory when the file is new."""
    path = str(path)
    existed = os.path.exists(path)
    repair_tail(path)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())
    if not existed:
        fsync_dir(path)


def read_records(path: str) -> list[dict]:
    """Every JSON-object line of `path`, in order. A torn (unterminated)
    final line is skipped; any other unreadable line raises StoreCorrupt.
    A missing file is an empty list."""
    path = str(path)
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        raw = f.read()
    lines = raw.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()                       # file ended with a newline
        torn_index = -1
    else:
        torn_index = len(lines) - 1       # unterminated final line
    out = []
    for i, bline in enumerate(lines):
        if i == torn_index:
            continue                      # tolerable: a torn final write
        if not bline.strip():
            raise StoreCorrupt(f"{path}: blank line {i + 1}")
        try:
            rec = json.loads(bline.decode("utf-8"))
        except UnicodeDecodeError as e:
            raise StoreCorrupt(f"{path}: line {i + 1} is not UTF-8") from e
        except json.JSONDecodeError as e:
            raise StoreCorrupt(f"{path}: unparseable line {i + 1}") from e
        if not isinstance(rec, dict):
            raise StoreCorrupt(f"{path}: line {i + 1} is not an object")
        out.append(rec)
    return out


class Store:
    def __init__(self, path: str, key_field: str, allowed_states: frozenset[str]):
        self.path = str(path)
        self.key_field = key_field
        self.allowed_states = allowed_states
        self._state: dict[str, dict] = {}
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self._load()

    # --- io ------------------------------------------------------------------
    def _load(self) -> None:
        self._state = {}
        for i, rec in enumerate(read_records(self.path)):
            key = rec.get(self.key_field)
            if not isinstance(key, str) or not key:
                raise StoreCorrupt(
                    f"{self.path}: line {i + 1} has no usable {self.key_field!r}")
            self._state[key] = rec

    def record(self, key: str, state: str, **fields) -> dict:
        if state not in self.allowed_states:
            raise ValueError(
                f"unknown state {state!r}; expected one of {sorted(self.allowed_states)}")
        with self._lock:
            prev = self._state.get(key, {})
            rec = dict(prev)
            if prev.get("state") != state:
                for k in _PER_ATTEMPT:
                    rec.pop(k, None)
            rec.update(fields)
            rec[self.key_field] = key
            rec["state"] = state
            rec["ts"] = time.time()
            rec.setdefault("first_seen", rec["ts"])
            append_record(self.path, rec)
            self._state[key] = rec
            return dict(rec)

    # --- queries (all return copies; callers must not mutate live state) -----
    def get(self, key: str) -> dict | None:
        r = self._state.get(key)
        return dict(r) if r is not None else None

    def all(self) -> list[dict]:
        # Snapshot under the same lock `record()` uses (fix round 1, M1):
        # without it, a concurrent `record()` resizing `self._state` while
        # this iterates `.values()` can raise "dictionary changed size
        # during iteration" -- a real race under ThreadingHTTPServer, where
        # e.g. app.api's proposals()/_visible_arrivals reads can run
        # concurrently with a reviewer's apply_review recording a verdict.
        with self._lock:
            return [dict(r) for r in self._state.values()]

    def by_state(self, state: str) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._state.values() if r.get("state") == state]

    def counts(self) -> dict[str, int]:
        with self._lock:
            c: dict[str, int] = {}
            for r in self._state.values():
                s = r.get("state", "unknown")
                c[s] = c.get(s, 0) + 1
            return c
