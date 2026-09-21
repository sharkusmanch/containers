"""Read-only access to the alignment database and ebook files."""
from __future__ import annotations

import glob
import sqlite3
from dataclasses import dataclass
from pathlib import Path

ELIGIBLE_METHODS = ("lexical", "lexical_timed", "llm_anchor")


@dataclass
class BookRow:
    abs_id: str
    title: str
    ebook_filename: str
    align_method: str
    total_chars: int
    map_json: str  # "" from eligible(); load with BookBridgeDB.map_json()
    last_updated: str


class BookBridgeDB:
    def __init__(self, path):
        self.conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)

    def settings(self) -> dict[str, str]:
        return {k: v for k, v in self.conn.execute("select key, value from settings")}

    def eligible(self, only: set[str] | None) -> list[BookRow]:
        """Metadata only: the alignment maps are large (the whole table can exceed the job's
        memory limit), so each is loaded on demand with map_json(). `map_json` is left ""."""
        if only is not None and not only:
            return []
        q = ("select b.abs_id, b.abs_title, b.ebook_filename, a.align_method, a.total_chars, '', "
             "a.last_updated from books b join book_alignments a on a.abs_id = b.abs_id "
             "where b.status = 'active' and b.audio_source = 'ABS' and b.ebook_filename is not null "
             f"and a.align_method in ({','.join('?' * len(ELIGIBLE_METHODS))})")
        args = list(ELIGIBLE_METHODS)
        if only is not None:
            ids = sorted(only)
            q += f" and b.abs_id in ({','.join('?' * len(ids))})"
            args += ids
        return [BookRow(*r) for r in self.conn.execute(q + " order by b.abs_title", args)]

    def map_json(self, abs_id: str) -> str:
        r = self.conn.execute("select alignment_map_json from book_alignments where abs_id = ?",
                              (abs_id,)).fetchone()
        if r is None:
            raise KeyError(f"no alignment for {abs_id}")
        return r[0]

    def close(self) -> None:
        self.conn.close()


def resolve_epub(filename: str, roots: list[str]) -> Path | None:
    for root in roots:
        p = Path(root)
        if not p.is_dir():
            continue
        hit = next(p.glob(f"**/{glob.escape(filename)}"), None)
        if hit is not None:
            return hit
    return None
