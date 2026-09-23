import zipfile

import pytest

from app.readalong.patch import patch_zero_length_clips

ZERO_SMIL = ('<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq>'
             '<par><text src="c1.xhtml#a"/><audio src="a.m4a" clipBegin="46949.0s" clipEnd="46949.0s"/></par>'
             '<par><text src="c1.xhtml#b"/><audio src="a.m4a" clipBegin="46950s" clipEnd="46955s"/></par>'
             '</seq></body></smil>')
NORMAL_SMIL = ('<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq>'
               '<par><text src="c2.xhtml#a"/><audio src="a.m4a" clipBegin="0s" clipEnd="5s"/></par>'
               '</seq></body></smil>')
CONTAINER = '<?xml version="1.0"?><container/>'
OPF = '<?xml version="1.0"?><package/>'


def make_epub(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/s1.smil", ZERO_SMIL)
        z.writestr("OEBPS/s2.smil", NORMAL_SMIL)
        z.writestr("OEBPS/audio/a.m4a", b"\x00\x01binary-audio-data")


def test_patch_rewrites_only_zero_length_clip(tmp_path):
    src = tmp_path / "src.epub"
    dst = tmp_path / "dst.epub"
    make_epub(str(src))

    n = patch_zero_length_clips(str(src), str(dst))
    assert n == 1

    with zipfile.ZipFile(dst) as z:
        names = z.namelist()
        assert names[0] == "mimetype"
        assert z.getinfo("mimetype").compress_type == zipfile.ZIP_STORED

        s1 = z.read("OEBPS/s1.smil").decode()
        assert 'clipBegin="46949.0s" clipEnd="46949.001s"' in s1
        assert 'clipBegin="46950s" clipEnd="46955s"' in s1  # untouched normal clip

    with zipfile.ZipFile(src) as zs, zipfile.ZipFile(dst) as zd:
        for name in ("mimetype", "META-INF/container.xml", "OEBPS/content.opf",
                     "OEBPS/audio/a.m4a", "OEBPS/s2.smil"):
            assert zs.read(name) == zd.read(name), name


def test_patch_raises_on_non_timecount_clock_form(tmp_path):
    src = tmp_path / "src.epub"
    dst = tmp_path / "dst.epub"
    bad_smil = ('<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq>'
                '<par><text src="c1.xhtml#a"/><audio src="a.m4a" clipBegin="0:00:00.000" clipEnd="0:00:00.000"/></par>'
                '</seq></body></smil>')
    with zipfile.ZipFile(str(src), "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("OEBPS/s1.smil", bad_smil)

    with pytest.raises(ValueError, match="non-timecount"):
        patch_zero_length_clips(str(src), str(dst))



def test_the_patched_copy_is_flushed_as_it_is_written(tmp_path, monkeypatch):
    """vendored + (2026-09-23): the copy lands on NFS; dirty pages are fsync'ed
    and dropped every FLUSH_EVERY bytes, not held until close."""
    import os
    from app.readalong import patch as p
    src = tmp_path / "in.epub"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("OEBPS/audio.m4a", b"A" * 5000)
        z.writestr("OEBPS/s1.smil", '<par><audio src="a" clipBegin="1.0s" clipEnd="1.0s"/></par>')
    synced = []
    monkeypatch.setattr(p.os, "fsync", lambda fd: synced.append(fd))
    monkeypatch.setattr(p, "FLUSH_EVERY", 1000)
    assert p.patch_zero_length_clips(str(src), str(tmp_path / "out.epub")) == 1
    assert len(synced) >= 2                                   # during the write, and at close
