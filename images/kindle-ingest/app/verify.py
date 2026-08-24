"""Artifact verification.

"Verified in BookOrbit" is a CONJUNCTION, not an HTTP 200. Cleanup deletes the
only other copy of a book off the device, and the failure this guards against is
real and was observed by hand: a truncated pull yields a structurally valid but
incomplete EPUB, the upload returns 200, and the device source is deleted --
leaving a corrupt library entry that an additive-only pipeline can never replace.

All four conditions must hold before any deletion:
  1. upload returned an id                        -> bookorbit.upload
  2. the server holds a file of matching size     -> bookorbit.verify
  3. the artifact is structurally sound           -> here
  4. the local archive matches its recorded hash  -> here
"""
import hashlib
import os
import re
import zipfile

MIN_TEXT_CHARS = 500          # a whole prose book below this is not a real book
MIN_CBZ_PAGES = 1


class ArtifactInvalid(Exception):
    pass


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def archive_intact(path: str, expected_sha256: str | None) -> bool:
    """Condition 4. An unrecorded hash cannot vouch for anything."""
    if not expected_sha256 or not os.path.exists(path):
        return False
    return sha256_file(path) == expected_sha256


def _strip(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    return re.sub(r"<[^>]+>", " ", s)


def verify_epub(path: str) -> None:
    """Condition 3 for prose. Raises ArtifactInvalid with a specific reason."""
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise ArtifactInvalid("missing or empty file")
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise ArtifactInvalid(f"not a zip: {e}") from e
    with z:
        if z.testzip() is not None:
            raise ArtifactInvalid("corrupt zip member")
        opfs = [n for n in z.namelist() if n.lower().endswith(".opf")]
        if not opfs:
            raise ArtifactInvalid("no OPF")
        opf = z.read(opfs[0]).decode("utf-8", "ignore")
        spine = re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf)
        if not spine:
            raise ArtifactInvalid("empty spine")
        text = 0
        for n in z.namelist():
            if n.lower().endswith((".xhtml", ".html", ".htm")):
                text += len(_strip(z.read(n).decode("utf-8", "ignore")).strip())
                if text >= MIN_TEXT_CHARS:
                    return
    raise ArtifactInvalid(f"only {text} chars of text; truncated conversion?")


def verify_cbz(path: str, expected_pages: int | None = None) -> None:
    """Condition 3 for comics."""
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise ArtifactInvalid("missing or empty file")
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise ArtifactInvalid(f"not a zip: {e}") from e
    with z:
        if z.testzip() is not None:
            raise ArtifactInvalid("corrupt zip member")
        pages = [n for n in z.namelist()
                 if n.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp"))]
        if len(pages) < MIN_CBZ_PAGES:
            raise ArtifactInvalid("no page images")
        if expected_pages is not None and len(pages) != expected_pages:
            raise ArtifactInvalid(f"{len(pages)} pages, expected {expected_pages}")
        if any(z.getinfo(n).file_size == 0 for n in pages):
            raise ArtifactInvalid("zero-byte page image")


def verify_artifact(path: str, kind: str, expected_pages: int | None = None) -> None:
    if kind == "cbz":
        verify_cbz(path, expected_pages)
    else:
        verify_epub(path)
