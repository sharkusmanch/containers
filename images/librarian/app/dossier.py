"""Compact dossier builder: the JSON an LLM librarian reads to decide where
an arriving audiobook/ebook belongs.

Security model (see plan global constraints): anything that originated in a
file, a tag, a sidecar, or a remote API response is attacker-controllable and
must never appear as free text under `trusted` -- only closed-vocabulary
labels (kinds, bands, flags, hashes) computed FROM that text may live there.
Raw text always goes under `untrusted`.

`kids` is `app.policy.kids_signals` bound to a `KidsLists` (Task 7); this
module only calls it with keyword args and tolerates it being absent
(`None`) or returning a partial dict, so Task 6 has no import-time
dependency on Task 7.
"""
import hashlib
import json
import logging
import os
import re
import zipfile

from app.intake import primary_file
from app.media import ffprobe_json, probe_audio, read_epub
from app.titles import edition_flags, parse_series

logger = logging.getLogger(__name__)

SIZE_BUDGET_BYTES = 8192
_UNTRUSTED_STRING_CAP = 200
_MAX_CANDIDATES = 5

_PRIMARY_KINDS = {".m4b": "m4b", ".epub": "epub", ".cbz": "cbz"}
_TRAILING_BRACKET_RE = re.compile(r"\s*\[[^\]]*\]\s*$")


