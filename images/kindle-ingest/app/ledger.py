"""Append-only JSONL ledger, keyed by ASIN.

Whole-file rewrites are truncate-then-write: a kill or a full volume mid-write
leaves an unparseable file, and a worker that reads that as "nothing uploaded"
re-uploads the entire library. Append-only is crash-safe by construction --- a
torn final line is discarded and the damage does not scale with batch size.

Corruption anywhere but the final line HALTS. Proceeding on an empty ledger
would mean re-uploading everything, which is exactly the failure this design
exists to prevent.
"""
import json
import os
import time

OK = "ok"
RETRYABLE = "retryable"
FAILED = "failed"
NEEDS_DECISION = "needs-decision"
UPLOADING = "uploading"          # transient intent, resolved on the next pass
OUTCOMES = {OK, RETRYABLE, FAILED, NEEDS_DECISION, UPLOADING}


class LedgerCorrupt(Exception):
    """Ledger unreadable. Never treat this as an empty ledger."""


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        self._state: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        self._state = {}
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        last = len(lines) - 1
        for i, line in enumerate(lines):
            s = line.strip()
            if not s:
                continue
            try:
                rec = json.loads(s)
            except json.JSONDecodeError:
                if i == last:
                    continue          # torn final write: tolerable
                raise LedgerCorrupt(f"{self.path}: unparseable line {i + 1}")
            if "asin" not in rec:
                raise LedgerCorrupt(f"{self.path}: line {i + 1} has no asin")
            self._state[rec["asin"]] = rec

    def record(self, asin: str, **fields) -> dict:
        rec = dict(self._state.get(asin, {}))
        rec.update(fields)
        rec["asin"] = asin
        rec["ts"] = time.time()
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self._state[asin] = rec
        return rec

    def get(self, asin: str) -> dict | None:
        return self._state.get(asin)

    def asins(self) -> set[str]:
        return set(self._state)

    def by_outcome(self, outcome: str) -> list[dict]:
        return [r for r in self._state.values() if r.get("outcome") == outcome]

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for r in self._state.values():
            o = r.get("outcome", "unknown")
            c[o] = c.get(o, 0) + 1
        return c
