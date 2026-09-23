"""ffprobe wrapper and EPUB metadata/text/search.

`ffprobe_json` is the only piece that shells out; everything else is pure and
takes an injected `Prober` in tests (ffprobe isn't installed on daedalus --
only in the built image), or reads a real EPUB zip on disk.
"""
import json
import re
import subprocess
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote
from xml.etree import ElementTree as ET

Prober = Callable[[str], dict]

_OPF_NS = "http://www.idpf.org/2007/opf"
_DC_NS = "http://purl.org/dc/elements/1.1/"
_NS = {"opf": _OPF_NS, "dc": _DC_NS}
_CONTAINER_NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}

_WS_RE = re.compile(r"\s+")
_DESCRIPTION_MAX = 500
_SNIPPET_RADIUS = 120


def ffprobe_json(path: str) -> dict:
    """Run ffprobe and parse its JSON output. Only exercised in the built
    image -- daedalus has no ffprobe binary, so tests inject a fake Prober."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_chapters", path],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return json.loads(result.stdout)


# --- audio ---------------------------------------------------------------

_ALLOWED_AUDIO_TAGS = frozenset({
    "title", "album", "artist", "album_artist", "series", "series-part",
    "audible_asin", "asin", "narrator", "genre", "date",
})


@dataclass
class AudioInfo:
    duration_s: float | None
    chapters: int
    first_chapters: list[str]
    tags: dict[str, str]


def probe_audio(path: str, prober: Prober = ffprobe_json) -> AudioInfo:
    data = prober(path) or {}
    fmt = data.get("format") or {}

    duration_s = None
    raw_duration = fmt.get("duration")
    if raw_duration not in (None, ""):
        try:
            duration_s = float(raw_duration)
        except (TypeError, ValueError):
            duration_s = None

    raw_tags = fmt.get("tags") or {}
    tags = {k.lower(): v for k, v in raw_tags.items() if k.lower() in _ALLOWED_AUDIO_TAGS}

    chapters = data.get("chapters") or []
    chapter_titles = [
        title
        for ch in chapters
        if (title := (ch.get("tags") or {}).get("title"))
    ]

    return AudioInfo(
        duration_s=duration_s,
        chapters=len(chapters),
        first_chapters=chapter_titles[:3],
        tags=tags,
    )


# --- epub ------------------------------------------------------------------

@dataclass
class EpubInfo:
    title: str | None
    creators: list[str]
    date: str | None
    language: str | None
    identifiers: dict[str, str]
    description: str | None
    char_count: int


class _VisibleTextExtractor(HTMLParser):
    """Collects text data outside <script>/<style>, nesting-aware so a
    <script> inside a <style> (or vice versa, however unlikely) still skips
    correctly."""

    _SKIPPED = frozenset({"script", "style"})

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIPPED:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self._SKIPPED and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._parts.append(data)

    def text(self) -> str:
        return "".join(self._parts)


def _opf_path(zf: zipfile.ZipFile) -> str:
    with zf.open("META-INF/container.xml") as f:
        tree = ET.parse(f)
    rootfile = tree.find(".//c:rootfile", _CONTAINER_NS)
    full_path = rootfile.get("full-path") if rootfile is not None else None
    if not full_path:
        raise ValueError("unreadable EPUB: container.xml has no rootfile")
    return full_path


def _el_text(el) -> str | None:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


_URN_RE = re.compile(r"^urn:([A-Za-z0-9.+-]+):(.+)$", re.IGNORECASE)
_ISBN13_RE = re.compile(r"^\d{13}$")
_ISBN10_RE = re.compile(r"^\d{9}[\dXx]$")
# Amazon ASINs are 10-char alphanumeric (commonly "B0..." for audiobooks/
# ebooks); require at least one letter so a plain 10-digit ISBN-10 (already
# handled above) is never misclassified as an ASIN.
_ASIN_RE = re.compile(r"^(?=.*[A-Za-z])[A-Za-z0-9]{10}$")


def _is_isbn(value: str) -> bool:
    stripped = re.sub(r"[-\s]", "", value)
    return bool(_ISBN13_RE.match(stripped) or _ISBN10_RE.match(stripped))


def _is_asin(value: str) -> bool:
    return bool(_ASIN_RE.match(value))


def _classify_identifier(ident_id: str | None, scheme_attr: str | None, raw_value: str) -> tuple[str, str] | None:
    """Best-effort (scheme, value) for a `dc:identifier` element.

    `opf:scheme` is optional in EPUB2, and several real-world producers omit
    it: `urn:isbn:`/`urn:uuid:`-prefixed values, bare ISBNs, and Amazon-style
    ASINs are all common in the wild (calibre, in particular, always sets
    opf:scheme, but plenty of others don't). Falls back to the element's
    `id` attribute, then "unknown", rather than dropping the identifier.
    """
    value = raw_value.strip()
    if not value:
        return None

    if scheme_attr:
        return scheme_attr.strip().lower(), value

    m = _URN_RE.match(value)
    if m:
        return m.group(1).lower(), m.group(2).strip()

    if _is_isbn(value):
        return "isbn", value
    if _is_asin(value):
        return "asin", value

    return (ident_id.strip().lower() if ident_id else "unknown"), value


# dc:date opf:event values (EPUB2) that date the BOOK's publication. No event
# at all is the common case (calibre, and EPUB3 has no opf:event: its only
# dc:date is the publication date); creation/modification/... date the FILE.
_PUBLICATION_EVENTS = frozenset({"", "publication", "original-publication"})


def _publication_date(metadata) -> str | None:
    """The first dc:date dating the publication (see _PUBLICATION_EVENTS),
    in document order; None when there are only file dates (Task 11 fix
    round 1, M5: they must never become create_book's publishedYear)."""
    if metadata is None:
        return None
    for el in metadata.findall("dc:date", _NS):
        event = el.get(f"{{{_OPF_NS}}}event") or el.get("event") or ""
        if event.strip().lower() in _PUBLICATION_EVENTS:
            text = _el_text(el)
            if text:
                return text
    return None


def _parse_opf(zf: zipfile.ZipFile, opf_path: str) -> tuple[dict, list[str]]:
    with zf.open(opf_path) as f:
        root = ET.parse(f).getroot()

    metadata = root.find("opf:metadata", _NS)

    title = _el_text(metadata.find("dc:title", _NS)) if metadata is not None else None
    creators = (
        [c.text.strip() for c in metadata.findall("dc:creator", _NS) if c.text and c.text.strip()]
        if metadata is not None
        else []
    )
    date = _publication_date(metadata)
    language = _el_text(metadata.find("dc:language", _NS)) if metadata is not None else None
    description = _el_text(metadata.find("dc:description", _NS)) if metadata is not None else None
    if description and len(description) > _DESCRIPTION_MAX:
        description = description[:_DESCRIPTION_MAX]

    identifiers: dict[str, str] = {}
    if metadata is not None:
        for ident in metadata.findall("dc:identifier", _NS):
            scheme_attr = ident.get(f"{{{_OPF_NS}}}scheme")
            classified = _classify_identifier(ident.get("id"), scheme_attr, ident.text or "")
            if classified:
                key, value = classified
                identifiers.setdefault(key, value)  # first one wins, never overwritten

    manifest: dict[str, str] = {}
    manifest_el = root.find("opf:manifest", _NS)
    if manifest_el is not None:
        for item in manifest_el.findall("opf:item", _NS):
            item_id, href = item.get("id"), item.get("href")
            if item_id and href:
                manifest[item_id] = href

    spine_hrefs: list[str] = []
    spine_el = root.find("opf:spine", _NS)
    if spine_el is not None:
        for itemref in spine_el.findall("opf:itemref", _NS):
            href = manifest.get(itemref.get("idref"))
            if href:
                spine_hrefs.append(href)

    info = {
        "title": title,
        "creators": creators,
        "date": date,
        "language": language,
        "description": description,
        "identifiers": identifiers,
    }
    return info, spine_hrefs


def _spine_text(zf: zipfile.ZipFile, base_dir: str, hrefs: list[str]) -> str:
    parts = []
    for href in hrefs:
        # Manifest hrefs are URLs and may be percent-encoded (e.g. a space
        # in the filename as "%20") -- the zip entry itself never is.
        href = unquote(href)
        path = f"{base_dir}/{href}" if base_dir else href
        try:
            with zf.open(path) as f:
                raw = f.read().decode("utf-8", errors="replace")
        except KeyError:
            continue
        extractor = _VisibleTextExtractor()
        extractor.feed(raw)
        parts.append(extractor.text())
    return _WS_RE.sub(" ", " ".join(parts)).strip()


def _read(path: str) -> tuple[dict, str]:
    with zipfile.ZipFile(path) as zf:
        opf_path = _opf_path(zf)
        base_dir = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""
        info, spine_hrefs = _parse_opf(zf, opf_path)
        text = _spine_text(zf, base_dir, spine_hrefs)
    return info, text


def read_epub(path: str) -> EpubInfo:
    info, text = _read(path)
    return EpubInfo(
        title=info["title"],
        creators=info["creators"],
        date=info["date"],
        language=info["language"],
        identifiers=info["identifiers"],
        description=info["description"],
        char_count=len(text),
    )


def epub_text(path: str) -> str:
    _, text = _read(path)
    return text


def search_epub(path: str, query: str, max_hits: int = 10) -> list[dict]:
    if not query:
        return []
    text = epub_text(path)
    n = len(text)
    if n == 0:
        return []

    lower_text, lower_query = text.lower(), query.lower()
    hits: list[dict] = []
    start = 0
    while len(hits) < max_hits:
        idx = lower_text.find(lower_query, start)
        if idx == -1:
            break
        snippet = text[max(0, idx - _SNIPPET_RADIUS): min(n, idx + len(query) + _SNIPPET_RADIUS)]
        hits.append({"snippet": snippet, "percent": (idx / n) * 100})
        start = idx + len(lower_query)
    return hits
