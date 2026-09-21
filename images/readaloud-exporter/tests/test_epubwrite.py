import zipfile

from lxml import etree

from app import epubwrite as W
from app import segment, textmap
from app.timing import AudioFile, Par
from tests.conftest import make_epub


def build(tmp_path, bodies):
    src = make_epub(tmp_path / "src.epub", [(f"c{i}.xhtml", b) for i, b in enumerate(bodies)])
    docs = textmap.build(src)
    pars, t = [], 0
    for d in docs:
        frags = segment.fragments(d)
        segment.wrap(d, frags)
        for f in frags:
            pars.append(Par(f.id, d.index, t, t + 1000, f.c0, f.c1))
            t += 1000
    files = [AudioFile("ra-0001.mp4", 0, 2000), AudioFile("ra-0002.mp4", 2000, t)]
    aud = {}
    for f in files:
        p = tmp_path / f.name
        p.write_bytes(b"\0" * 10)
        aud[f.name] = p
    dst = tmp_path / "out.epub"
    W.write_readaloud(src, dst, docs, pars, files, aud, "2026-09-21T00:00:00Z")
    return src, dst


def opf_of(z):
    return etree.fromstring(z.read(textmap.opf_path(z)))


def prep(tmp_path, src):
    docs = textmap.build(src)
    pars, t = [], 0
    for d in docs:
        frags = segment.fragments(d)
        segment.wrap(d, frags)
        for f in frags:
            pars.append(Par(f.id, d.index, t, t + 1000, f.c0, f.c1))
            t += 1000
    files = [AudioFile("ra-0001.mp4", 0, t)]
    aud = {}
    for f in files:
        p = tmp_path / f.name
        p.write_bytes(b"\0" * 10)
        aud[f.name] = p
    return docs, pars, files, aud


def inject_old_overlay(path):
    """Simulate an EPUB 3 source that already carries its own media overlays:
    stale media:* metas, a stale media-overlay attribute on the c0 doc item,
    and a leftover SMIL manifest item + zip entry."""
    with zipfile.ZipFile(path) as z:
        entries = {n: z.read(n) for n in z.namelist()}
    opf = etree.fromstring(entries["OEBPS/content.opf"])
    metadata = opf.find(f"{{{W.OPF_NS}}}metadata")
    manifest = opf.find(f"{{{W.OPF_NS}}}manifest")
    for prop, value in [("media:active-class", "old-active"), ("media:duration", "0:00:01.000")]:
        m = etree.SubElement(metadata, f"{{{W.OPF_NS}}}meta")
        m.set("property", prop)
        m.text = value
    smil_item = etree.SubElement(manifest, f"{{{W.OPF_NS}}}item")
    smil_item.set("id", "old-smil")
    smil_item.set("href", "old.smil")
    smil_item.set("media-type", "application/smil+xml")
    d0 = next(i for i in manifest.iter(f"{{{W.OPF_NS}}}item") if i.get("id") == "d0")
    d0.set("media-overlay", "old-smil")
    entries["OEBPS/content.opf"] = etree.tostring(opf, xml_declaration=True, encoding="utf-8")
    entries["OEBPS/old.smil"] = b"<smil xmlns='http://www.w3.org/ns/SMIL'/>"
    with zipfile.ZipFile(path, "w") as z:
        for name, content in entries.items():
            ctype = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
            z.writestr(zipfile.ZipInfo(name), content, compress_type=ctype)
    return path


def test_package_upgraded_and_spine_unchanged(tmp_path):
    src, dst = build(tmp_path, ["<p>One. Two.</p>", "<p>Three.</p>"])
    with zipfile.ZipFile(src) as zs, zipfile.ZipFile(dst) as zo:
        assert zo.namelist()[0] == "mimetype"
        assert zo.getinfo("mimetype").compress_type == zipfile.ZIP_STORED
        so, oo = opf_of(zs), opf_of(zo)
        assert oo.get("version") == "3.0"
        spine = lambda o: [i.get("idref") for i in o.iter(f"{{{W.OPF_NS}}}itemref")]
        assert spine(so) == spine(oo)
        metas = {m.get("property"): m.text for m in oo.iter(f"{{{W.OPF_NS}}}meta") if m.get("property") and not m.get("refines")}
        assert metas["media:active-class"] == W.ACTIVE_CLASS
        assert metas["media:duration"] == "0:00:03.000"
        assert metas["dcterms:modified"] == "2026-09-21T00:00:00Z"


