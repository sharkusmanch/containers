import pytest
import zipfile
from app.device import parse_book_listing, build_encrypted_archive, DeviceBook

LISTING = """Jade City (The Green Bone Saga Book 1)_B06XRCBRX8|532480|2
Onyx Storm (The Empyrean Book 3)_B0CW1FKFB9|687633|0
cs-5.19.5-jb|1234|0
The Walking Dead #151_B01B1YHS9Y|16000|3"""


def test_parses_listing_keyed_by_asin():
    b = parse_book_listing(LISTING)
    assert set(b) == {"B06XRCBRX8", "B0CW1FKFB9", "B01B1YHS9Y"}   # jailbreak payload dropped


def test_sizes_and_asset_counts():
    b = parse_book_listing(LISTING)
    assert b["B06XRCBRX8"].kfx_size == 532480
    assert b["B06XRCBRX8"].asset_count == 2


def test_zero_assets_marks_book_incomplete():
    b = parse_book_listing(LISTING)
    assert b["B0CW1FKFB9"].complete is False
    assert b["B06XRCBRX8"].complete is True


def test_malformed_lines_ignored():
    assert parse_book_listing("garbage\n\n|||\nx|y") == {}


def test_paths_derive_from_basename():
    b = parse_book_listing(LISTING)["B06XRCBRX8"]
    assert b.kfx_path.endswith("_B06XRCBRX8.kfx")
    assert b.sdr_path.endswith("_B06XRCBRX8.sdr")
    assert b.assets_path.endswith("_B06XRCBRX8.sdr/assets")


def test_build_encrypted_archive_is_flat(tmp_path):
    src = tmp_path / "src"
    (src / "assets" / "attachables").mkdir(parents=True)
    (src / "Book_B0TEST12345.kfx").write_bytes(b"kfx")
    (src / "assets" / "metadata.kfx").write_bytes(b"meta")
    (src / "assets" / "voucher").write_bytes(b"vouch")
    (src / "assets" / "attachables" / "CR!AAA.kfx").write_bytes(b"cr")
    out = build_encrypted_archive(str(src), str(tmp_path / "out.kfx-zip"))
    assert sorted(zipfile.ZipFile(out).namelist()) == [
        "Book_B0TEST12345.kfx", "CR!AAA.kfx", "metadata.kfx", "voucher"]


def test_build_encrypted_archive_leaves_no_partial(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.kfx").write_bytes(b"x")
    out = build_encrypted_archive(str(src), str(tmp_path / "o.kfx-zip"))
    assert not (tmp_path / "o.kfx-zip.part").exists()


def test_empty_source_refuses_rather_than_writing_empty_archive(tmp_path):
    src = tmp_path / "empty"
    src.mkdir()
    with pytest.raises(ValueError):
        build_encrypted_archive(str(src), str(tmp_path / "o.kfx-zip"))
    assert not (tmp_path / "o.kfx-zip").exists()


def test_delete_targets_never_include_the_sdr_itself():
    b = DeviceBook("B0TEST12345", "Book_B0TEST12345", 100, 2)
    targets = [b.kfx_path, b.assets_path]
    assert not any(t.endswith(".sdr") for t in targets)   # .sdr is reading history
    assert any(t.endswith(".sdr/assets") for t in targets)


# --- regressions for the shell-injection finding ---------------------------

def test_real_apostrophe_titles_are_accepted():
    """Rejecting these would reject books the user actually owns."""
    from app.device import _unsafe_name
    for n in ["The Butcher's Masquerade_ DCC Book 5_B09R6C5X88",
              "Cul-de-sac Carnage _ (Discount Dan's Backroom Bargains Book 2)_B0DZXSB9L3",
              "The Walking Dead #151_B01B1YHS9Y",
              "A Parade of Horribles_ DCC, Book 8_B0GJJDXG4L",
              "Exodus_ The Helium Sea (Book 2)_B0FRFPWXMF"]:
        assert not _unsafe_name(n), n


def test_shell_metacharacters_are_refused_not_escaped():
    from app.device import _unsafe_name
    for n in ["evil`whoami`", "x$(id)", 'a"b', "line\nbreak", "back\\slash", "", "   "]:
        assert _unsafe_name(n), n


def test_fetch_book_refuses_an_unsafe_basename(tmp_path):
    from app.device import Device, DeviceBook, UnsafeName
    class Cfg:
        kindle_host="h"; kindle_port=2222; ssh_key_path="/k"; socks_proxy="p:1"
        ssh_connect_timeout=5; rclone_timeout=5
    b = DeviceBook("B0TEST1234", "evil`whoami`_B0TEST1234", 10, 2)
    with pytest.raises(UnsafeName):
        Device(Cfg()).fetch_book(b, str(tmp_path / "d"))
