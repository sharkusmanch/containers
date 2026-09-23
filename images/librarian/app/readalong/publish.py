"""Publish a gated read-along into its book folder, in the final layout, and
verify it. Every step re-derives the truth from BookOrbit and the disk, so a
run killed at any point is finished by the next one without redoing work.

Final layout (the standing audit's `readalong_layout` check):
    NN. Title.epub           the read-along -- BookOrbit's primary
    NN. Title (ebook).epub   the plain ebook
    NN. Title.m4b            the audiobook
where `NN. Title` is the book folder's basename.

BookOrbit's scanner matches files by PATH before inode: a scan that finds a
known path holding a different file rebinds that path's record to it (file ids
shuffle, the read-along link can be lost). So the plain EPUB is renamed away,
SCANNED, and the link is gated on BookOrbit's own view: the plain EPUB and the
m4b recorded under their new names and no record left at the clean name.

Library-side calls: os.link onto an absent name (EEXIST: stop), and unlink of
the old name only after the link (a rename that can never overwrite). Nothing
in the library is ever deleted or overwritten. Every path is checked to lie
under the library root, and the staged read-along under the staging root; it
is unlinked only after the verified publish.
"""
import os
import time

from app.readalong.candidates import is_readalong_file, pair_key

VERIFY_SECONDS = 900
SCAN_IDLE_WAIT = 600


class PublishError(Exception):
    """This book stops for tonight; the next run resumes it."""


class FilesChanged(PublishError):
    """The book no longer holds exactly the aligned EPUB + m4b pair: the
    alignment no longer applies (the caller abandons it)."""


class PublishConflict(PublishError):
    """A file that is not this book's holds a name we need. Nothing was moved."""

    def __init__(self, message, path):
        super().__init__(message)
        self.path = path


def _under(path, root, what):
    real, base = os.path.realpath(path), os.path.realpath(root)
    if os.path.commonpath([real, base]) != base or real == base:
        raise PublishError(f"{what} {path!r} is not under {root!r}")
    return path


def local_path(media_books, books_prefix, api_path):
    if not (api_path or "").startswith(books_prefix + "/"):
        raise PublishError(f"unexpected BookOrbit path {api_path!r}")
    return _under(os.path.join(media_books, api_path[len(books_prefix) + 1:]), media_books, "book folder")


def targets(detail):
    """Names for the final layout from the book's current folder."""
    folder = (detail.get("folderPath") or "").rstrip("/")
    stem = folder.rsplit("/", 1)[-1]
    if not stem:
        raise PublishError(f"book {detail.get('id')} has no folderPath")
    files = detail.get("files") or []
    plain = [f for f in files if (f.get("format") or "").lower() == "epub" and not is_readalong_file(f)]
    m4b = [f for f in files if (f.get("format") or "").lower() == "m4b"]
    return {"folder": folder, "stem": stem, "plain": plain[0] if len(plain) == 1 else None,
            "m4b": m4b[0] if len(m4b) == 1 else None, "clean": f"{stem}.epub",
            "ebook": f"{stem} (ebook).epub", "m4b_name": f"{stem}.m4b"}


def _same_inode(a, b):
    try:
        sa, sb = os.lstat(a), os.lstat(b)
    except FileNotFoundError:
        return False
    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)


def _move_no_clobber(src, dst):
    """link + unlink: never replaces `dst`. False when `dst` holds something
    else; True when moved (or when `dst` already IS `src`)."""
    if _same_inode(src, dst):
        os.unlink(src)
        return True
    try:
        os.link(src, dst, follow_symlinks=False)
    except FileExistsError:
        return False
    os.unlink(src)
    return True


def wait_idle(lib, library_id, *, sleep=time.sleep, clock=time.monotonic, timeout=SCAN_IDLE_WAIT):
    deadline = clock() + timeout
    while lib.scan_running(library_id):
        if clock() >= deadline:
            raise PublishError(f"a scan of library {library_id} is still running after {timeout // 60} min")
        sleep(10)


