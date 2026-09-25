"""Pure BookOrbit metadata helpers for the executor (no I/O).

Split out of app/executor.py to keep it reviewable. PATCH keys used here are
only those confirmed by earlier successful writes in /config/books/scripts:
title, subtitle, authors (list of names), seriesName, seriesIndex (a STRING,
e.g. "2" / "2.5"), publishedYear (int), language, audibleId, tags (list of
names). `narrators` is deliberately NOT written -- no confirmed PATCH key.
"""
import math
import re

from app import umbrella
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

# Task 11: create_book writes a language / publishedYear only when it is
# plausible -- the intent's own value first, else the arrival's EPUB OPF
# (dossier `untrusted.epub`, untrusted text) -- and otherwise leaves the
# field out. A language (fix round 1, I1) has "_" normalised to "-", then
# is an ASCII BCP-47 shape ("en", "en-US", "es-419", "zh-Hant-TW") or a
# plain ASCII language name ("English", "Old English"), 2-20 chars; a
# primary subtag "und" (BCP-47 "undetermined") is no language. A year lies
# within [1000, 2200]; from a dc:date it is the first free-standing 4-digit
# group (calibre writes 0101-01-01 for "no date").
_BCP47_RE = re.compile(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*")
_LANGUAGE_NAME_RE = re.compile(r"[A-Za-z]+(?:[- ][A-Za-z]+)*")
LANGUAGE_MIN, LANGUAGE_MAX = 2, 20
_NOT_A_LANGUAGE = frozenset({"und"})
_YEAR_RE = re.compile(r"(?<!\d)(\d{4})(?!\d)")
YEAR_MIN, YEAR_MAX = 1000, 2200


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


def plausible_language(value) -> str | None:
    """`value` stripped and with "_" -> "-", if it reads as a language tag
    or name (see _BCP47_RE / _LANGUAGE_NAME_RE); else None."""
    if not isinstance(value, str):
        return None
    v = value.strip().replace("_", "-")
    if not LANGUAGE_MIN <= len(v) <= LANGUAGE_MAX:
        return None
    if not (_BCP47_RE.fullmatch(v) or _LANGUAGE_NAME_RE.fullmatch(v)):
        return None
    if re.split(r"[- ]", v, maxsplit=1)[0].casefold() in _NOT_A_LANGUAGE:
        return None
    return v


def plausible_year(value) -> int | None:
    """A year given as a number (the intent's publishedYear) as an int, if
    within [YEAR_MIN, YEAR_MAX]; else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    year = int(value)
    return year if YEAR_MIN <= year <= YEAR_MAX else None


def opf_year(value) -> int | None:
    """The first free-standing 4-digit year in an OPF dc:date ("2011",
    "2011-06-07T04:00:00+00:00", "06/07/2011") if plausible, else None."""
    if not isinstance(value, str):
        return None
    m = _YEAR_RE.search(value)
    return plausible_year(int(m.group(1))) if m else None


def create_metadata(md, arrival, epub=None) -> dict:
    """PATCH keys confirmed against /config/books/scripts (see report):
    title, subtitle, authors, seriesName, seriesIndex (string), publishedYear,
    language, audibleId, tags. Narrators are NOT sent (no confirmed key).
    `epub` is the arrival's EPUB OPF metadata (dossier `untrusted.epub`:
    `language`, `date`, ...), or None for an audio-only arrival. `dropped`
    lists the intent values found implausible (for the caller to log)."""
    # Task 9c (c): subtitle, seriesName and seriesIndex are sent null when
    # absent -- null clears whatever the post-import provider fetch wrote
    # (live: a bogus series) -- and locked like every identity field written.
    # The index only travels with a series (policy.render_intent_folder
    # renders the same mapping for guard 8).
    # Task 11: publishedYear and language are the exception. Absent from the
    # intent -- or implausible there (fix round 1, M6: dropped, never failing
    # the filing) -- they come from the arrival's own OPF when plausible,
    # else they are LEFT OUT: neither null nor locked (create_locks), rather
    # than a locked null (the go-live canary's EPUB said "en"). Accepted
    # cost: a provider-fetched year/language stays on a book whose EPUB
    # lacks them.
    # authors and seriesName go through BookOrbit's normalizeMetadataText on
    # store (Task 9c fix round 1): send them normalised so what we render,
    # send and read back are the same strings.
    series = normalize_metadata_text(md.get("series"))
    meta = {
        "title": md["title"], "authors": normalize_authors(md["authors"]),
        "subtitle": md.get("subtitle") or None,
        "seriesName": series,
        "seriesIndex": norm_index(md.get("seriesIndex")) if series else None,
    }
    opf = epub if isinstance(epub, dict) else {}
    dropped = []
    language = None
    if md.get("language"):
        language = plausible_language(md["language"])
        if language is None:
            dropped.append(f"language {md['language']!r}")
    if language is None:
        language = plausible_language(opf.get("language"))
    if language is not None:
        meta["language"] = language
    year = None
    if md.get("publishedYear") is not None:
        year = plausible_year(md["publishedYear"])
        if year is None:
            dropped.append(f"publishedYear {md['publishedYear']!r}")
    if year is None:
        year = opf_year(opf.get("date"))
    if year is not None:
        meta["publishedYear"] = year
    sid = arrival.get("source_id")
    audible = md.get("audibleId")
    if arrival.get("source") == "libation" and isinstance(sid, str) and ASIN_RE.match(sid):
        audible = sid            # the file's own Audible id beats the model's
    if audible:
        meta["audibleId"] = audible
    asin_tag = md.get("asinTag")
    if arrival.get("source") == "kindle" and isinstance(sid, str) and ASIN_RE.match(sid):
        asin_tag = sid
    return {"fields": meta, "asin_tag": asin_tag, "dropped": dropped}


def create_memberships(fields) -> list:
    """The `seriesMemberships` list a create_book PATCH carries alongside the
    scalar seriesName/seriesIndex (which BookOrbit then ignores, but which the
    locks, guard 8 and the read-back still key on). Built at PATCH time from
    the journaled `fields`, so a filing resumed across an upgrade gets it too.

    - no series -> []: clears every membership. A scalar seriesName null would
      instead PROMOTE a second membership (from the file or a provider fetch) to
      primary, mirror it into seriesName and move the folder;
    - else the series, plus its umbrella (app.umbrella) with no position -- the
      position is looked up by hand, never invented.
    Only seriesName/seriesIndex per entry: an `expectedBookCount` -- even null --
    rewrites that count for the whole series."""
    series = fields.get("seriesName")
    if not series:
        return []
    out = [{"seriesName": series, "seriesIndex": fields.get("seriesIndex")}]
    u = umbrella.umbrella_for(series)
    if u and umbrella.key(u) != umbrella.key(series):
        out.append({"seriesName": u, "seriesIndex": None})
    return out


def _index_value(v):
    s = _norm_str(v)
    try:
        return float(s) if s is not None else None
    except ValueError:
        return s


def memberships_match(d: dict, want: list) -> bool:
    """A GET detail holds exactly the memberships `want`, in order. Names by
    BookOrbit's series key: a membership shows its series row's name, whose
    first-created casing wins over what was sent. Indexes as numbers."""
    got = umbrella.memberships(d)
    return len(got) == len(want) and all(
        umbrella.key(n) == umbrella.key(w.get("seriesName"))
        and _index_value(i) == _index_value(w.get("seriesIndex"))
        for (n, i), w in zip(got, want))


def create_locks(fields) -> set:
    """The locks a create_book PATCH asks for: BASE_LOCKS plus every identity
    field in `fields` -- i.e. CREATE_LOCKS minus an identity field
    create_metadata left out (Task 11: omitted = neither written nor locked)."""
    return {f for f in CREATE_LOCKS if f in BASE_LOCKS or f in fields}


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
