"""Independent verification of a written readaloud (spec V0-V6). Parses the
output the way an overlay-aware reader does; shares no state with the writer."""
from __future__ import annotations

import posixpath
import re
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

from lxml import etree

from app import audio
from app.textmap import opf_path, parse_xhtml, reference_documents, reference_string, TextMapError

OPF_NS = "http://www.idpf.org/2007/opf"
SMIL_NS = "http://www.w3.org/ns/SMIL"
_CLOCK = re.compile(r"^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)s?$")


@dataclass
class VerifyResult:
    ok: bool
    failures: list[str] = field(default_factory=list)
    overlay_seconds: float | None = None


def _ms(value: str) -> int:
    m = _CLOCK.match(value.strip())
    if not m:
        raise ValueError(value)
    a, b, s = m.groups()
    parts = [int(x) for x in (a, b) if x is not None]
    secs = float(s)
    if len(parts) == 2:
        secs += parts[0] * 3600 + parts[1] * 60
    elif len(parts) == 1:
        secs += parts[0] * 60
    return round(secs * 1000)


def _probe_entry(zf: zipfile.ZipFile, name: str) -> float:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / posixpath.basename(name)
        p.write_bytes(zf.read(name))
        return audio.probe_duration(p)


def _nows(tree) -> str:
    body = next((e for e in tree.getroot().iter() if isinstance(e.tag, str) and etree.QName(e).localname == "body"), None)
    return re.sub(r"\s+", "", "".join(body.itertext())) if body is not None else ""


def verify(src_epub, out_epub, duration_s: float, audio_duration=None) -> VerifyResult:
    audio_duration = audio_duration or _probe_entry
    fails: list[str] = []
    total_ms = 0
    with zipfile.ZipFile(src_epub) as zs, zipfile.ZipFile(out_epub) as zo:
        names = zo.namelist()
        if not names or names[0] != "mimetype" or zo.getinfo("mimetype").compress_type != zipfile.ZIP_STORED:
            fails.append("V0 mimetype must be the first, stored entry")
        s_opf_path, o_opf_path = opf_path(zs), opf_path(zo)
        s_opf, o_opf = etree.fromstring(zs.read(s_opf_path)), etree.fromstring(zo.read(o_opf_path))
        s_dir, o_dir = posixpath.dirname(s_opf_path), posixpath.dirname(o_opf_path)
        join = lambda base, href: posixpath.normpath(posixpath.join(base, unquote(href))) if base else unquote(href)
        spine = lambda o: [i.get("idref") for i in o.iter(f"{{{OPF_NS}}}itemref")]
        if spine(s_opf) != spine(o_opf):
            fails.append("V5 spine differs from source")
        s_items = {i.get("id"): i for i in s_opf.iter(f"{{{OPF_NS}}}item")}
        o_items = {i.get("id"): i for i in o_opf.iter(f"{{{OPF_NS}}}item")}
        durations: dict[str, float] = {}
        prev = None  # (audio zip path, clip end ms)
        for idref in spine(o_opf):
            item = o_items.get(idref)
            if item is None:
                fails.append(f"V5 spine idref {idref} not in manifest")
                continue
            doc_zip = join(o_dir, item.get("href"))
            s_item = s_items.get(idref)
            out_tree = None
            if item.get("media-type") == "application/xhtml+xml":
                try:
                    out_tree = parse_xhtml(zo.read(doc_zip))
                    if s_item is not None:
                        src_tree = parse_xhtml(zs.read(join(s_dir, s_item.get("href"))))
                        if _nows(out_tree) != _nows(src_tree):
                            fails.append(f"V5 text differs in {doc_zip}")
                except (TextMapError, KeyError) as e:
                    fails.append(f"V5 cannot parse {doc_zip}: {e}")
                    continue
            mo = item.get("media-overlay")
            if not mo:
                continue
            if out_tree is None:
                fails.append(f"V2 media-overlay on non-XHTML item {idref}")
                continue
            smil_item = o_items.get(mo)
            if smil_item is None:
                fails.append(f"V2 media-overlay {mo} missing")
                continue
            smil_zip = join(o_dir, smil_item.get("href"))
            smil_dir = posixpath.dirname(smil_zip)
            ids = {e.get("id") for e in out_tree.getroot().iter() if isinstance(e.tag, str) and e.get("id")}
            for par in etree.fromstring(zo.read(smil_zip)).iter(f"{{{SMIL_NS}}}par"):
                text, aud = par.find(f"{{{SMIL_NS}}}text"), par.find(f"{{{SMIL_NS}}}audio")
                if text is None or aud is None:
                    fails.append(f"V2 incomplete par {par.get('id')}")
                    continue
                path, _, frag = text.get("src").partition("#")
                if join(smil_dir, path) != doc_zip or frag not in ids:
                    fails.append(f"V2 text src {text.get('src')} does not resolve")
                a_zip = join(smil_dir, aud.get("src"))
                if a_zip not in names:
                    fails.append(f"V2 audio {a_zip} missing")
                    continue
                if a_zip not in durations:
                    durations[a_zip] = audio_duration(zo, a_zip)
                b, e = _ms(aud.get("clipBegin")), _ms(aud.get("clipEnd"))
                if e <= b:
                    fails.append(f"V3 empty clip {par.get('id')}")
                if e / 1000 > durations[a_zip] + 0.05:
                    fails.append(f"V2 clip beyond file end {par.get('id')}")
                if prev is None:
                    if b != 0:
                        fails.append("V3 first clip does not start at 0")
                elif prev[0] == a_zip:
                    if prev[1] != b:
                        fails.append(f"V3 discontinuity before {par.get('id')}")
                elif b != 0:
                    fails.append(f"V3 new file does not start at 0 at {par.get('id')}")
                total_ms += e - b
                prev = (a_zip, e)
        if abs(total_ms / 1000 - duration_s) > 0.5:
            fails.append(f"V1 overlay {total_ms / 1000:.3f}s vs audio {duration_s:.3f}s")
    try:
        if reference_string(reference_documents(out_epub)) != reference_string(reference_documents(src_epub)):
            fails.append("V6 reference text changed")
    except Exception as e:  # noqa: BLE001 - any parser failure is a verification failure
        fails.append(f"V6 cannot re-read output: {e}")
    return VerifyResult(not fails, fails, total_ms / 1000)
