"""Keep BookOrbit's boolean custom field "Read-Along" (key `read_along`)
explicitly true or false on every book of the flagged libraries: smart scopes'
`isFalse` only matches an explicit false, and the librarian files new books
without it. Replaces the manual sync_readalong_flag.py."""
import logging

from app.readalong.candidates import is_readalong_file

logger = logging.getLogger(__name__)
FIELD_KEY = "read_along"


def field_id(client) -> int:
    for f in client.get("/custom-metadata/fields") or []:
        if f.get("key") == FIELD_KEY and not f.get("archivedAt"):
            return int(f["id"])
    raise RuntimeError(f"BookOrbit has no active custom field {FIELD_KEY!r}")


def _current(book, fid):
    for m in book.get("customMetadata") or []:
        if m.get("fieldId") == fid:
            return True, m.get("value")
    return False, None


def sync_flags(lib, books, fid, *, libraries, dry_run):
    """Returns (changed, failed). A list record carries no library id; the
    field is present on every book of a flagged library, so only a book
    WITHOUT it needs a detail read to tell a new book from a comic."""
    changed = failed = 0
    for b in books:
        want = any(is_readalong_file(f) for f in b.get("files") or [])
        present, value = _current(b, fid)
        if present and value is want:
            continue
        try:                    # one book (deleted since the listing, a failed PATCH) never stops the sync
            if not present and lib.detail(b["id"]).get("libraryId") not in libraries:
                continue
            if dry_run:
                logger.info("would set Read-Along=%s on book %s", want, b["id"])
            else:
                lib.set_flag(b["id"], fid, want)
            changed += 1
        except Exception as e:
            failed += 1
            logger.warning("Read-Along flag on book %s: %s", b["id"], e)
    return changed, failed
