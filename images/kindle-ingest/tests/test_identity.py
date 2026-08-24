from app.identity import asin_of


def test_extracts_asin_from_kindle_filename():
    assert asin_of("Jade City (The Green Bone Saga Book 1)_B06XRCBRX8.kfx") == "B06XRCBRX8"


def test_extracts_asin_ignoring_extension():
    assert asin_of("Warbreaker_B002KYHZHA.kfx-zip") == "B002KYHZHA"


def test_extracts_asin_with_no_extension():
    assert asin_of("Warbreaker_B002KYHZHA") == "B002KYHZHA"


def test_returns_none_without_asin():
    assert asin_of("cs-5.19.5-jb.azw3") is None


def test_retitled_book_yields_same_asin():
    a = asin_of("Onyx Storm (The Empyrean Book 3)_B0CW1FKFB9.kfx")
    b = asin_of("Onyx Storm (The Empyrean)_B0CW1FKFB9.kfx")
    assert a == b == "B0CW1FKFB9"


def test_full_path_is_basenamed():
    p = "/mnt/us/documents/Downloads/Items01/Warbreaker_B002KYHZHA.kfx"
    assert asin_of(p) == "B002KYHZHA"


def test_commas_and_hashes_in_title_do_not_break_it():
    assert asin_of("The Walking Dead #151_B01B1YHS9Y.kfx") == "B01B1YHS9Y"
    assert asin_of("A Parade of Horribles_ DCC, Book 8_B0GJJDXG4L.kfx") == "B0GJJDXG4L"


def test_title_words_are_not_mistaken_for_asins():
    """Shape alone is not enough: real ASINs contain digits, title words do not."""
    assert asin_of("The_BLACKBIRDS.kfx") is None
    assert asin_of("Some Title_BLOODLINES.azw3") is None


def test_matches_real_on_device_variants():
    assert asin_of("Warbreaker-asin_B002KYHZHA-type_EBOK-v_0.azw3") == "B002KYHZHA"
    assert asin_of("Warbreaker_B002KYHZHA (1).kfx") == "B002KYHZHA"
    assert asin_of("B002KYHZHA.kfx") == "B002KYHZHA"
    assert asin_of("Title_B002KYHZHA-v2.kfx") == "B002KYHZHA"


# --- a readable title, not the ASIN -----------------------------------------
# We upload <ASIN>.<ext> and BookOrbit derives the title from the filename, so
# the library showed "B074TH9GL3" instead of the book's name. The device
# basename carries the real title; Amazon mangles ':' to '_' in it.

def test_title_strips_the_asin_suffix():
    from app.identity import title_from_basename
    assert title_from_basename(
        "Invincible Compendium Vol. 1_B07MJHX8R3", "B07MJHX8R3"
    ) == "Invincible Compendium Vol. 1"


def test_title_restores_colons_amazon_mangled():
    from app.identity import title_from_basename
    assert title_from_basename(
        "Halo_ Rise of Atriox #1 (Halo Rise of Atriox)_B074TH9GL3", "B074TH9GL3"
    ) == "Halo: Rise of Atriox #1 (Halo Rise of Atriox)"


def test_title_handles_several_mangled_colons():
    from app.identity import title_from_basename
    got = title_from_basename(
        "Babel_ Or the Necessity of Violence_ An Arcane History_B09MD95S5V",
        "B09MD95S5V")
    assert got == "Babel: Or the Necessity of Violence: An Arcane History"


def test_title_keeps_underscores_that_are_not_separators():
    # "Vol. 17_ Something" is a mangled colon; a bare underscore inside a word
    # is not, and must survive.
    from app.identity import title_from_basename
    assert title_from_basename("Some_Title_B01B1YHS9Y", "B01B1YHS9Y") == "Some_Title"


def test_title_falls_back_when_the_asin_is_absent():
    from app.identity import title_from_basename
    assert title_from_basename("No Asin Here", "B0MISSING1") == "No Asin Here"


def test_title_never_returns_empty():
    from app.identity import title_from_basename
    assert title_from_basename("B074TH9GL3", "B074TH9GL3") == "B074TH9GL3"
