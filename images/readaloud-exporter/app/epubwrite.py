"""Write an EPUB 3 readaloud: the source book plus span ids, SMIL overlays,
embedded audio, a highlight stylesheet and (if absent) a nav document.
The spine is never changed."""
from __future__ import annotations

import posixpath
import zipfile
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote

from lxml import etree

from app.textmap import DocMap, opf_path
from app.timing import AudioFile, Par, file_index

OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"
OPS_NS = "http://www.idpf.org/2007/ops"
SMIL_NS = "http://www.w3.org/ns/SMIL"
XHTML_NS = "http://www.w3.org/1999/xhtml"
ACTIVE_CLASS = "-epub-media-overlay-active"
CSS = f".{ACTIVE_CLASS} {{ background-color: #ffb; }}\n".encode()
CSS_HREF = "Styles/ra-readaloud.css"
AUDIO_DIR = "Audio"
SMIL_DIR = "MediaOverlays"


def fmt_clock(ms: int) -> str:
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    return f"{h}:{m:02d}:{rem / 1000:06.3f}"


def _q(tag, ns=OPF_NS):
    return f"{{{ns}}}{tag}"


def _smil(seq_id: str, doc_rel: str, items) -> bytes:
    root = etree.Element(_q("smil", SMIL_NS), nsmap={None: SMIL_NS, "epub": OPS_NS})
    root.set("version", "3.0")
    body = etree.SubElement(root, _q("body", SMIL_NS))
    seq = etree.SubElement(body, _q("seq", SMIL_NS))
    seq.set("id", seq_id)
    seq.set(_q("textref", OPS_NS), doc_rel)
    seq.set(_q("type", OPS_NS), "chapter")
    for frag_id, audio_rel, b, e in items:
        par = etree.SubElement(seq, _q("par", SMIL_NS))
        par.set("id", f"p-{frag_id}")
        tx = etree.SubElement(par, _q("text", SMIL_NS))
        tx.set("src", f"{doc_rel}#{frag_id}")
        au = etree.SubElement(par, _q("audio", SMIL_NS))
        au.set("src", audio_rel)
        au.set("clipBegin", f"{b / 1000:.3f}s")
        au.set("clipEnd", f"{e / 1000:.3f}s")
    return etree.tostring(root, xml_declaration=True, encoding="utf-8")


def _nav_from_ncx(ncx_bytes: bytes | None, ncx_dir: str, spine_hrefs: list[str]) -> bytes:
    html = etree.Element(_q("html", XHTML_NS), nsmap={None: XHTML_NS, "epub": OPS_NS})
    head = etree.SubElement(html, _q("head", XHTML_NS))
    etree.SubElement(head, _q("title", XHTML_NS)).text = "Contents"
    body = etree.SubElement(html, _q("body", XHTML_NS))
    nav = etree.SubElement(body, _q("nav", XHTML_NS))
    nav.set(_q("type", OPS_NS), "toc")
    ol = etree.SubElement(nav, _q("ol", XHTML_NS))

    def add(parent_ol, label, href):
        li = etree.SubElement(parent_ol, _q("li", XHTML_NS))
        a = etree.SubElement(li, _q("a", XHTML_NS))
        a.set("href", href)
        a.text = label
        return li

    def walk(nav_point, parent_ol):
        label = "".join(nav_point.find(_q("navLabel", NCX_NS)).itertext()).strip() or "Section"
        src = nav_point.find(_q("content", NCX_NS)).get("src")
        href = posixpath.normpath(posixpath.join(ncx_dir, src)) if ncx_dir else src
        li = add(parent_ol, label, href)
        kids = nav_point.findall(_q("navPoint", NCX_NS))
        if kids:
            sub = etree.SubElement(li, _q("ol", XHTML_NS))
            for k in kids:
                walk(k, sub)

    points = []
    if ncx_bytes:
        nm = etree.fromstring(ncx_bytes).find(_q("navMap", NCX_NS))
        points = nm.findall(_q("navPoint", NCX_NS)) if nm is not None else []
    if points:
        for p in points:
            walk(p, ol)
    else:
        for i, h in enumerate(spine_hrefs):
            add(ol, f"Section {i + 1}", h)
    return etree.tostring(html, xml_declaration=True, encoding="utf-8", doctype="<!DOCTYPE html>")


