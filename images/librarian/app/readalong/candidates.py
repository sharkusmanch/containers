"""Which books get a read-along tonight. Pure: BookOrbit list records in,
an ordered list and a funnel of counts out (logged every run, so a zero is
proved rather than assumed)."""
from collections import Counter
from datetime import datetime

OPT_OUT_TAG = "no-readalong"     # set in BookOrbit's UI to keep a book out for good
ERROR_LIMIT = 3                  # failed attempts on the same file pair before giving up


def _fmt(f):
    return (f.get("format") or "").lower()


def is_readalong_file(f) -> bool:
    return _fmt(f) == "epub" and bool((f.get("mediaOverlay") or {}).get("available"))


def pair_key(files):
    """(epub id, epub size, m4b id, m4b size) when the book holds exactly one
    plain EPUB and one m4b and no read-along; else None."""
    epubs = [f for f in files if _fmt(f) == "epub"]
    plain = [f for f in epubs if not is_readalong_file(f)]
    m4bs = [f for f in files if _fmt(f) == "m4b"]
    if len(plain) != len(epubs) or len(plain) != 1 or len(m4bs) != 1:
        return None
    return (int(plain[0]["id"]), int(plain[0]["sizeBytes"]), int(m4bs[0]["id"]), int(m4bs[0]["sizeBytes"]))


def _tags(b):
    out = set()
    for t in b.get("tags") or []:
        name = t.get("name") if isinstance(t, dict) else t
        if isinstance(name, str):
            out.add(name.strip().casefold())
    return out


def _updated_epoch(b):
    try:
        return datetime.fromisoformat(str(b.get("updatedAt")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def select(books, state, now, *, quiet_hours, only=frozenset()):
    funnel = Counter(total=len(books))
    chosen = []
    for b in books:
        files = b.get("files") or []
        if only and b.get("id") not in only:
            funnel["not_in_only"] += 1
            continue
        if any(is_readalong_file(f) for f in files):
            funnel["has_readalong"] += 1
            continue
        pair = pair_key(files)
        if pair is None:
            funnel["no_pair"] += 1
            continue
        if OPT_OUT_TAG in _tags(b):
            funnel["tagged_no_readalong"] += 1
            continue
        if state.is_refused(b["id"], pair):
            funnel["refused_same_files"] += 1
            continue
        if state.error_count(b["id"], pair) >= ERROR_LIMIT:
            funnel["error_limit"] += 1
            continue
        updated = _updated_epoch(b)
        if updated is None or now - updated < quiet_hours * 3600:
            funnel["too_recent"] += 1
            continue
        chosen.append((updated, b))
    chosen.sort(key=lambda x: -x[0])
    funnel["eligible"] = len(chosen)
    return [b for _u, b in chosen], {k: v for k, v in funnel.items() if v or k in ("total", "eligible")}
