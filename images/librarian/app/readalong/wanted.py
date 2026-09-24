""""Wanted" markers: the librarian asks for a book's read-along right after it
files a book that now holds an EPUB + m4b pair; the worker's trigger runs pick
them up within minutes instead of waiting for the night.

One small JSON file per book, `<book id>.json` = {"book", "at", "arrival"},
written atomically (tmp + rename) on the NFS share both pods mount. The worker
only ever reads names of the form `<digits>.json` whose content names the same
book and carries a time; anything else is ignored and left alone.
"""
import json
import logging
import os
import re

logger = logging.getLogger(__name__)

_NAME = re.compile(r"^(\d+)\.json$")


def _book_id(book_id) -> int:
    if isinstance(book_id, bool) or not isinstance(book_id, (int, str)) or not re.fullmatch(r"\d+", str(book_id)):
        raise ValueError(f"not a book id: {book_id!r}")
    return int(book_id)


def write(directory, book_id, *, now, arrival) -> str:
    """Ask for `book_id`'s read-along. Re-writing an existing marker is harmless."""
    bid = _book_id(book_id)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{bid}.json")
    tmp = os.path.join(directory, f".{bid}.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"book": bid, "at": float(now), "arrival": str(arrival)}, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return path


def read(directory, *, now, settle) -> dict:
    """{book id: asked-at} for markers at least `settle` seconds old."""
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return {}
    except OSError as e:                         # not a directory, permissions, a stale NFS handle:
        logger.warning("cannot read the asks in %s: %s", directory, e)   # never stops a run
        return {}
    out = {}
    for name in names:
        m = _NAME.match(name)
        if not m:
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):            # a directory, a torn or foreign file
            continue
        if not isinstance(data, dict) or data.get("book") != int(m.group(1)):
            continue
        at = data.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)):
            continue
        if now - at >= settle:
            out[int(m.group(1))] = float(at)
    return out


def asked_at(directory, book_id):
    """The marker's time, settled or not; None when there is none."""
    bid = _book_id(book_id)
    try:
        with open(os.path.join(directory, f"{bid}.json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    at = data.get("at") if isinstance(data, dict) and data.get("book") == bid else None
    return float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) else None


def drop(directory, book_id) -> None:
    try:
        os.unlink(os.path.join(directory, f"{_book_id(book_id)}.json"))
    except FileNotFoundError:
        pass
