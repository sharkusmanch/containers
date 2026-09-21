import pytest
from lxml import etree

from app import segment, textmap
from tests.conftest import make_epub


def test_sentence_spans_respect_abbreviations_and_initials():
    text = "Mr. Smith went home. He left! J. R. Tolkien wrote? Yes."
    parts = [text[a:b].strip() for a, b in segment.sentence_spans(text)]
    assert parts == ["Mr. Smith went home.", "He left!", "J. R. Tolkien wrote?", "Yes."]


def test_sentence_spans_closing_quote():
    text = "“Stop.” She did."
    parts = [text[a:b].strip() for a, b in segment.sentence_spans(text)]
    assert parts == ["“Stop.”", "She did."]


def _doc(tmp_path, body):
    return textmap.build(make_epub(tmp_path / "b.epub", [("a.xhtml", body)]))[0]


def test_fragments_split_at_inline_elements(tmp_path):
    d = _doc(tmp_path, "<p>One <em>two</em> three. Four.</p>")
    frags = segment.fragments(d)
    assert [d.ref_text[f.c0 - d.ref_start:f.c1 - d.ref_start] for f in frags] == ["One", "two", "three.", "Four."]
    assert [f.id for f in frags] == ["ra-0-0", "ra-0-1", "ra-0-2", "ra-0-3"]
    for f in frags:
        assert d.slots[f.slot_index].value[f.start:f.end] == d.ref_text[f.c0 - d.ref_start:f.c1 - d.ref_start]


def test_wrap_preserves_text_and_adds_ids(tmp_path):
    d = _doc(tmp_path, "<p>One <em>two</em> three. Four.</p>")
    before = "".join(d.tree.getroot().itertext())
    frags = segment.fragments(d)
    segment.wrap(d, frags)
    xml = etree.tostring(d.tree, encoding="unicode")
    assert "".join(d.tree.getroot().itertext()) == before
    for f in frags:
        assert f'id="{f.id}"' in xml
    assert '<span id="ra-0-3">Four.</span>' in xml


def test_drop_cap_is_its_own_fragment(tmp_path):
    d = _doc(tmp_path, '<p><span class="dc">T</span>hree men.</p>')
    frags = segment.fragments(d)
    texts = [d.ref_text[f.c0 - d.ref_start:f.c1 - d.ref_start] for f in frags]
    assert texts == ["T", "hree men."]


def test_id_collision_refused(tmp_path):
    d = _doc(tmp_path, '<p id="ra-0-0">Hello.</p>')
    with pytest.raises(textmap.TextMapError) as e:
        segment.wrap(d, segment.fragments(d))
    assert e.value.reason == "id_collision"
