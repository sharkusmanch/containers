import zipfile

import pytest

from app.media import epub_text, probe_audio, read_epub, search_epub
from tests.fixtures import _CONTAINER_XML, make_epub

FAKE = {"format": {"duration": "3600.5", "tags": {"title": "Foo", "ALBUM": "Foo (Unabridged)",
        "album_artist": "Jane Reader", "AUDIBLE_ASIN": "B0TEST", "encoder": "x"}},
        "chapters": [{"tags": {"title": "Opening Credits"}}, {"tags": {"title": "Chapter 1"}},
                     {"tags": {"title": "Chapter 2"}}, {"tags": {"title": "Chapter 3"}}]}


def test_probe_audio_filters_and_lowercases_tags():
    a = probe_audio("/x.m4b", prober=lambda p: FAKE)
    assert a.duration_s == 3600.5 and a.chapters == 4
    assert a.first_chapters == ["Opening Credits", "Chapter 1", "Chapter 2"]
    assert a.tags == {"title": "Foo", "album": "Foo (Unabridged)",
                      "album_artist": "Jane Reader", "audible_asin": "B0TEST"}


def test_probe_audio_missing_duration():
    assert probe_audio("/x", prober=lambda p: {"format": {}}).duration_s is None


def test_read_epub(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "Star Wars: Thrawn", ["Timothy Zahn"], "Hello world. " * 100,
              identifiers={"isbn": "9780399178771"})
    e = read_epub(str(p))
    assert e.title == "Star Wars: Thrawn" and e.creators == ["Timothy Zahn"]
    assert e.identifiers["isbn"] == "9780399178771"
    assert 1100 <= e.char_count <= 1300


def test_search_epub(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "aaa " * 50 + "The needle is here. " + "bbb " * 50)
    hits = search_epub(str(p), "NEEDLE")
    assert len(hits) == 1 and "needle is here" in hits[0]["snippet"].lower()
    assert 0 < hits[0]["percent"] < 100


# --- additional coverage -----------------------------------------------------

def test_probe_audio_missing_chapters_and_tags():
    a = probe_audio("/x", prober=lambda p: {"format": {}})
    assert a.chapters == 0
    assert a.first_chapters == []
    assert a.tags == {}


def test_probe_audio_limits_to_three_chapters_even_with_more():
    data = {"format": {}, "chapters": [{"tags": {"title": f"Ch {i}"}} for i in range(10)]}
    a = probe_audio("/x", prober=lambda p: data)
    assert a.chapters == 10
    assert a.first_chapters == ["Ch 0", "Ch 1", "Ch 2"]


def test_read_epub_multiple_creators_and_date(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "Foundation", ["Isaac Asimov", "Someone Else"], "Some text.", date="1951")
    e = read_epub(str(p))
    assert e.creators == ["Isaac Asimov", "Someone Else"]
    assert e.date == "1951"
    assert e.language == "en"


def test_epub_description_truncated_to_500(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text")
    e = read_epub(str(p))
    assert e.description is None or len(e.description) <= 500


def test_search_epub_no_match_returns_empty(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "no relevant words here at all")
    assert search_epub(str(p), "zzznotfound") == []


def test_search_epub_respects_max_hits(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "needle " * 30)
    hits = search_epub(str(p), "needle", max_hits=3)
    assert len(hits) == 3


# --- fix round 1 ---------------------------------------------------------

def test_read_epub_identifier_urn_isbn_without_scheme(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text", raw_identifiers=[(None, "urn:isbn:9780399178771")])
    e = read_epub(str(p))
    assert e.identifiers["isbn"] == "9780399178771"


def test_read_epub_identifier_bare_isbn13_without_scheme(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text", raw_identifiers=[(None, "9780399178771")])
    e = read_epub(str(p))
    assert e.identifiers["isbn"] == "9780399178771"


def test_read_epub_identifier_urn_uuid_without_scheme(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text",
              raw_identifiers=[(None, "urn:uuid:550e8400-e29b-41d4-a716-446655440000")])
    e = read_epub(str(p))
    assert e.identifiers["uuid"] == "550e8400-e29b-41d4-a716-446655440000"


def test_read_epub_identifier_with_scheme_still_works(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text", identifiers={"isbn": "9780399178771"})
    e = read_epub(str(p))
    assert e.identifiers["isbn"] == "9780399178771"


def test_read_epub_identifier_unclassifiable_keyed_by_id_not_dropped(tmp_path):
    p = tmp_path / "b.epub"
    make_epub(p, "T", ["A"], "text", raw_identifiers=[("pub-id", "not-a-standard-identifier")])
    e = read_epub(str(p))
    assert e.identifiers["pub-id"] == "not-a-standard-identifier"


def test_read_epub_missing_rootfile_raises_clear_error(tmp_path):
    p = tmp_path / "bad.epub"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            "<rootfiles></rootfiles></container>",
        )
    with pytest.raises(ValueError, match="unreadable EPUB"):
        read_epub(str(p))


def test_read_epub_decodes_percent_encoded_manifest_href(tmp_path):
    p = tmp_path / "enc.epub"
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:title>T</dc:title></metadata>"
        '<manifest><item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="c1"/></spine>'
        "</package>"
    )
    xhtml = '<?xml version="1.0" encoding="UTF-8"?><html><body><p>hello there</p></body></html>'
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("META-INF/container.xml", _CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/chapter 1.xhtml", xhtml)
    assert "hello there" in epub_text(str(p))


# --- Task 11 fix round 1 (M5): which dc:date dates the publication -------------------


@pytest.mark.parametrize("dates, want", [
    ([("modification", "2019-05-01"), ("publication", "1851")], "1851"),
    ([("creation", "2018-01-01"), (None, "1999-04-01")], "1999-04-01"),
    ([("modification", "2019-05-01"), ("original-publication", "1603")], "1603"),
    ([("Publication", "1851")], "1851"),                                  # event names case-insensitive
    ([("creation", "2018-01-01"), ("modification", "2019-05-01")], None),  # file dates only: none
    ([(None, "2020"), ("publication", "1851")], "2020"),                   # first publication-like wins
])
def test_read_epub_date_prefers_a_publication_date_over_file_dates(tmp_path, dates, want):
    """The OPF's dc:date feeds create_book's publishedYear; EPUB2 allows
    several, and a creation/modification date dates the FILE, not the book."""
    p = str(tmp_path / "b.epub")
    make_epub(p, "T", ["A"], "text", dates=dates)
    assert read_epub(p).date == want
