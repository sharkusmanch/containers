"""app.bo_render against BookOrbit 3.0.0 itself: GOLDEN was produced by
running @bookorbit/types' resolveUploadPath + formatSeriesIndex (node, in the
bookorbit pod, 2026-09-23) over CASES with the libraries' fileNamingPattern
and sanitizeForCrossPlatform=true, then path.join-normalised."""
import pytest

from app import bo_render

CASES = [[['Librarian Probe Author'], 'The Arcanaeum', '3', 'Librarian Probe', 'epub'],
 [['Brandon Sanderson'],
  'The Mistborn Saga: The Original Trilogy',
  '3.5',
  'Mistborn: Secret History',
  'epub'],
 [['A'], None, '2', 'T.', 'epub'],
 [['A, B'], None, None, 'CON', 'epub'],
 [['J.K. Rowling', 'X'], 'S', '10', 'Who? What* <x> "q" | a\\b', 'm4b'],
 [['A'],
  'S',
  '2',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'epub'],
 [['Émile Zoë'],
  'Ünïcødé 📚 Saga',
  '002.50',
  'Ωmega… “quoted” ‘x’ – dash '
  '日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル',
  'm4b'],
 [['  Padded  '], ' ', 'x', '  Title ending dots... ', 'epub'],
 [['A'], 'S:', None, 'Nul.txt', 'epub'],
 [['A'], 'S', '1.2.3', '{series} in title', 'epub'],
 [['A'], 'S', '123456789012345678901', 'T', 'epub'],
 [['  '], 'S', '7', 'T', 'epub']]

GOLDEN = ['Librarian Probe Author/The Arcanaeum/03. Librarian Probe/03. Librarian Probe.epub',
 'Brandon Sanderson/The Mistborn Saga_ The Original Trilogy/03.5. Mistborn_ Secret History/03.5. '
 'Mistborn_ Secret History.epub',
 'A/02. T/02. T.epub',
 'A/CON_/CON_.epub',
 'J.K. Rowling/S/10. Who_ What_ _x_ _q_ _ a_b/10. Who_ What_ _x_ _q_ _ a_b.m4b',
 'A/S/02. '
 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx~4155f961/02. '
 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx~4b290d3f.epub',
 'Émile Zoë/Ünïcødé 📚 Saga/002.50. Ωmega… “quoted” ‘x’ – dash '
 '日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語~786ad5ab/002.50. Ωmega… '
 '“quoted” ‘x’ – dash '
 '日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日本語タイトル日~e371b68c.m4b',
 'Padded/Title ending dots/Title ending dots.epub',
 'A/S_/Nul.txt_/Nul.txt_.epub',
 'A/S/{series} in title/{series} in title.epub',
 'A/S/T/T.epub',
 'S/07. T/07. T.epub']


@pytest.mark.parametrize("case,want", list(zip(CASES, GOLDEN)))
def test_render_matches_bookorbit_node_output(case, want):
    authors, series, idx, title, ext = case
    assert bo_render.render_book_path(authors, series, idx, title, ext, "orig") == want


def test_format_series_index():
    f = bo_render.format_series_index
    assert f("3") == "03" and f("2.5") == "02.5" and f("0.5") == "00.5" and f("123") == "123"
    assert f(2) == "02" and f(2.0) == "02" and f(2.5) == "02.5"
    assert f(None) is None and f("") is None and f("1.2.3") is None and f("x") is None
    assert f("1" * 21) is None and f(" 4 ") == "04"
    assert f("\u0663") is None                     # JS \\d is ASCII-only


def test_sanitize_path_segment():
    s = bo_render.sanitize_path_segment
    assert s('a:b*c?"d<e>f|g\\h/i') == "a_b_c__d_e_f_g_h_i"
    assert s("Title...") == "Title" and s("...") == "_" and s("..") == "_"
    assert s("nul.txt") == "nul.txt_" and s("COM1") == "COM1_" and s("CONSOLE") == "CONSOLE"


def test_rename_relevant_fields_match_bookorbit():
    assert set(bo_render.RENAME_RELEVANT_FIELDS) == {
        "title", "authors", "seriesName", "seriesIndex", "publishedYear"}
