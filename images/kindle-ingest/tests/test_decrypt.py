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


# --- the vendored decoder's exceptions must be contained --------------------

def test_arbitrary_vendor_exception_becomes_decrypt_failed(tmp_path, monkeypatch):
    # Observed in the cluster: the keyfile held no record for this book, so the
    # vendored code reached AES with a zero-length key and raised ValueError.
    # _process only classifies DecryptFailed; anything else escaped the cycle.
    import app.decrypt as D

    class Boom:
        def __init__(self, *a): pass
        def processBook(self, pids):
            raise ValueError("Incorrect AES key length (0 bytes)")

    monkeypatch.setattr(D, "_kfx_zip_book", lambda: Boom)
    with pytest.raises(D.DecryptFailed) as e:
        D.decrypt_archive(str(tmp_path / "in.kfx-zip"), "k.txt", str(tmp_path / "o"))
    assert "AES key length" in str(e.value)   # the cause survives for the ledger


def test_keyerror_from_the_vendor_also_becomes_decrypt_failed(tmp_path, monkeypatch):
    import app.decrypt as D

    class Boom:
        def __init__(self, *a): raise KeyError("voucher")

    monkeypatch.setattr(D, "_kfx_zip_book", lambda: Boom)
    with pytest.raises(D.DecryptFailed):
        D.decrypt_archive(str(tmp_path / "in.kfx-zip"), "k.txt", str(tmp_path / "o"))


# --- a missing key is transient, not a defective book -----------------------
# emit_keys can return a partial keyfile: the Kindle sleeps aggressively and the
# on-device pass is cut short. A book whose key was not emitted reaches AES with
# a zero-length key. That is a device-timing problem -- the next cycle emits the
# key -- so it must not be recorded as a permanent failure.

def test_missing_key_is_reported_as_key_unavailable(tmp_path, monkeypatch):
    import app.decrypt as D

    class NoKey:
        def __init__(self, *a): pass
        def processBook(self, pids):
            raise ValueError("Incorrect AES key length (0 bytes)")

    monkeypatch.setattr(D, "_kfx_zip_book", lambda: NoKey)
    with pytest.raises(D.KeyUnavailable):
        D.decrypt_archive(str(tmp_path / "in"), "k.txt", str(tmp_path / "o"))


def test_key_unavailable_is_still_a_decrypt_failure(tmp_path, monkeypatch):
    # Callers that only know DecryptFailed must still catch it.
    import app.decrypt as D
    assert issubclass(D.KeyUnavailable, D.DecryptFailed)


def test_a_real_decryption_error_is_not_mistaken_for_a_missing_key(tmp_path, monkeypatch):
    # A wrong (but present) key must stay terminal, or a genuinely broken book
    # would retry forever.
    import app.decrypt as D

    class WrongKey:
        def __init__(self, *a): pass
        def processBook(self, pids):
            raise Exception("Incorrect padding - Wrong key")

    monkeypatch.setattr(D, "_kfx_zip_book", lambda: WrongKey)
    with pytest.raises(D.DecryptFailed) as e:
        D.decrypt_archive(str(tmp_path / "in"), "k.txt", str(tmp_path / "o"))
    assert not isinstance(e.value, D.KeyUnavailable)
