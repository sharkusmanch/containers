import os
import zipfile
import pytest
from app.convert import classify, epub_to_cbz, ConvertFailed, CLEAR, AMBIGUOUS

REAL_COMIC = os.environ.get("KI_REAL_COMIC", "/private/tmp/claude-501/-Users-marcus/ae9250ee-b9bc-4a27-bff1-68c3e98c8019/scratchpad/cbztest/halo.epub")
have_comic = os.path.exists(REAL_COMIC)


def test_comic_needs_all_signals(epub_factory):
    c = classify(epub_factory(spine=20, text_per_page=0, viewport=True))
    assert c.is_comic and c.confidence == CLEAR


def test_duplicate_image_refs_still_count_as_one_page(epub_factory):
    """Kindle Panel View emits each image twice; distinct-counting must handle it."""
    c = classify(epub_factory(spine=20, text_per_page=0, viewport=True,
                              duplicate_image_ref=True))
    assert c.is_comic and c.image_ratio == 1.0


def test_prose_is_not_a_comic(epub_factory):
    c = classify(epub_factory(spine=40, text_per_page=3000, images_per_page=0))
    assert not c.is_comic and c.confidence == CLEAR


def test_text_free_but_reflowable_is_prose_not_comic(epub_factory):
    """A novel whose median page text is tiny (front matter, dividers) must not
    be mistaken for a comic: without fixed layout it cannot be one."""
    c = classify(epub_factory(spine=20, text_per_page=4, images_per_page=0))
    assert not c.is_comic and c.confidence == CLEAR


def test_fixed_layout_textbook_stays_epub(epub_factory):
    c = classify(epub_factory(spine=20, text_per_page=900, viewport=True))
    assert not c.is_comic and c.confidence == CLEAR


def test_borderline_fixed_layout_is_ambiguous_not_guessed(epub_factory):
    c = classify(epub_factory(spine=20, text_per_page=120, viewport=True))
    assert not c.is_comic and c.confidence == AMBIGUOUS


def test_cbz_pages_match_spine_and_are_ordered(epub_factory, tmp_path):
    src = epub_factory(spine=12, text_per_page=0, viewport=True)
    out = tmp_path / "o.cbz"
    assert epub_to_cbz(src, str(out)) == 12
    names = zipfile.ZipFile(out).namelist()
    assert names[0] == "0001.jpg" and names[-1] == "0012.jpg"
    assert names == sorted(names)
    assert not (tmp_path / "o.cbz.part").exists()


def test_cbz_refuses_on_page_spine_mismatch(epub_factory, tmp_path):
    src = epub_factory(spine=6, text_per_page=0, viewport=True, images_per_page=0)
    with pytest.raises(ConvertFailed):
        epub_to_cbz(src, str(tmp_path / "o.cbz"))


@pytest.mark.skipif(not have_comic, reason="real comic fixture unavailable")
def test_real_comic_classifies_and_converts(tmp_path):
    c = classify(REAL_COMIC)
    assert c.is_comic and c.confidence == CLEAR
    out = tmp_path / "real.cbz"
    assert epub_to_cbz(REAL_COMIC, str(out)) == 20
    assert zipfile.ZipFile(out).namelist()[0] == "0001.jpg"
