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
