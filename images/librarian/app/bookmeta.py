"""Pure BookOrbit metadata helpers for the executor (no I/O).

Split out of app/executor.py to keep it reviewable. PATCH keys used here are
only those confirmed by earlier successful writes in /config/books/scripts:
title, subtitle, authors (list of names), seriesName, seriesIndex (a STRING,
e.g. "2" / "2.5"), publishedYear (int), language, audibleId, tags (list of
names). `narrators` is deliberately NOT written -- no confirmed PATCH key.
"""
import re

from app.bo_render import normalize_authors, normalize_metadata_text
from app.policy import _format_index

ASIN_RE = re.compile(r"^[A-Za-z0-9]{10,13}$")

IDENTITY = ("title", "subtitle", "authors", "seriesName", "seriesIndex", "publishedYear", "language")

# Task 9c (b): every identity field the librarian sets or restores is locked
# (overrides P1's "series stays unlocked"): BookOrbit's post-import provider
# fetch overwrites unlocked fields (it gave the Task 9b probe book a bogus
# series), and locked fields hold across rescans. lockedFields REPLACES the
# set server-side; BookorbitWriter.patch_metadata merges with the current one.
IDENTITY_LOCKS = IDENTITY
BASE_LOCKS = ("title", "subtitle", "description")
CREATE_LOCKS = tuple(dict.fromkeys(BASE_LOCKS + IDENTITY_LOCKS))


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


def render_identity(d: dict) -> dict:
    """identity() with the STORED seriesIndex string untouched -- BookOrbit
    renders "2.50" as "02.50.", so it must never be rewritten to "2.5"
    before rendering (or restoring). Use identity()/norm_for_compare for
    comparisons."""
    return dict(identity(d), seriesIndex=d.get("seriesIndex"))


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
    # Task 9c (c): EVERY identity field is sent, null when absent -- null
    # clears whatever the post-import provider fetch wrote (live: a bogus
    # series). The index only travels with a series (policy.render_intent_folder
    # renders the same mapping for guard 8).
    # authors and seriesName go through BookOrbit's normalizeMetadataText on
    # store (Task 9c fix round 1): send them normalised so what we render,
    # send and read back are the same strings.
    series = normalize_metadata_text(md.get("series"))
    year = md.get("publishedYear")
    meta = {
        "title": md["title"], "authors": normalize_authors(md["authors"]),
        "subtitle": md.get("subtitle") or None,
        "seriesName": series,
        "seriesIndex": norm_index(md.get("seriesIndex")) if series else None,
        "publishedYear": int(year) if year is not None else None,
        "language": md.get("language") or None,
    }
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


_UPDATE_METADATA_SIMPLE_FIELDS = ("title", "subtitle", "authors", "language", "audibleId")


def update_metadata_fields(md: dict) -> dict:
    """Map an update_metadata intent's LLM-facing metadata keys to
    BookOrbit's PATCH body key names -- the same `series`/`seriesIndex`
    mapping `create_metadata` uses, but with none of its arrival-derived
    overrides (no Audible/Kindle-ASIN injection, no tag): update_metadata
    corrects a book that already exists, it never derives identity from a
    brand-new arrival's own file. `narrators` and `asinTag` are silently
    dropped -- narrators has no confirmed PATCH key (see the module
    docstring above) and an asin tag only makes sense for a NEW arrival's
    own file, which update_metadata never has."""
    meta = {}
    for field_name in _UPDATE_METADATA_SIMPLE_FIELDS:
        val = md.get(field_name)
        if val is not None:
            meta[field_name] = normalize_authors(val) if field_name == "authors" else val
    if md.get("series") is not None:
        meta["seriesName"] = normalize_metadata_text(md["series"])
    if md.get("seriesIndex") is not None:
        meta["seriesIndex"] = norm_index(md["seriesIndex"])
    if md.get("publishedYear") is not None:
        meta["publishedYear"] = int(md["publishedYear"])
    return meta


def _norm_str(v):
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def norm_for_compare(d: dict) -> dict:
    """Identity fields normalised for comparison only (never for writing), so
    a server echo like " Title " or seriesIndex "2.0" is not a change:
    strings stripped with empty -> None; authors a list of stripped names;
    seriesIndex a float (or None); publishedYear an int (or None). Only the
    IDENTITY keys present in `d` are returned. Unparseable numbers fall back
    to their stripped string so they still compare unequal to a real value."""
    out = {}
    for k in IDENTITY:
        if k not in d:
            continue
        v = d[k]
        if k == "authors":
            out[k] = [n for n in (_norm_str(x) for x in names(v)) if n]
        elif k == "seriesIndex":
            s = _norm_str(v)
            try:
                out[k] = float(s) if s is not None else None
            except ValueError:
                out[k] = s
        elif k == "publishedYear":
            s = _norm_str(v)
            try:
                out[k] = int(float(s)) if s is not None else None
            except ValueError:
                out[k] = s
        else:
            out[k] = _norm_str(v)
    return out