def _scan(lib, library_id):
    try:
        lib.scan(library_id)
    except Exception as e:          # a failed or timed-out scan: the book resumes next run
        raise PublishError(f"scan of library {library_id}: {e}") from e


def rekey(d, pair, t):
    """Match the pair's two files in `d` by id, or -- after a foreign scan
    landed between our link() and unlink() and gave a file a new record -- by
    its final name and unchanged size. Returns the (possibly new) pair."""
    plain_id, plain_size, m4b_id, m4b_size = pair
    files = d.get("files") or []
    ids = {f["id"]: f for f in files}
    by_name = {f.get("filename"): f for f in files}

    def find(fid, size, name):
        f = ids.get(fid)
        if f is not None and int(f.get("sizeBytes") or -1) == size:
            return f
        f = by_name.get(name)
        if f is not None and int(f.get("sizeBytes") or -1) == size and f["id"] not in (plain_id, m4b_id):
            return f
        return None
    p, m = find(plain_id, plain_size, t["ebook"]), find(m4b_id, m4b_size, t["m4b_name"])
    if p is None or m is None:
        return None
    return (p["id"], plain_size, m["id"], m4b_size)


def _check_names(folder, t, own_names, expected):
    """No on-disk entry may collide, even by case, with a name we are about to
    create -- unless BookOrbit lists it for this book, or it sits at exactly
    the name a killed run gave one of our files and has that file's size."""
    wanted = {t["clean"].casefold(), t["ebook"].casefold(), t["m4b_name"].casefold()}
    for name in os.listdir(folder):
        if name.casefold() not in wanted or name in own_names:
            continue
        path = os.path.join(folder, name)
        if name in expected and os.path.isfile(path) and os.path.getsize(path) == expected[name]:
            continue
        raise PublishConflict(f"{path} is not one of the book's files", path)


def _current(lib, book_id, pair, media_books, books_prefix):
    """Fresh detail, its layout names and local folder, and the pair -- re-keyed
    by final name and size when a foreign scan gave a file a new id, but only
    while the book still holds exactly one plain EPUB and one m4b."""
    d = lib.detail(book_id)
    files = d.get("files") or []
    t = targets(d)
    folder = local_path(media_books, books_prefix, t["folder"])
    if any(is_readalong_file(f) for f in files):
        return d, t, folder, pair
    if pair_key(files) is None:
        raise FilesChanged("the book no longer holds exactly one plain EPUB and one m4b")
    if pair_key(files) != tuple(pair):
        rekeyed = rekey(d, pair, t)
        if rekeyed is None:
            raise FilesChanged("the book's files changed since alignment")
        pair = rekeyed
    return d, t, folder, pair


