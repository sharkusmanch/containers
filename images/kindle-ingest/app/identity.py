"""Book identity.

ASIN is the only stable identifier. Filenames are display metadata: Amazon
retitles books, and a retitled book keyed by filename looks new and uploads as
a duplicate.

Matching is deliberately narrow. A shape-only match (`B` + 9 uppercase chars)
accepts ordinary title words -- "The_BLACKBIRDS.kfx" would yield a fabricated
ASIN that then permanently occupies a ledger key. Real ASINs contain at least
one digit, which separates them from words cleanly.
"""
import os
import re

# Boundary on non-alphanumerics rather than "." or end-of-string, so the real
# on-device forms all match: Title_B0XXXXXXXXX.kfx, bare B0XXXXXXXXX.kfx,
# Title-asin_B0XXXXXXXXX-type_EBOK-v_0.azw3, and Title_B0XXXXXXXXX (1).kfx
ASIN_RE = re.compile(r"(?:^|[^0-9A-Za-z])(B[0-9A-Z]{9})(?![0-9A-Za-z])")


def _plausible(candidate: str) -> bool:
    """Real ASINs carry at least one digit; all-alpha tokens are title words."""
    return any(c.isdigit() for c in candidate)


def asin_of(name: str) -> str | None:
    """Extract the ASIN from a Kindle filename, or None if there isn't one.

    When a filename contains several ASIN-shaped tokens the FIRST plausible one
    wins, which matches the `Title-asin_<ASIN>-type_...` layout where the ASIN
    is announced by a label.
    """
    base = os.path.basename(name)
    for m in ASIN_RE.finditer(base):
        c = m.group(1)
        if _plausible(c):
            return c
    return None


def title_from_basename(basename: str, asin: str) -> str:
    """Recover a human-readable title from the device filename.

    We upload `<ASIN>.<ext>` and BookOrbit derives the title from the filename,
    so the library showed bare ASINs. The device basename carries the real
    title with the ASIN appended, and Amazon mangles ':' into '_' when it
    builds that filename ("Halo_ Rise of Atriox" was "Halo: Rise of Atriox").

    Only "_ " is treated as a mangled colon. A bare underscore inside a word is
    left alone, since it is not a separator. Never returns empty: a title is
    cosmetic and must not be able to fail an upload.
    """
    name = basename
    suffix = f"_{asin}"
    if asin and name.endswith(suffix):
        name = name[: -len(suffix)]
    name = name.replace("_ ", ": ").strip()
    return name or basename
