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


class KeyUnavailable(DecryptFailed):
    """The keyfile carried no record for this book.

    Distinct from a failed decryption because the cause is on the device, not
    in the book: emit_keys can return a partial keyfile when the Kindle sleeps
    mid-pass. The next cycle emits the key, so this is retryable -- whereas a
    key that is present but wrong means the book really cannot be decrypted.
    """


def _kfx_zip_book():
    """Import lazily so tests can run without the vendored modules present."""
    if VENDOR_DIR not in sys.path:
        sys.path.insert(0, VENDOR_DIR)
    from kfxdedrm import KFXZipBook
    return KFXZipBook


def _is_missing_key(e: Exception) -> bool:
    """A zero-length key means no key was found, not that decryption failed.

    The vendored code falls through every voucher candidate, then hands AES an
    empty key from the (empty) skeylist. "Incorrect padding - Wrong key" is the
    different, terminal case: a key was found and it did not work.
    """
    # Only the AES signature is checkable. "Failed all decryption attempts and
    # no key candidate available" looks like the obvious marker but ion.py
    # prints it and then re-raises the LAST voucher exception, so that text
    # never reaches an exception message.
    return "key length (0 bytes)" in str(e)


def decrypt_archive(encrypted_path: str, keyfile_path: str, out_path: str) -> int:
    """Decrypt an encrypted .kfx-zip. Returns the number of decrypted entries."""
    KFXZipBook = _kfx_zip_book()
    try:
        book = KFXZipBook(encrypted_path, keyfile_path)
        book.processBook([])             # no PIDs -- the skeylist carries the key
        n = len(getattr(book, "decrypted", {}) or {})
    except DecryptFailed:
        raise
    except Exception as e:
        # The vendored DeDRM code raises whatever it likes. Callers classify
        # DecryptFailed; anything else escapes and takes the whole cycle down.
        msg = f"{type(e).__name__}: {e}"
        if _is_missing_key(e):
            raise KeyUnavailable(msg) from e
        raise DecryptFailed(msg) from e
    if n == 0:
        raise DecryptFailed(f"no DRMION entries decrypted from {encrypted_path}")
    tmp = out_path + ".part"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    book.getFile(tmp)
    os.replace(tmp, out_path)            # atomic: "exists" means "complete"
    return n
