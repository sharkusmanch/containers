import os
import pytest
from app import decrypt
from app.decrypt import decrypt_archive, DecryptFailed

SPIKE = "/private/tmp/claude-501/-Users-marcus/ae9250ee-b9bc-4a27-bff1-68c3e98c8019/scratchpad/spike"
VENDOR = "/private/tmp/claude-501/-Users-marcus/ae9250ee-b9bc-4a27-bff1-68c3e98c8019/scratchpad/ddrm"
ONDEV = os.path.expanduser("~/Books/kindle-dedrm/kfx-zip/Halo_ Rise of Atriox #1 (Halo Rise of Atriox)_B074TH9GL3.kfx-zip")
have_fixtures = os.path.exists(os.path.join(SPIKE, "encrypted.kfx-zip")) and os.path.exists(VENDOR)


def test_raises_when_nothing_decrypted(tmp_path, monkeypatch):
    class Fake:
        def __init__(self, *a, **k): self.decrypted = {}
        def processBook(self, pids): pass
    monkeypatch.setattr(decrypt, "_kfx_zip_book", lambda: Fake)
    with pytest.raises(DecryptFailed):
        decrypt_archive("in", "k", str(tmp_path / "o.kfx-zip"))


def test_writes_atomically_leaving_no_partial(tmp_path, monkeypatch):
    out = tmp_path / "o.kfx-zip"
    class Fake:
        def __init__(self, *a, **k): self.decrypted = {"a": b"x"}
        def processBook(self, pids): pass
        def getFile(self, p): open(p, "wb").write(b"done")
    monkeypatch.setattr(decrypt, "_kfx_zip_book", lambda: Fake)
    assert decrypt_archive("in", "k", str(out)) == 1
    assert out.read_bytes() == b"done"
    assert not (tmp_path / "o.kfx-zip.part").exists()


@pytest.mark.skipif(not have_fixtures, reason="spike fixtures unavailable")
def test_real_book_decrypts_identically_to_the_device(tmp_path, monkeypatch):
    """Integration: the whole point of the design -- off-device output must
    match what the Kindle itself produced, byte for byte."""
    import hashlib, zipfile
    monkeypatch.setenv("VENDOR_DIR", VENDOR)
    monkeypatch.setattr(decrypt, "VENDOR_DIR", VENDOR)
    out = tmp_path / "d.kfx-zip"
    n = decrypt_archive(os.path.join(SPIKE, "encrypted.kfx-zip"),
                        os.path.join(SPIKE, "book.key"), str(out))
    assert n == 7
    a = zipfile.ZipFile(ONDEV); b = zipfile.ZipFile(out)
    common = set(a.namelist()) & set(b.namelist())
    assert len(common) == 8
    for name in common:
        assert hashlib.sha256(a.read(name)).hexdigest() == hashlib.sha256(b.read(name)).hexdigest()
