"""Book identity.

ASIN is the only stable identifier. Filenames are display metadata: Amazon
retitles books, and a retitled book keyed by filename looks like a new book
and uploads as a duplicate.
"""
import os
import re

ASIN_RE = re.compile(r"_(B[0-9A-Z]{9})(?:\.|$)")


def asin_of(name: str) -> str | None:
    """Extract the ASIN from a Kindle filename, or None if absent."""
    base = os.path.basename(name)
    m = ASIN_RE.search(base)
    return m.group(1) if m else None