def publish(lib, book_id, staged, pair, *, media_books="/media/books", books_prefix="/books",
            staging_dir=None, sleep=time.sleep, clock=time.monotonic):
    """Put `staged` (the gated read-along, on the library's filesystem) into
    book `book_id` in the final layout. Returns (verified detail, pair) -- the
    pair re-keyed when a foreign scan gave one of its files a new id."""
    if staging_dir:
        _under(staged, staging_dir, "staged read-along")
    d, t, folder, pair = _current(lib, book_id, pair, media_books, books_prefix)
    linked = _same_inode(staged, os.path.join(folder, t["clean"]))
    if not linked and not any(is_readalong_file(f) for f in d.get("files") or []):
        lib_id = d["libraryId"]
        wait_idle(lib, lib_id, sleep=sleep, clock=clock)
        # re-read after the wait: BookOrbit may have renamed or moved the book meanwhile
        d, t, folder, pair = _current(lib, book_id, pair, media_books, books_prefix)
        files = d.get("files") or []
        _check_names(folder, t, {f.get("filename") for f in files},
                     {t["ebook"]: pair[1], t["m4b_name"]: pair[3]})

        # 1. rename phase: the plain EPUB and the m4b to their final names
        moved = False
        for fid, name in ((pair[0], t["ebook"]), (pair[2], t["m4b_name"])):
            f = next(x for x in files if x["id"] == fid)
            if f["filename"] == name:
                continue
            src, dst = os.path.join(folder, f["filename"]), os.path.join(folder, name)
            if os.path.lexists(src):
                if not _move_no_clobber(src, dst):
                    raise PublishConflict(f"{dst} already exists and is not book {book_id}'s file", dst)
            elif not (os.path.isfile(dst) and os.path.getsize(dst) == int(f["sizeBytes"])):
                # neither where BookOrbit says nor where a killed run would have put it
                raise PublishError(f"{src} is missing on disk")
            moved = True                        # moved now, or by a run killed before its scan

        # 2. the link is gated on BookOrbit's view, whatever this run did
        for attempt in (1, 2):
            if moved:
                _scan(lib, lib_id)
            d2, t2, folder2, pair = _current(lib, book_id, pair, media_books, books_prefix)
            if folder2 != folder:
                raise PublishError(f"the book moved to {t2['folder']} during the publish")
            names = {f["id"]: f.get("filename") for f in d2.get("files") or []}
            ready = (names.get(pair[0]) == t["ebook"] and names.get(pair[2]) == t["m4b_name"]
                     and not any((n or "").casefold() == t["clean"].casefold() for n in names.values()))
            if ready:
                break
            if attempt == 2:
                raise PublishError(f"BookOrbit has not recorded the renames: {names}")
            moved = True                        # BookOrbit is behind the disk: scan, then look again
        clean = os.path.join(folder, t["clean"])
        if os.path.lexists(clean):
            raise PublishConflict(f"{clean} already exists and is not the read-along", clean)
        wait_idle(lib, lib_id, sleep=sleep, clock=clock)
        try:
            os.link(staged, clean, follow_symlinks=False)
        except FileExistsError:
            raise PublishConflict(f"{clean} appeared just before the link", clean) from None
        except FileNotFoundError as e:
            raise PublishError(f"link failed: {e}") from None
        linked = True
        d = d2
    if linked and not any(is_readalong_file(f) and f.get("filename") == t["clean"]
                          for f in lib.detail(book_id).get("files") or []):
        _scan(lib, d["libraryId"])          # linked, but BookOrbit has not seen it yet

    # 3. verify
    d = _verify(lib, book_id, staged, pair, sleep, clock)
    if os.path.lexists(staged):
        os.unlink(staged)
    return d, pair


def _verify(lib, book_id, staged, pair, sleep, clock):
    deadline = clock() + VERIFY_SECONDS
    size = os.path.getsize(staged) if os.path.exists(staged) else None
    while True:
        d = lib.detail(book_id)
        problem = _problem(d, pair, size)
        if problem is None:
            return d
        if clock() >= deadline:
            raise PublishError(f"verify: {problem}")
        sleep(15)


def _problem(d, pair, size):
    files = d.get("files") or []
    t = targets(d)
    ra = [f for f in files if is_readalong_file(f)]
    if len(ra) != 1:
        return f"{len(ra)} read-along files"
    ra = ra[0]
    if ra.get("role") != "primary":
        return "the read-along is not the primary file"
    if ra.get("filename") != t["clean"]:
        return f"the read-along is {ra.get('filename')!r}, not {t['clean']!r}"
    if size is not None and int(ra.get("sizeBytes") or -1) != size:
        return f"the read-along is {ra.get('sizeBytes')} bytes, staged {size}"
    plain_id, _ps, m4b_id, _ms = pair
    ids = {f["id"]: f.get("filename") for f in files}
    if ids.get(plain_id) != t["ebook"]:
        return f"the plain EPUB (file {plain_id}) is {ids.get(plain_id)!r}, not {t['ebook']!r}"
    if m4b_id not in ids:
        return f"the m4b (file {m4b_id}) is gone"
    sync = d.get("readAloudSync") or {}
    if sync.get("overlayFileId") != ra["id"] or sync.get("state") != "enabled":
        return f"read-along sync is {sync.get('state')!r} on file {sync.get('overlayFileId')}"
    return None
