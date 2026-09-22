from app.media import probe_audio, read_epub, search_epub
from tests.fixtures import make_epub

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
