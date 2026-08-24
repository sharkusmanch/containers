"""In-cluster KFX decryption using a per-book key emitted by the device.

The device emits a 98-byte record per book (`voucherid$secret_key:<hex>`); the
vendored DeDRM modules consume that directly via SKeyList, so no PIDs, no
account secret and no device involvement are needed here. Verified to produce
output byte-identical to the device's own.
"""
import os
import sys

VENDOR_DIR = os.environ.get("VENDOR_DIR", "/opt/vendor")


class DecryptFailed(Exception):
    """The archive yielded no decrypted content."""


def _kfx_zip_book():
    """Import lazily so tests can run without the vendored modules present."""
    if VENDOR_DIR not in sys.path:
        sys.path.insert(0, VENDOR_DIR)
    from kfxdedrm import KFXZipBook
    return KFXZipBook


def decrypt_archive(encrypted_path: str, keyfile_path: str, out_path: str) -> int:
    """Decrypt an encrypted .kfx-zip. Returns the number of decrypted entries."""
    KFXZipBook = _kfx_zip_book()
    book = KFXZipBook(encrypted_path, keyfile_path)
    book.processBook([])                 # no PIDs -- the skeylist carries the key
    n = len(getattr(book, "decrypted", {}) or {})
    if n == 0:
        raise DecryptFailed(f"no DRMION entries decrypted from {encrypted_path}")
    tmp = out_path + ".part"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    book.getFile(tmp)
    os.replace(tmp, out_path)            # atomic: "exists" means "complete"
    return n
