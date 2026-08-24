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
