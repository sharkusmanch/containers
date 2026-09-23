"""Intake-side filesystem operations for the executor.

Everything here touches the INTAKE tree only (`/media/library_intake`):
staging an arrival into `.executing/<sha12>/`, restoring it, and cleaning up
leftovers after a verified filing. Every destructive call asserts its path is
under the intake root first -- nothing in this module may delete, overwrite or
rename anything under `/media/books`. The one library-side move (the primary
file into a book folder) lives in app/executor.py, where it is journaled.
`hash_file` and `rename_collision` also look at library paths, read-only.

Moves use `os.link` + `os.unlink` (never `os.rename` onto a path that might
exist): `link` fails atomically with EEXIST instead of silently replacing,
and EXDEV (a different filesystem) fails instead of degrading to a copy.
"""
import hashlib
import os

# Libation leftovers that are safe to delete once the book is verified filed:
# cover art, the chapter cue sheet and Libation's JSON sidecars. Anything else
# (PDF supplements, extra m4b parts, any other audio/ebook file) is kept by
# moving it to `_supplements/<id>/` -- the review amendment's rule.
LIBATION_DELETABLE = (".jpg", ".png", ".cue", ".json")
# Kindle: the only leftover is kindle-ingest's `<ASIN>.json` sidecar.
KINDLE_DELETABLE = (".json",)

EXECUTING_DIR = ".executing"
SUPPLEMENTS_DIR = "_supplements"


class UnsafePath(RuntimeError):
    """A path the executor was about to act on is not where it must be."""


def sha12(key: str) -> str:
    """The deterministic per-arrival token used for `.executing/<sha12>/` and
    the `[lib-<sha12>]` folder suffix (sha256 of the arrival key)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def is_under(path: str, root: str) -> bool:
    """True when `path` (resolved) is strictly inside `root` (resolved).
    The parent directory is resolved, never the leaf, so a leaf symlink is
    judged by where it sits, not by where it points."""
    root_r = os.path.realpath(root)
    parent = os.path.realpath(os.path.dirname(os.path.abspath(path)))
    full = os.path.join(parent, os.path.basename(os.path.abspath(path)))
    return full.startswith(root_r + os.sep)


def require_under(path: str, root: str, what: str) -> None:
    if not is_under(path, root):
        raise UnsafePath(f"{what} {path!r} is not under {root!r}")


def staging_dir(intake_root: str, key: str) -> str:
    return os.path.join(intake_root, EXECUTING_DIR, sha12(key))


def plan_staging(arrival: dict, intake_root: str) -> tuple[str, list[list[str]], str]:
    """(staging dir, [[original, staged], ...], staged primary) -- no side
    effects. A folder arrival (libation, manual folder) is renamed whole onto
    the staging dir; a file arrival (kindle file + its sidecar, manual file)
    gets a fresh staging dir and each file renamed into it."""
    path = os.path.abspath(arrival["path"])
    primary = os.path.abspath(arrival["primary"])
    require_under(path, intake_root, "arrival path")
    if os.path.islink(path):
        raise UnsafePath(f"arrival path {path!r} is a symlink")
    sdir = staging_dir(intake_root, arrival["key"])
    if os.path.isdir(path):
        if not primary.startswith(path + os.sep):
            raise UnsafePath(f"primary {primary!r} is not inside arrival folder {path!r}")
        return sdir, [[path, sdir]], os.path.join(sdir, os.path.relpath(primary, path))
    if primary != path:
        raise UnsafePath(f"primary {primary!r} is not the arrival file {path!r}")
    items = [[path, os.path.join(sdir, os.path.basename(path))]]
    if arrival.get("source") == "kindle":
        side = os.path.splitext(path)[0] + ".json"
        if os.path.isfile(side) and not os.path.islink(side):
            items.append([side, os.path.join(sdir, os.path.basename(side))])
    return sdir, items, items[0][1]


def stage(sdir: str, items: list[list[str]], intake_root: str) -> None:
    """Step 0: move the arrival out of the watcher's sight (dot-dir)."""
    require_under(sdir, intake_root, "staging dir")
    os.makedirs(os.path.dirname(sdir), exist_ok=True)
    if len(items) == 1 and items[0][1] == sdir:
        if os.path.lexists(sdir):
            raise FileExistsError(f"staging dir {sdir} already exists")
        os.rename(items[0][0], sdir)
        return
    os.mkdir(sdir)                         # exclusive: fails if it exists
    for orig, staged in items:
        os.rename(orig, staged)            # into a dir we just created empty


