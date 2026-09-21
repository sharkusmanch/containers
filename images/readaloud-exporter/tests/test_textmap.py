import pytest

from app import textmap
from tests.conftest import make_epub


def test_reference_joins_documents_with_single_space(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>Hello world.</p>"), ("b.xhtml", "<p>Second doc.</p>")])
    docs = textmap.reference_documents(p)
    assert [t for _, t in docs] == ["Hello world.", "Second doc."]
    maps = textmap.build(p)
    assert [m.ref_start for m in maps] == [0, 13]
    assert textmap.reference_string(docs) == "Hello world. Second doc."


def test_head_title_is_not_counted(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>Only body.</p>")])
    assert textmap.reference_string(textmap.reference_documents(p)) == "Only body."


def test_total_chars_guard(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>Hello.</p>")])
    with pytest.raises(textmap.TextMapError) as e:
        textmap.build(p, total_chars=999)
    assert e.value.reason == "text_mismatch"
    assert len(textmap.build(p, total_chars=6)) == 1


def test_entities_nbsp_and_inline_markup_map(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>A&#160;B &amp; <em>C</em>&#160;D.</p>")])
    (m,) = textmap.build(p)
    for i, ch in enumerate(m.ref_text):
        e = m.ref_to_edit[i]
        if ch.isspace():
            continue
        si, off = m.edit_slot[e]
        assert m.slots[si].value[off] == ch


def test_crlf_inside_text_is_tolerated(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>line one\r\nline two</p>")])
    (m,) = textmap.build(p)
    assert "line two" in m.ref_text


def test_script_and_style_excluded(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>Hi.</p><script>var x = 1;</script>")])
    (m,) = textmap.build(p)
    assert m.ref_text == "Hi."


def test_named_html_entity_is_accepted_by_xml_parser(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>caf&eacute; ok.</p>")])
    (m,) = textmap.build(p)
    assert m.ref_text == "café ok."


def test_malformed_xhtml_refused(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("a.xhtml", "<p>unclosed</b>")])
    with pytest.raises(textmap.TextMapError) as e:
        textmap.build(p)
    assert e.value.reason in {"xhtml_parse_error", "text_map_mismatch"}
