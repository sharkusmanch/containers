import pytest
import zipfile
from app.readalong.smil import clock_seconds, inspect_epub

CONTAINER = '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
OPF = '''<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest>
 <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/>
 <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml" media-overlay="s2"/>
 <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml"/>
 <item id="s1" href="s1.smil" media-type="application/smil+xml"/>
 <item id="s2" href="s2.smil" media-type="application/smil+xml"/>
</manifest><spine><itemref idref="toc"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>'''
S1 = '<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq><par><text src="c1.xhtml#a"/><audio src="a.m4a" clipBegin="0:00:00.000" clipEnd="0:00:10.500"/></par><par><text src="c1.xhtml#b"/><audio src="a.m4a" clipBegin="10.5s" clipEnd="20s"/></par></seq></body></smil>'
S2_EMPTY = '<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq epub:textref="c2.xhtml" xmlns:epub="http://www.idpf.org/2007/ops"/></body></smil>'


def make_epub(path, s2=S2_EMPTY):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/s1.smil", S1)
        z.writestr("OEBPS/s2.smil", s2)


def test_clock_values():
    assert clock_seconds("0:01:02.500") == 62.5
    assert clock_seconds("01:02:03") == 3723.0
    assert clock_seconds("12.25s") == 12.25
    assert clock_seconds("1500ms") == 1.5
    assert clock_seconds("2min") == 120.0
    assert clock_seconds("1.5h") == 5400.0
    assert clock_seconds("7") == 7.0


def test_inspect_epub_sums_clips_and_flags_missing_and_empty(tmp_path):
    p = tmp_path / "b.epub"; make_epub(str(p))
    o = inspect_epub(str(p))
    assert o.total_seconds == 20.0
    assert o.spine_total == 3 and o.spine_with_overlay == 2
    assert o.spine_without_overlay == ["toc.xhtml"]
    assert o.empty_smils == ["s2.smil"] and o.smil_count == 2


def test_inspect_epub_fails_on_audio_without_clipend(tmp_path):
    s_open_clip = '<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq><par><text src="c1.xhtml#a"/><audio src="a.m4a" clipBegin="0s"/></par></seq></body></smil>'
    p = tmp_path / "b.epub"; make_epub(str(p), s2=s_open_clip)
    with pytest.raises(ValueError, match="clipEnd"):
        inspect_epub(str(p))


def test_inspect_epub_counts_zero_length_clips(tmp_path):
    s_zero_clip = ('<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq>'
                    '<par><text src="c2.xhtml#a"/><audio src="a.m4a" clipBegin="46949.0s" clipEnd="46949.0s"/></par>'
                    '<par><text src="c2.xhtml#b"/><audio src="a.m4a" clipBegin="46950s" clipEnd="46955s"/></par>'
                    '</seq></body></smil>')
    p = tmp_path / "b.epub"; make_epub(str(p), s2=s_zero_clip)
    o = inspect_epub(str(p))
    assert o.zero_length_clips == 1