def unstage(sdir: str, items: list[list[str]], intake_root: str) -> str | None:
    """Put a staged arrival back where the watcher found it. Returns an error
    string (and leaves things as they are) if an original path is occupied
    again; None on success or when there is nothing staged."""
    require_under(sdir, intake_root, "staging dir")
    if not os.path.lexists(sdir):
        return None
    # only items that actually reached the staging dir are restored (a stage
    # may have been interrupted part-way); an original path that is occupied
    # AND has a staged copy is a conflict -- never overwrite either one
    for orig, staged in items:
        if os.path.lexists(orig) and os.path.lexists(staged):
            return f"cannot restore arrival: {orig} exists again; it stays at {sdir}"
    if len(items) == 1 and items[0][1] == sdir:
        os.rename(sdir, items[0][0])
        return None
    for orig, staged in items:
        if os.path.lexists(staged) and not os.path.lexists(orig):
            os.rename(staged, orig)
    try:
        os.rmdir(sdir)
    except OSError:
        return f"restored the arrival files, but {sdir} was not empty"
    return None


def _move_no_clobber(src: str, dst: str) -> bool:
    try:
        os.link(src, dst, follow_symlinks=False)
    except FileExistsError:
        return False
    os.unlink(src)
    return True


def cleanup(source: str, sdir: str, intake_root: str, supplement_id: str) -> dict:
    """Clear the staging dir after the filed file was VERIFIED in BookOrbit.

    libation: delete *.jpg|*.png|*.cue|*.json, move everything else to
    `_supplements/<supplement_id>/`. kindle: delete the sidecar. manual:
    delete nothing; move leftovers to `_supplements/`. A name that already
    exists in `_supplements/` is never overwritten -- it stays in the staging
    dir and is reported under "left". Empty directories are removed.
    """
    require_under(sdir, os.path.join(intake_root, EXECUTING_DIR), "staging dir")
    deletable = {"libation": LIBATION_DELETABLE, "kindle": KINDLE_DELETABLE}.get(source, ())
    supp = os.path.join(intake_root, SUPPLEMENTS_DIR, supplement_id)
    out = {"deleted": [], "supplements": [], "left": []}
    if not os.path.isdir(sdir):
        return out
    for dirpath, dirnames, filenames in os.walk(sdir, topdown=False):
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            require_under(p, sdir, "leftover")
            if os.path.islink(p):
                out["left"].append(p)
                continue
            if name.lower().endswith(deletable):
                os.unlink(p)
                out["deleted"].append(name)
                continue
            os.makedirs(supp, exist_ok=True)
            if _move_no_clobber(p, os.path.join(supp, name)):
                out["supplements"].append(name)
            else:
                out["left"].append(p)
        for d in dirnames:
            dp = os.path.join(dirpath, d)
            if not os.path.islink(dp):
                try:
                    os.rmdir(dp)
                except OSError:
                    pass
    try:
        os.rmdir(sdir)
    except OSError:
        pass
    return out


def hash_file(path: str, beat, beat_every: int) -> str:
    """sha256 of `path`, calling `beat()` at least every `beat_every` bytes
    so hashing a multi-GB audiobook never reads as a stalled loop."""
    h = hashlib.sha256()
    since = 0
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(8 << 20)
            if not buf:
                break
            h.update(buf)
            since += len(buf)
            if since >= beat_every:
                beat()
                since = 0
    beat()
    return h.hexdigest()


def rename_collision(index, book_id, library: str, rendered: str, lib_root: str, own: str) -> str | None:
    """Guard 8 before rename-files, on FRESH index data. Returns why the
    rename must be skipped, or None. Collisions (folder paths casefolded,
    trailing "/" stripped):
      * another book in the library already has the rendered folder;
      * another book's folder is an ANCESTOR of it (ours would nest inside);
      * the rendered folder is an ancestor of another book's folder;
      * the rendered path escapes the library root;
      * any directory between the author dir and the target is a known book
        folder on disk (realpath, any library);
      * `<root>/<rendered>` already exists on disk and is not our own folder.
    Read-only: never touches the filesystem beyond stat/realpath."""
    prefix = f"/books/{library}/"
    want = rendered.casefold().rstrip("/")
    others = {}                                  # realpath of another book's folder -> id
    for b in index.books():
        if b.get("id") == book_id:
            continue
        fp = b.get("folderPath") or ""
        try:
            others[os.path.realpath(index.local_path(fp.rstrip("/")))] = b.get("id")
        except ValueError:
            pass
        if b.get("libraryName") != library:
            continue
        tail = (fp[len(prefix):] if fp.startswith(prefix) else fp).casefold().rstrip("/")
        if not tail:
            continue
        if tail == want:
            return f"{rendered!r} is book {b.get('id')}'s folder"
        if want.startswith(tail + "/"):
            return f"{rendered!r} would nest inside book {b.get('id')}'s folder"
        if tail.startswith(want + "/"):
            return f"book {b.get('id')}'s folder would nest inside {rendered!r}"
    target = os.path.join(lib_root, rendered)
    if not is_under(target, lib_root):
        return f"{rendered!r} escapes the library"
    anc = os.path.dirname(target)
    while is_under(anc, lib_root):
        bid = others.get(os.path.realpath(anc))
        if bid is not None:
            return f"{anc} on the way to {rendered!r} is book {bid}'s folder"
        anc = os.path.dirname(anc)
    if os.path.lexists(target) and os.path.realpath(target) != os.path.realpath(own):
        return f"{target} already exists on disk"
    return None