def test_overlays_audio_css_and_nav(tmp_path):
    _, dst = build(tmp_path, ["<p>One. Two.</p>", "<p>Three.</p>"])
    with zipfile.ZipFile(dst) as zo:
        oo = opf_of(zo)
        items = {i.get("id"): i for i in oo.iter(f"{{{W.OPF_NS}}}item")}
        assert items["d0"].get("media-overlay") and items["d1"].get("media-overlay")
        assert "nav" in items["ra-nav"].get("properties")
        assert "ra-nav" not in [i.get("idref") for i in oo.iter(f"{{{W.OPF_NS}}}itemref")]
        assert zo.getinfo("OEBPS/Audio/ra-0001.mp4").compress_type == zipfile.ZIP_STORED
        smil = etree.fromstring(zo.read("OEBPS/MediaOverlays/ra-0000.smil"))
        pars = list(smil.iter(f"{{{W.SMIL_NS}}}par"))
        assert len(pars) == 2
        text = pars[1].find(f"{{{W.SMIL_NS}}}text")
        aud = pars[1].find(f"{{{W.SMIL_NS}}}audio")
        assert text.get("src") == "../Text/c0.xhtml#ra-0-1"
        assert aud.get("src") == "../Audio/ra-0001.mp4"
        assert (aud.get("clipBegin"), aud.get("clipEnd")) == ("1.000s", "2.000s")
        smil2 = etree.fromstring(zo.read("OEBPS/MediaOverlays/ra-0001.smil"))
        a2 = next(smil2.iter(f"{{{W.SMIL_NS}}}audio"))
        assert (a2.get("src"), a2.get("clipBegin"), a2.get("clipEnd")) == ("../Audio/ra-0002.mp4", "0.000s", "1.000s")
        doc = zo.read("OEBPS/Text/c0.xhtml").decode()
        assert 'href="../Styles/ra-readaloud.css"' in doc and 'id="ra-0-0"' in doc
        assert b"-epub-media-overlay-active" in zo.read("OEBPS/Styles/ra-readaloud.css")


def test_fmt_clock():
    assert W.fmt_clock(3_723_456) == "1:02:03.456"


def test_old_overlay_artifacts_stripped(tmp_path):
    src = make_epub(tmp_path / "src3.epub", [("c0.xhtml", "<p>One. Two.</p>")], version="3.0")
    inject_old_overlay(src)
    docs, pars, files, aud = prep(tmp_path, src)
    dst = tmp_path / "out3.epub"
    W.write_readaloud(src, dst, docs, pars, files, aud, "2026-09-21T00:00:00Z")
    with zipfile.ZipFile(dst) as zo:
        oo = opf_of(zo)
        metas = list(oo.iter(f"{{{W.OPF_NS}}}meta"))
        active = [m for m in metas if m.get("property") == "media:active-class"]
        durations = [m for m in metas if m.get("property") == "media:duration" and not m.get("refines")]
        assert len(active) == 1 and active[0].text == W.ACTIVE_CLASS
        assert len(durations) == 1
        ids = {i.get("id") for i in oo.iter(f"{{{W.OPF_NS}}}item")}
        assert "old-smil" not in ids
        assert "OEBPS/old.smil" not in zo.namelist()


def test_href_percent_encoded_for_spaces(tmp_path):
    src = make_epub(tmp_path / "src_sp.epub", [("my ch.xhtml", "<p>One.</p>")])
    docs, pars, files, aud = prep(tmp_path, src)
    dst = tmp_path / "out_sp.epub"
    W.write_readaloud(src, dst, docs, pars, files, aud, "2026-09-21T00:00:00Z")
    with zipfile.ZipFile(dst) as zo:
        oo = opf_of(zo)
        items = {i.get("id"): i for i in oo.iter(f"{{{W.OPF_NS}}}item")}
        assert items["d0"].get("media-overlay")
        smil = etree.fromstring(zo.read("OEBPS/MediaOverlays/ra-0000.smil"))
        text = next(smil.iter(f"{{{W.SMIL_NS}}}text"))
        assert text.get("src") == "../Text/my%20ch.xhtml#ra-0-0"
