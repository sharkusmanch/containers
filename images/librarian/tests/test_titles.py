from app.titles import normalize, title_keys, surname, surnames, parse_series, edition_flags


def test_colon_keys_cover_all_three_meanings():
    assert "artificial condition" in title_keys("Artificial Condition: The Murderbot Diaries")
    assert "thrawn" in title_keys("Star Wars: Thrawn")
    k = title_keys("Exodus: The Archimedes Engine")
    assert {"exodus", "archimedes engine", "exodus archimedes engine"} <= k


def test_normalize_strips_articles_parens_punct():
    assert normalize("The Hobbit (Unabridged)") == "hobbit"
    assert normalize("Star Wars_ Thrawn") == "star wars thrawn"


def test_placeholder_style_title_still_keyed():
    assert "new james s a corey novella 1" in title_keys("New James S. A. Corey Novella #1")


def test_surname_forms():
    assert surname("Martha Wells") == "wells"
    assert surname("Wells, Martha") == "wells"
    assert surname("James S. A. Corey") == "corey"
    assert surname("Martin Luther King Jr.") == "king"
    assert surnames(["Brandon Sanderson", "Dan Wells"]) == {"sanderson", "wells"}


def test_parse_series():
    assert parse_series("Murderbot Diaries #2") == ("murderbot diaries", 2.0)
    assert parse_series("The Stormlight Archive, Book 3.5") == ("stormlight archive", 3.5)
    assert parse_series("Foundation") == ("foundation", None)
    assert parse_series(None) == (None, None)


def test_edition_flags():
    assert edition_flags("Harry Potter (Full-Cast Edition)") == ["full-cast"]
    assert edition_flags("The Hobbit [Dramatized Adaptation]", None) == ["dramatized"]
    assert edition_flags("Dune (Unabridged)") == []
    assert edition_flags("Dune (Abridged)") == ["abridged"]
    assert edition_flags("X", "Booktrack Edition") == ["booktrack"]


# --- additional coverage -----------------------------------------------------

def test_title_plus_subtitle_key():
    k = title_keys("Foundation", "Book 1")
    assert "foundation book 1" in k


def test_trailing_unabridged_word_stripped_as_extra_key():
    # "(Unabridged)" is already stripped by normalize's paren removal, so
    # exercise the trailing-word branch with an unparenthesized occurrence.
    k = title_keys("Dune Unabridged")
    assert "dune unabridged" in k and "dune" in k


def test_no_colon_yields_only_whole_title_key():
    assert title_keys("Foundation") == {"foundation"}


def test_empty_and_none_subtitle_produce_no_extra_key():
    assert title_keys("Foundation", None) == {"foundation"}
    assert title_keys("Foundation", "") == {"foundation"}


def test_edition_flags_sorted_unique_multi_match():
    assert edition_flags("Dramatized Full-Cast Dramatised Edition") == ["dramatized", "full-cast"]


def test_surname_empty_input():
    assert surname("") == ""
    assert surnames([]) == set()
    assert surnames(["", "Martha Wells"]) == {"wells"}


def test_parse_series_comma_book_form():
    assert parse_series("Foundation, Book 1") == ("foundation", 1.0)
