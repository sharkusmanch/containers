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
