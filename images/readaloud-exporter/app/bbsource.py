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
    map_json: str
    last_updated: str


class BookBridgeDB:
    def __init__(self, path):
        self.conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)

    def settings(self) -> dict[str, str]:
        return {k: v for k, v in self.conn.execute("select key, value from settings")}

    def eligible(self, only: set[str] | None) -> list[BookRow]:
        q = ("select b.abs_id, b.abs_title, b.ebook_filename, a.align_method, a.total_chars, "
             "a.alignment_map_json, a.last_updated from books b join book_alignments a on a.abs_id = b.abs_id "
             "where b.status = 'active' and b.audio_source = 'ABS' and b.ebook_filename is not null "
             f"and a.align_method in ({','.join('?' * len(ELIGIBLE_METHODS))}) order by b.abs_title")
        rows = [BookRow(*r) for r in self.conn.execute(q, ELIGIBLE_METHODS)]
        return [r for r in rows if only is None or r.abs_id in only]

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