def write_readaloud(src_epub, dst, docs: list[DocMap], pars: list[Par], files: list[AudioFile],
                    audio_paths: dict[str, Path], modified: str) -> None:
    by_doc: dict[int, list[Par]] = defaultdict(list)
    for p in pars:
        by_doc[p.doc_index].append(p)
    with zipfile.ZipFile(src_epub) as zf:
        opf_zip = opf_path(zf)
        opf_dir = posixpath.dirname(opf_zip)
        z = lambda href: posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
        opf = etree.fromstring(zf.read(opf_zip))
        opf.set("version", "3.0")
        metadata = opf.find(_q("metadata"))
        manifest = opf.find(_q("manifest"))
        items = list(manifest.iter(_q("item")))
        by_href = {unquote(i.get("href")): i for i in items}
        ids = {i.get("id") for i in items}
        new_entries: dict[str, tuple[bytes | Path, int]] = {}

        def add_item(item_id, href, media_type, props=None):
            if item_id in ids or href in by_href:
                raise ValueError(f"manifest collision: {item_id} {href}")
            el = etree.SubElement(manifest, _q("item"))
            el.set("id", item_id)
            el.set("href", href)
            el.set("media-type", media_type)
            if props:
                el.set("properties", props)
            ids.add(item_id)

        def add_meta(prop, value, refines=None):
            m = etree.SubElement(metadata, _q("meta"))
            m.set("property", prop)
            if refines:
                m.set("refines", refines)
            m.text = value

        for m in [m for m in metadata.iter(_q("meta")) if m.get("property") == "dcterms:modified"]:
            metadata.remove(m)
        add_meta("dcterms:modified", modified)

        for f in files:
            add_item(f"ra-audio-{f.name[3:7]}", f"{AUDIO_DIR}/{f.name}", "audio/mp4")
            new_entries[z(f"{AUDIO_DIR}/{f.name}")] = (audio_paths[f.name], zipfile.ZIP_STORED)
        add_item("ra-css", CSS_HREF, "text/css")
        new_entries[z(CSS_HREF)] = (CSS, zipfile.ZIP_DEFLATED)

        total_ms = 0
        replaced_docs: dict[str, bytes] = {}
        for d in docs:
            dpars = by_doc.get(d.index)
            if not dpars:
                continue
            smil_id = f"ra-smil-{d.index:04d}"
            smil_href = f"{SMIL_DIR}/ra-{d.index:04d}.smil"
            doc_rel = posixpath.relpath(d.href, SMIL_DIR)
            smil_items = []
            for p in dpars:
                fi = files[file_index(files, p.begin)]
                smil_items.append((p.frag_id, posixpath.relpath(f"{AUDIO_DIR}/{fi.name}", SMIL_DIR),
                                   p.begin - fi.start, p.end - fi.start))
            dur = sum(p.end - p.begin for p in dpars)
            total_ms += dur
            add_item(smil_id, smil_href, "application/smil+xml")
            add_meta("media:duration", fmt_clock(dur), refines=f"#{smil_id}")
            new_entries[z(smil_href)] = (_smil(f"ra-seq-{d.index:04d}", doc_rel, smil_items), zipfile.ZIP_DEFLATED)
            doc_item = by_href.get(d.href)
            if doc_item is None:
                raise ValueError(f"no manifest item for {d.href}")
            doc_item.set("media-overlay", smil_id)
            root = d.tree.getroot()
            ns = etree.QName(root).namespace
            head = next((e for e in root if isinstance(e.tag, str) and etree.QName(e).localname == "head"), None)
            if head is None:
                head = etree.Element(f"{{{ns}}}head" if ns else "head")
                root.insert(0, head)
            link = etree.SubElement(head, f"{{{ns}}}link" if ns else "link")
            link.set("rel", "stylesheet")
            link.set("type", "text/css")
            link.set("href", posixpath.relpath(CSS_HREF, posixpath.dirname(d.href) or "."))
            replaced_docs[d.zip_path] = etree.tostring(d.tree, xml_declaration=True, encoding="utf-8")

        add_meta("media:duration", fmt_clock(total_ms))
        add_meta("media:active-class", ACTIVE_CLASS)

        if not any("nav" in (i.get("properties") or "").split() for i in manifest.iter(_q("item"))):
            ncx_item = next((i for i in items if i.get("media-type") == "application/x-dtbncx+xml"), None)
            ncx_bytes = zf.read(z(unquote(ncx_item.get("href")))) if ncx_item is not None else None
            ncx_dir = posixpath.dirname(unquote(ncx_item.get("href"))) if ncx_item is not None else ""
            spine_hrefs = [d.href for d in docs]
            add_item("ra-nav", "ra-nav.xhtml", "application/xhtml+xml", "nav")
            new_entries[z("ra-nav.xhtml")] = (_nav_from_ncx(ncx_bytes, ncx_dir, spine_hrefs), zipfile.ZIP_DEFLATED)

        opf_bytes = etree.tostring(opf, xml_declaration=True, encoding="utf-8")
        with zipfile.ZipFile(dst, "w") as out:
            out.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
            for info in zf.infolist():
                name = info.filename
                if name == "mimetype" or name in new_entries:
                    continue
                if name == opf_zip:
                    out.writestr(name, opf_bytes, compress_type=zipfile.ZIP_DEFLATED)
                elif name in replaced_docs:
                    out.writestr(name, replaced_docs[name], compress_type=zipfile.ZIP_DEFLATED)
                else:
                    out.writestr(info, zf.read(info))
            for name, (payload, ctype) in new_entries.items():
                if isinstance(payload, Path):
                    out.write(payload, arcname=name, compress_type=ctype)
                else:
                    out.writestr(name, payload, compress_type=ctype)
