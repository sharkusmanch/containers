"""Reproduce the alignment producer's text coordinates and map them onto an
editable XHTML tree.

Reference text = EbookLib's re-rendered document (item.get_content()) passed
through BeautifulSoup html.parser get_text(" ", strip=True), documents joined
with one space. This is NOT the raw file text: get_content() rebuilds <head>
with an empty <title> and keeps only <body>'s children, so <title> text and
text sitting directly in <body> are not counted.

The editable tree is the original bytes parsed as XML. The two are matched
character by character, ignoring whitespace on both sides; any other
difference refuses the book.
"""
from __future__ import annotations

import html.entities
import posixpath
import re
import zipfile
from dataclasses import dataclass
from urllib.parse import unquote

import ebooklib
from bs4 import BeautifulSoup
from ebooklib import epub
from lxml import etree

XHTML_NS = "http://www.w3.org/1999/xhtml"
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
SKIP_TAGS = {"script", "style"}
_XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
_ENTITY_RE = re.compile(rb"&([A-Za-z][A-Za-z0-9]*);")


class TextMapError(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


@dataclass
class Slot:
    element: etree._Element
    kind: str  # "text" or "tail"

    @property
    def value(self) -> str:
        v = self.element.text if self.kind == "text" else self.element.tail
        return v or ""


@dataclass
class DocMap:
    index: int
    zip_path: str
    href: str
    ref_start: int
    ref_text: str
    tree: etree._ElementTree
    slots: list[Slot]
    ref_to_edit: list[int]
    edit_slot: list[tuple[int, int]]


def localname(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def opf_path(zf: zipfile.ZipFile) -> str:
    root = etree.fromstring(zf.read("META-INF/container.xml"))
    rf = root.find(f".//{{{CONTAINER_NS}}}rootfile")
    if rf is None or not rf.get("full-path"):
        raise TextMapError("bad_container")
    return rf.get("full-path")


def reference_documents(epub_path) -> list[tuple[str, str]]:
    book = epub.read_epub(str(epub_path))
    out = []
    for ref in book.spine:
        item = book.get_item_with_id(ref[0])
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        text = BeautifulSoup(item.get_content(), "html.parser").get_text(separator=" ", strip=True)
        out.append((item.get_name(), text))
    return out


def reference_string(docs) -> str:
    return " ".join(t for _, t in docs)


def _xml_safe(raw: bytes) -> bytes:
    def sub(m):
        name = m.group(1).decode("ascii")
        if name in _XML_ENTITIES:
            return m.group(0)
        cp = html.entities.name2codepoint.get(name)
        return f"&#{cp};".encode("ascii") if cp is not None else m.group(0)
    return _ENTITY_RE.sub(sub, raw)


def parse_xhtml(raw: bytes) -> etree._ElementTree:
    parser = etree.XMLParser(recover=False, resolve_entities=False, huge_tree=True,
                             load_dtd=False, no_network=True)
    try:
        return etree.ElementTree(etree.fromstring(_xml_safe(raw), parser))
    except etree.XMLSyntaxError as e:
        raise TextMapError("xhtml_parse_error", str(e)) from e


def _body_slots(tree) -> list[Slot]:
    body = next((e for e in tree.getroot().iter() if localname(e) == "body"), None)
    if body is None:
        return []
    slots: list[Slot] = []

    def walk(el):
        if isinstance(el.tag, str) and localname(el) not in SKIP_TAGS:
            if el.text:
                slots.append(Slot(el, "text"))
            for ch in el:
                walk(ch)
        if el.tail:
            slots.append(Slot(el, "tail"))

    for child in body:  # body.text is dropped by get_content(); children's tails are kept
        walk(child)
    return slots


def _map(ref_text: str, slots: list[Slot], where: str):
    edit_chars: list[str] = []
    edit_slot: list[tuple[int, int]] = []
    for si, s in enumerate(slots):
        for off, ch in enumerate(s.value):
            edit_chars.append(ch)
            edit_slot.append((si, off))
    ref_to_edit = [-1] * len(ref_text)
    j, n = 0, len(edit_chars)
    for i, ch in enumerate(ref_text):
        if ch.isspace():
            continue
        while j < n and edit_chars[j].isspace():
            j += 1
        if j >= n or edit_chars[j] != ch:
            got = "".join(edit_chars[j:j + 20]) if j < n else "<end>"
            raise TextMapError("text_map_mismatch",
                               f"{where} at ref {i}: {ref_text[max(0, i - 10):i + 20]!r} vs {got!r}")
        ref_to_edit[i] = j
        j += 1
    while j < n and edit_chars[j].isspace():
        j += 1
    if j != n:
        raise TextMapError("text_map_mismatch", f"{where}: extra text {''.join(edit_chars[j:j + 40])!r}")
    return ref_to_edit, edit_slot


def build(epub_path, total_chars: int | None = None) -> list[DocMap]:
    refdocs = reference_documents(epub_path)
    maps: list[DocMap] = []
    with zipfile.ZipFile(epub_path) as zf:
        opf = opf_path(zf)
        opf_dir = posixpath.dirname(opf)
        names = set(zf.namelist())
        start = 0
        for idx, (href, text) in enumerate(refdocs):
            zp = posixpath.normpath(posixpath.join(opf_dir, unquote(href))) if opf_dir else unquote(href)
            if zp not in names:
                raise TextMapError("text_map_mismatch", f"document not in zip: {zp}")
            tree = parse_xhtml(zf.read(zp))
            slots = _body_slots(tree)
            r2e, es = _map(text, slots, zp)
            maps.append(DocMap(idx, zp, unquote(href), start, text, tree, slots, r2e, es))
            start += len(text) + 1
    total = start - 1 if refdocs else 0
    if total_chars is not None and total != total_chars:
        raise TextMapError("text_mismatch", f"{total} != {total_chars}")
    return maps
