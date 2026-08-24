"""Append-only JSONL ledger, keyed by ASIN.

The ledger is the ONLY record of what reached the library. If it is lost, or
misread as empty, the pipeline re-uploads everything -- and because the design
is additive-only, the sole remedy is deleting book rows, which destroys reading
position. Every decision here is made against that failure.

Durability rules:
  * append-only: a torn final line is discarded, and the damage from a partial
    write does not scale with batch size
  * a torn tail is REPAIRED before the next append, because gluing a new record
    onto an unterminated one loses that record and then corrupts the file
    permanently on the following write
  * the parent directory is fsynced when the file is created, otherwise a crash
    can leave the directory entry unwritten and the ledger simply absent --- the
    one corruption path that would NOT halt
  * corruption anywhere but the final line HALTS
"""
import json
import os
import time

OK = "ok"
RETRYABLE = "retryable"
FAILED = "failed"
NEEDS_DECISION = "needs-decision"
UPLOADING = "uploading"          # transient intent, resolved by reconciliation
OUTCOMES = frozenset({OK, RETRYABLE, FAILED, NEEDS_DECISION, UPLOADING})

# Cleared whenever `outcome` changes, so a later record cannot inherit a stale
# bookorbit_id (which would make a failed book look uploaded and licence
# deleting the device copy) or a stale error (which would report a reason on a
# successful upload).
_PER_ATTEMPT = ("error", "bookorbit_id", "detail")


class LedgerCorrupt(Exception):
    """Ledger unreadable. NEVER treat this as an empty ledger."""


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        self._state: dict[str, dict] = {}
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.load()

    # --- durability helpers ------------------------------------------------
    def _fsync_dir(self) -> None:
        d = os.path.dirname(self.path) or "."
        fd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _repair_tail(self) -> None:
        """Discard an unterminated final line before appending after it.

        An unterminated line is an incomplete record: the process died partway
        through writing it. It must be TRUNCATED, not terminated. Adding a
        newline would preserve unparseable bytes as a permanent mid-file line,
        which halts every future load -- turning a recoverable torn write into
        an unrecoverable ledger.
        """
        if not os.path.exists(self.path) or os.path.getsize(self.path) == 0:
            return
        with open(self.path, "r+b") as f:
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

    # --- io ----------------------------------------------------------------
    def load(self) -> None:
        self._state = {}
        if not os.path.exists(self.path):
            return
        with open(self.path, "rb") as f:
            raw = f.read()
        lines = raw.split(b"\n")
        if lines and lines[-1] == b"":
            lines.pop()                       # file ended with a newline
            torn_index = -1
        else:
            torn_index = len(lines) - 1       # unterminated final line
        for i, bline in enumerate(lines):
            if i == torn_index:
                continue                      # tolerable: a torn final write
            if not bline.strip():
                raise LedgerCorrupt(f"{self.path}: blank line {i + 1}")
            try:
                rec = json.loads(bline.decode("utf-8"))
            except UnicodeDecodeError as e:
                raise LedgerCorrupt(f"{self.path}: line {i + 1} is not UTF-8") from e
            except json.JSONDecodeError as e:
                raise LedgerCorrupt(f"{self.path}: unparseable line {i + 1}") from e
            if not isinstance(rec, dict):
                raise LedgerCorrupt(f"{self.path}: line {i + 1} is not an object")
            asin = rec.get("asin")
            if not isinstance(asin, str) or not asin:
                raise LedgerCorrupt(f"{self.path}: line {i + 1} has no usable asin")
            self._state[asin] = rec

    def record(self, asin: str, outcome: str, **fields) -> dict:
        if outcome not in OUTCOMES:
            raise ValueError(f"unknown outcome {outcome!r}; expected one of {sorted(OUTCOMES)}")
        prev = self._state.get(asin, {})
        rec = dict(prev)
        if prev.get("outcome") != outcome:
            for k in _PER_ATTEMPT:
                rec.pop(k, None)
        rec.update(fields)
        rec["asin"] = asin
        rec["outcome"] = outcome
        rec["ts"] = time.time()
        rec.setdefault("first_seen", rec["ts"])
        existed = os.path.exists(self.path)
        self._repair_tail()
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        if not existed:
            self._fsync_dir()                 # make the directory entry durable
        self._state[asin] = rec
        return dict(rec)

    # --- queries (all return copies; callers must not mutate live state) ----
    def get(self, asin: str) -> dict | None:
        r = self._state.get(asin)
        return dict(r) if r is not None else None

    def asins(self) -> set[str]:
        return set(self._state)

    def by_outcome(self, outcome: str) -> list[dict]:
        return [dict(r) for r in self._state.values() if r.get("outcome") == outcome]

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for r in self._state.values():
            o = r.get("outcome", "unknown")
            c[o] = c.get(o, 0) + 1
        return c
