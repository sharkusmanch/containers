"""Pure BookOrbit metadata helpers for the executor (no I/O).

Split out of app/executor.py to keep it reviewable. PATCH keys used here are
only those confirmed by earlier successful writes in /config/books/scripts:
title, subtitle, authors (list of names), seriesName, seriesIndex (a STRING,
e.g. "2" / "2.5"), publishedYear (int), language, audibleId, tags (list of
names). `narrators` is deliberately NOT written -- no confirmed PATCH key.
"""
import re

from app.policy import _format_index

ASIN_RE = re.compile(r"^[A-Za-z0-9]{10,13}$")

IDENTITY = ("title", "subtitle", "authors", "seriesName", "seriesIndex", "publishedYear", "language")


def names(entries) -> list:
    out = []
    for e in entries or []:
        n = e.get("name") if isinstance(e, dict) else e
        if n:
            out.append(n)
    return out


def norm_index(v):
    """seriesIndex as BookOrbit's API takes it: a string ("2", "2.5")."""
    if v is None or v == "":
        return None
    try:
        return _format_index(v)
    except (TypeError, ValueError):
        return str(v)


def identity(d: dict) -> dict:
    return {
        "title": d.get("title"), "subtitle": d.get("subtitle"),
        "authors": names(d.get("authors")),
        "seriesName": d.get("seriesName"), "seriesIndex": norm_index(d.get("seriesIndex")),
        "publishedYear": d.get("publishedYear"), "language": d.get("language"),
    }


def files_of(d: dict) -> list:
    return [[f.get("filename"), f.get("sizeBytes")] for f in d.get("files") or []
            if isinstance(f, dict)]


def audible_of(d: dict):
    return (d.get("providerIds") or {}).get("audible") or d.get("audibleId")


def tag_names(d: dict) -> list:
    return [t.get("name") if isinstance(t, dict) else t for t in d.get("tags") or []
            if (t.get("name") if isinstance(t, dict) else t)]


def safe_segment(value, what: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{what} {value!r} is not a usable folder name")
    if "/" in value or "\\" in value or value in (".", "..") or value.startswith("."):
        raise ValueError(f"{what} {value!r} is not a usable folder name")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ValueError(f"{what} contains control characters")
    return value


def create_metadata(md, arrival) -> dict:
    """PATCH keys confirmed against /config/books/scripts (see report):
    title, subtitle, authors, seriesName, seriesIndex (string), publishedYear,
    language, audibleId, tags. Narrators are NOT sent (no confirmed key)."""
    meta = {"title": md["title"], "authors": list(md["authors"])}
    if md.get("subtitle"):
        meta["subtitle"] = md["subtitle"]
    if md.get("series"):
        meta["seriesName"] = md["series"]
        if md.get("seriesIndex") is not None:
            meta["seriesIndex"] = norm_index(md["seriesIndex"])
    if md.get("publishedYear") is not None:
        meta["publishedYear"] = int(md["publishedYear"])
    if md.get("language"):
        meta["language"] = md["language"]
    sid = arrival.get("source_id")
    audible = md.get("audibleId")
    if arrival.get("source") == "libation" and isinstance(sid, str) and ASIN_RE.match(sid):
        audible = sid            # the file's own Audible id beats the model's
    if audible:
        meta["audibleId"] = audible
    asin_tag = md.get("asinTag")
    if arrival.get("source") == "kindle" and isinstance(sid, str) and ASIN_RE.match(sid):
        asin_tag = sid
    return {"fields": meta, "asin_tag": asin_tag}
