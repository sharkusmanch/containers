"""Independent coverage check of an EPUB 3 read-along: sum every SMIL <par>
audio clip, and list spine items with no media-overlay and SMILs with no <par>
(the v2 "silent empty SMIL" failure). No dependency on Storyteller's own report.

Also counts <par> audio clips whose clipEnd <= clipBegin ("zero-length clips").
Storyteller v3 emits these for storyteller:interpolated / storyteller:dropped
sentences, and BookOrbit's progress-sync bridge (findItemBySeconds) treats a
zero-length clip as "unknown end" and matches it against every later audio
position — see readalong/patch.py for the fix.
"""
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

_NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container",
       "opf": "http://www.idpf.org/2007/opf",
       "smil": "http://www.w3.org/ns/SMIL"}
_CLOCK = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(h|min|s|ms)?\s*$")


def clock_seconds(value):
    """SMIL clock value -> seconds (full/partial clock, or timecount with unit)."""
    v = value.strip()
    if ":" in v:
        parts = [float(p) for p in v.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        h, m, s = parts[-3:]
        return h * 3600 + m * 60 + s
    m = _CLOCK.match(v)
    if not m:
        raise ValueError(f"bad clock value {value!r}")
    n, unit = float(m.group(1)), m.group(2) or "s"
    return n * {"h": 3600, "min": 60, "s": 1, "ms": 0.001}[unit]


@dataclass
class Overlay:
    total_seconds: float
    spine_total: int
    spine_with_overlay: int
    spine_without_overlay: list = field(default_factory=list)
    empty_smils: list = field(default_factory=list)
    smil_count: int = 0
    zero_length_clips: int = 0


def inspect_epub(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("META-INF/container.xml"))
        opf_path = root.find(".//c:rootfile", _NS).get("full-path")
        opf_dir = posixpath.dirname(opf_path)
        opf = ET.fromstring(z.read(opf_path))
        items = {it.get("id"): it for it in opf.find("opf:manifest", _NS)}
        spine = [ref.get("idref") for ref in opf.find("opf:spine", _NS)]
        without, with_overlay = [], 0
        for idref in spine:
            it = items.get(idref)
            if it is not None and it.get("media-overlay"):
                with_overlay += 1
            else:
                without.append(it.get("href") if it is not None else idref)
        total, empty, count, zero_length = 0.0, [], 0, 0
        for it in items.values():
            if it.get("media-type") != "application/smil+xml":
                continue
            count += 1
            href = it.get("href")
            smil = ET.fromstring(z.read(posixpath.normpath(posixpath.join(opf_dir, href))))
            pars = smil.findall(".//smil:par", _NS)
            if not pars:
                empty.append(href)
            for par in pars:
                audio = par.find("smil:audio", _NS)
                if audio is None:
                    continue
                clip_end = audio.get("clipEnd")
                if clip_end is None:
                    raise ValueError(f"{href}: <audio> without clipEnd (open clip) — cannot compute overlay duration")
                begin_s = clock_seconds(audio.get("clipBegin", "0"))
                end_s = clock_seconds(clip_end)
                if end_s <= begin_s:
                    zero_length += 1
                total += end_s - begin_s
    return Overlay(round(total, 3), len(spine), with_overlay, without, empty, count, zero_length)
