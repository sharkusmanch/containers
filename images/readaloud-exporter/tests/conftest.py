import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg not installed")

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

XHTML = ('<?xml version="1.0" encoding="utf-8"?>\n'
         '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head>'
         '<body>{body}</body></html>')


def make_epub(path, docs, ncx=True, version="2.0"):
    path = Path(path)
    manifest, spine, files, navpoints = [], [], {}, []
    for i, (name, body) in enumerate(docs):
        manifest.append(f'<item id="d{i}" href="Text/{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="d{i}"/>')
        files[f"OEBPS/Text/{name}"] = XHTML.format(title=f"t{i}", body=body)
        navpoints.append(f'<navPoint id="n{i}" playOrder="{i + 1}"><navLabel><text>Chapter {i + 1}</text>'
                         f'</navLabel><content src="Text/{name}"/></navPoint>')
    if ncx:
        manifest.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        files["OEBPS/toc.ncx"] = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
            '<head><meta name="dtb:uid" content="urn:uuid:1234"/></head>'
            '<docTitle><text>Test</text></docTitle><navMap>' + "".join(navpoints) + "</navMap></ncx>")
    opf = (f'<?xml version="1.0" encoding="utf-8"?>'
           f'<package xmlns="http://www.idpf.org/2007/opf" version="{version}" unique-identifier="bookid">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title>'
           '<dc:identifier id="bookid">urn:uuid:1234</dc:identifier><dc:language>en</dc:language></metadata>'
           f'<manifest>{"".join(manifest)}</manifest>'
           f'<spine{" toc=" + chr(34) + "ncx" + chr(34) if ncx else ""}>{"".join(spine)}</spine></package>')
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        for name, content in files.items():
            z.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
    return path


def make_m4b(path, seconds, chapter_starts):
    path = Path(path)
    meta = path.with_suffix(".ffmeta")
    starts = list(chapter_starts) + [seconds]
    lines = [";FFMETADATA1"]
    for i in range(len(chapter_starts)):
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(starts[i] * 1000)}",
                  f"END={int(starts[i + 1] * 1000)}", f"title=Chapter {i + 1}"]
    meta.write_text("\n".join(lines) + "\n")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"sine=frequency=440:duration={seconds}", "-i", str(meta),
                    "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1",
                    "-c:a", "aac", "-b:a", "64k", "-f", "mp4", str(path)], check=True)
    return path


def synthetic_map(ref_text, cps=15.0, lead=0.0):
    """BookBridge-shaped anchors: one per word start at `cps` chars/sec after `lead` seconds."""
    import re
    anchors = [{"char": 0, "ts": 0.0}]
    for i, m in enumerate(re.finditer(r"\S+", ref_text)):
        anchors.append({"char": m.start(), "ts": lead + m.start() / cps, "t_idx": i, "b_idx": i})
    duration = lead + len(ref_text) / cps + 1.0
    anchors.append({"char": len(ref_text), "ts": duration + 20.0})
    return anchors, duration