def _kind_of(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return _PRIMARY_KINDS.get(ext, "other")


def _name_hash(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8", "surrogateescape")).hexdigest()[:12]


def _short_reason(exc: Exception) -> str:
    return str(exc)[:_UNTRUSTED_STRING_CAP] or exc.__class__.__name__


def _title_from_folder(c) -> str:
    name = os.path.basename(c.path)
    if os.path.splitext(name)[1].lower() in (".epub", ".cbz", ".m4b"):
        name = os.path.splitext(name)[0]  # kindle/manual-file: strip the extension too
    return _TRAILING_BRACKET_RE.sub("", name).strip()


def _default_kids(**_kwargs) -> dict:
    return {"allow": [], "deny": []}


def _band(chars_per_sec: float | None) -> str:
    if chars_per_sec is None:
        return "n/a"
    if chars_per_sec < 11:
        return "low"
    if chars_per_sec > 17:
        return "high"
    return "ok"


def _agreement(arrival_index: float | None, candidate_index) -> str:
    if arrival_index is None or candidate_index is None:
        return "unknown"
    try:
        return "agree" if float(arrival_index) == float(candidate_index) else "disagree"
    except (TypeError, ValueError):
        return "unknown"


def build_dossier(key: str, c, sha: str, index, prober=ffprobe_json, kids=None,
                   previously_filed=None, claimed: dict | None = None) -> dict:
    prober = prober or ffprobe_json
    kids = kids or _default_kids
    claimed = claimed or {}

    pf = primary_file(c)
    folder_name = os.path.basename(c.path)

    trusted_files: list[dict] = []
    untrusted_files: list[dict] = []
    m4b_count = 0
    primary_type_count = 0

    text_sources: list[str | None] = []
    titles: list[str] = []
    authors: list[str] = []
    audible_asin = None
    kindle_asin = None
    isbn = None
    arrival_epub_char_count = None
    arrival_series_index = None
    arrival_series_name = None
    untrusted_epub = None

    if c.source == "libation":
        audible_asin = c.source_id
    if c.source == "kindle" and c.sidecar:
        kindle_asin = c.sidecar.get("asin")
        sidecar_title = c.sidecar.get("title")
        if sidecar_title:
            titles.append(sidecar_title)
        authors.extend(c.sidecar.get("authors") or [])

    folder_title = _title_from_folder(c)
    if folder_title:
        titles.append(folder_title)

    for f in c.files:
        name = os.path.basename(f)
        kind = _kind_of(name)
        try:
            size = os.path.getsize(f)
        except OSError:
            size = None
        is_primary = f == pf
        entry = {"name_hash": _name_hash(name), "kind": kind, "size": size, "primary": is_primary}

        if kind == "m4b":
            m4b_count += 1
        if kind in ("m4b", "epub", "cbz"):
            primary_type_count += 1

        if kind == "m4b":
            try:
                audio = probe_audio(f, prober)
            except Exception as e:  # ffprobe failure -- never crash the dossier
                entry["error"] = _short_reason(e)
                untrusted_files.append({"name": name})
            else:
                untrusted_files.append({
                    "name": name,
                    "duration_s": audio.duration_s,
                    "chapters": audio.chapters,
                    "first_chapters": list(audio.first_chapters),
                    "tags": dict(audio.tags),
                })
                text_sources.append(audio.tags.get("title"))
                text_sources.append(audio.tags.get("album"))
                text_sources.append(audio.tags.get("series"))
                if audio.tags.get("title"):
                    titles.append(audio.tags["title"])
                if audio.tags.get("album"):
                    titles.append(audio.tags["album"])
                if audio.tags.get("artist"):
                    authors.append(audio.tags["artist"])
                if not audible_asin:
                    audible_asin = audio.tags.get("audible_asin") or audio.tags.get("asin")

                if is_primary:
                    raw_series = audio.tags.get("series") or audio.tags.get("album")
                    arrival_series_name, series_number_from_text = parse_series(raw_series)
                    arrival_series_index = series_number_from_text
                    if audio.tags.get("series-part"):
                        try:
                            arrival_series_index = float(audio.tags["series-part"])
                        except (TypeError, ValueError):
                            pass
        elif kind == "epub":
            try:
                epub = read_epub(f)
            except (ValueError, OSError, zipfile.BadZipFile) as e:  # unreadable EPUB -- never crash the dossier
                entry["error"] = _short_reason(e)
                untrusted_files.append({"name": name})
            else:
                text_sources.append(epub.title)
                if epub.title:
                    titles.append(epub.title)
                authors.extend(epub.creators)
                if epub.identifiers.get("isbn") and not isbn:
                    isbn = epub.identifiers["isbn"]
                if untrusted_epub is None:  # first readable epub wins
                    untrusted_epub = {
                        "title": epub.title,
                        "creators": list(epub.creators),
                        "date": epub.date,
                        "identifiers": dict(epub.identifiers),
                        "description": epub.description,
                    }
                    arrival_epub_char_count = epub.char_count
        else:
            untrusted_files.append({"name": name})

        trusted_files.append(entry)

    edition = edition_flags(*text_sources, folder_name)

    multiple_primaries = (
        c.source == "manual" and os.path.isdir(c.path) and primary_type_count > 1
    )

    # --- candidate lookup + measures ---------------------------------------
    candidate_pairs = index.candidates(
        audible_asin=audible_asin, kindle_asin=kindle_asin, isbn=isbn,
        titles=titles, authors=authors, limit=8,
    )

    candidates_out = []
    measures_out = []
    for detail, reasons in candidate_pairs:
        book_id = detail.get("id")
        fresh_detail = index.detail(book_id, fresh=True) if book_id is not None else detail
        summary = index.summarize(fresh_detail)
        summary["claimed_by"] = claimed.get(summary.get("id"))
        candidates_out.append({"reasons": list(reasons), "book": summary})

        cand_m4b_duration = next(
            (fmt.get("duration_s") for fmt in summary.get("formats") or []
             if fmt.get("format") == "m4b" and fmt.get("duration_s")),
            None,
        )
        chars_per_sec = None
        if arrival_epub_char_count is not None and cand_m4b_duration:
            chars_per_sec = arrival_epub_char_count / cand_m4b_duration
        measures_out.append({
            "book_id": summary.get("id"),
            "chars_per_sec": round(chars_per_sec, 2) if chars_per_sec is not None else None,
            "band": _band(chars_per_sec),
            "series_index_agreement": _agreement(arrival_series_index, summary.get("series_index")),
        })

    # --- kids signals --------------------------------------------------------
    asins = tuple(a for a in (audible_asin, kindle_asin) if a)
    kids_result = kids(series=arrival_series_name, asins=asins, authors=tuple(authors)) or {}
    kids_out = {"allow": list(kids_result.get("allow", [])), "deny": list(kids_result.get("deny", []))}

    trusted = {
        "m4b_count": m4b_count,
        "files": trusted_files,
        "previously_filed": previously_filed,
        "edition_flags": edition,
        "measures": measures_out,
        "kids": kids_out,
    }
    if multiple_primaries:
        trusted["multiple_primaries"] = True

    dossier = {
        "key": key,
        "source": c.source,
        "source_id": c.source_id,
        "trusted": trusted,
        "untrusted": {
            "files": untrusted_files,
            "epub": untrusted_epub,
            "sidecar": c.sidecar,
            "folder_name": folder_name,
        },
        "candidates": candidates_out,
    }

    _shrink_to_budget(dossier)
    return dossier


def _size(dossier: dict) -> int:
    return len(json.dumps(dossier))


def _truncate_strings(node, cap: int):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str):
                if len(v) > cap:
                    node[k] = v[:cap]
            else:
                _truncate_strings(v, cap)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, str):
                if len(v) > cap:
                    node[i] = v[:cap]
            else:
                _truncate_strings(v, cap)


def _shrink_to_budget(dossier: dict) -> None:
    """Trim the dossier in the plan's specified order until it fits
    `SIZE_BUDGET_BYTES`, or give up and log -- this never raises."""
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    untrusted = dossier["untrusted"]
    if untrusted.get("epub") and untrusted["epub"].get("description") is not None:
        untrusted["epub"]["description"] = None
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    for f in untrusted.get("files", []):
        if "first_chapters" in f:
            f["first_chapters"] = f["first_chapters"][:1]
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    dossier["candidates"] = dossier["candidates"][:_MAX_CANDIDATES]
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    for cand in dossier["candidates"]:
        cand["book"].pop("formats", None)
        cand["book"].pop("narrators", None)
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    _truncate_strings(untrusted, _UNTRUSTED_STRING_CAP)
    if _size(dossier) <= SIZE_BUDGET_BYTES:
        return

    logger.warning("dossier %s still %d bytes after trimming (budget %d)",
                    dossier.get("key"), _size(dossier), SIZE_BUDGET_BYTES)
