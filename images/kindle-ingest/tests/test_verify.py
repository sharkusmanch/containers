import glob
import os
import zipfile
import pytest
from app.verify import (verify_epub, verify_cbz, verify_artifact, sha256_file,
                        archive_intact, ArtifactInvalid)

REAL_EPUBS = sorted(glob.glob(os.path.expanduser("~/Books/kindle-dedrm/epub/*.epub")))
REAL_CBZS = sorted(glob.glob(os.path.expanduser("~/Books/kindle-dedrm/cbz/*.cbz")))


def test_missing_file_is_invalid(tmp_path):
    with pytest.raises(ArtifactInvalid):
        verify_epub(str(tmp_path / "nope.epub"))


def test_truncated_epub_is_rejected(tmp_path):
    """The exact production hazard: a truncated pull yields a valid-looking
    EPUB, upload returns 200, and the device source gets deleted."""
    p = tmp_path / "t.epub"
    src = REAL_EPUBS[0] if REAL_EPUBS else None
    if src:
        data = open(src, "rb").read()
        p.write_bytes(data[: len(data) // 3])       # cut it short
    else:
        p.write_bytes(b"PK\x03\x04truncated")
    with pytest.raises(ArtifactInvalid):
        verify_epub(str(p))


def test_epub_with_empty_spine_is_rejected(tmp_path):
    p = tmp_path / "e.epub"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("OEBPS/content.opf", "<package><manifest/><spine></spine></package>")
    with pytest.raises(ArtifactInvalid) as e:
        verify_epub(str(p))
    assert "spine" in str(e.value)


def test_epub_with_no_text_is_rejected(tmp_path):
    p = tmp_path / "e.epub"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("OEBPS/content.opf",
                   '<package><manifest><item id="a" href="a.xhtml"/></manifest>'
                   '<spine><itemref idref="a"/></spine></package>')
        z.writestr("OEBPS/a.xhtml", "<html><body></body></html>")
    with pytest.raises(ArtifactInvalid):
        verify_epub(str(p))


def test_cbz_rejects_zero_byte_page(tmp_path):
    p = tmp_path / "c.cbz"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("0001.jpg", b"")
    with pytest.raises(ArtifactInvalid):
        verify_cbz(str(p))


def test_cbz_page_count_mismatch_is_rejected(tmp_path):
    p = tmp_path / "c.cbz"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("0001.jpg", b"\xff\xd8data")
    with pytest.raises(ArtifactInvalid):
        verify_cbz(str(p), expected_pages=5)


def test_sha256_and_archive_intact(tmp_path):
    p = tmp_path / "a.bin"
    p.write_bytes(b"hello")
    h = sha256_file(str(p))
    assert archive_intact(str(p), h) is True
    assert archive_intact(str(p), "deadbeef") is False
    assert archive_intact(str(p), None) is False      # unrecorded hash vouches for nothing
    p.write_bytes(b"tampered")
    assert archive_intact(str(p), h) is False


@pytest.mark.skipif(not REAL_EPUBS, reason="no real EPUBs available")
def test_every_real_epub_passes_verification():
    """The check must not reject books that are actually fine."""
    bad = []
    for f in REAL_EPUBS:
        try:
            verify_epub(f)
        except ArtifactInvalid as e:
            bad.append((os.path.basename(f), str(e)))
    assert bad == [], f"false rejections: {bad[:3]}"


@pytest.mark.skipif(not REAL_CBZS, reason="no real CBZs available")
def test_every_real_cbz_passes_verification():
    bad = []
    for f in REAL_CBZS:
        try:
            verify_cbz(f)
        except ArtifactInvalid as e:
            bad.append((os.path.basename(f), str(e)))
    assert bad == [], f"false rejections: {bad[:3]}"
