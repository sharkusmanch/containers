"""Sentence fragments over the reference text, cut at text-node boundaries so
each fragment can be wrapped in exactly one <span id>."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from lxml import etree

from app.textmap import DocMap, TextMapError, XHTML_NS

ABBREV = {"mr", "mrs", "ms", "dr", "st", "sr", "jr", "prof", "vs", "etc", "mt", "ft", "no",
          "vol", "ch", "capt", "gen", "col", "lt", "sgt", "rev", "hon", "messrs", "mme", "mlle",
          "e.g", "i.e", "cf", "approx"}
_BOUNDARY = re.compile(r"[.!?…]+[\"'”’)\]]*(?=\s)")
_WORD_BEFORE = re.compile(r"([A-Za-z][A-Za-z.]*)$")


@dataclass
class Fragment:
    id: str
    doc_index: int
    slot_index: int
    start: int
    end: int
    c0: int
    c1: int


def sentence_spans(text: str) -> list[tuple[int, int]]:
    spans, start = [], 0
    for m in _BOUNDARY.finditer(text):
        if m.group(0)[0] == ".":
            wm = _WORD_BEFORE.search(text[start:m.start()])
            if wm:
                w = wm.group(1).lower().rstrip(".")
                if w in ABBREV or len(w) == 1:
                    continue
        spans.append((start, m.end()))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return [(a, b) for a, b in spans if text[a:b].strip()]


def _container(slot) -> etree._Element:
    return slot.element if slot.kind == "text" else slot.element.getparent()


def _voiceable(doc: DocMap, si: int) -> bool:
    el = _container(doc.slots[si])
    if el is None or not isinstance(el.tag, str):
        return False
    ns = etree.QName(el).namespace
    root_ns = etree.QName(doc.tree.getroot()).namespace
    return ns == root_ns or ns == XHTML_NS


def fragments(doc: DocMap) -> list[Fragment]:
    out: list[Fragment] = []
    n = 0
    for a, b in sentence_spans(doc.ref_text):
        groups: list[list[int]] = []  # [slot, first_off, last_off, first_ref, last_ref]
        for k in range(a, b):
            e = doc.ref_to_edit[k]
            if e < 0:
                continue
            si, off = doc.edit_slot[e]
            if groups and groups[-1][0] == si:
                groups[-1][2] = off
                groups[-1][4] = k
            else:
                groups.append([si, off, off, k, k])
        for si, o0, o1, k0, k1 in groups:
            if not _voiceable(doc, si):
                continue
            out.append(Fragment(f"ra-{doc.index}-{n}", doc.index, si, o0, o1 + 1,
                                doc.ref_start + k0, doc.ref_start + k1 + 1))
            n += 1
    return out


def wrap(doc: DocMap, frags: list[Fragment]) -> None:
    root = doc.tree.getroot()
    ns = etree.QName(root).namespace
    tag = f"{{{ns}}}span" if ns else "span"
    existing = {e.get("id") for e in root.iter() if isinstance(e.tag, str) and e.get("id")}
    by_slot: dict[int, list[Fragment]] = defaultdict(list)
    for f in frags:
        if f.id in existing:
            raise TextMapError("id_collision", f.id)
        by_slot[f.slot_index].append(f)
    for si, fs in by_slot.items():
        slot = doc.slots[si]
        value = slot.value
        fs.sort(key=lambda f: f.start)
        spans = []
        for i, f in enumerate(fs):
            sp = etree.Element(tag)
            sp.set("id", f.id)
            sp.text = value[f.start:f.end]
            nxt = fs[i + 1].start if i + 1 < len(fs) else len(value)
            sp.tail = value[f.end:nxt] or None
            spans.append(sp)
        lead = value[:fs[0].start] or None
        if slot.kind == "text":
            slot.element.text = lead
            for i, sp in enumerate(spans):
                slot.element.insert(i, sp)
        else:
            parent = slot.element.getparent()
            idx = parent.index(slot.element)
            slot.element.tail = lead
            for i, sp in enumerate(spans):
                parent.insert(idx + 1 + i, sp)
