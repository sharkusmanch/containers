"""Read-along worker: which books get a read-along tonight."""
from datetime import datetime, timezone

from app.readalong.candidates import ERROR_LIMIT, pair_key, select
from app.readalong.state import State

NOW = datetime(2026, 9, 24, 7, 30, tzinfo=timezone.utc).timestamp()


def f(fid, fmt, size, overlay=None):
    x = {"id": fid, "format": fmt, "role": "content", "sizeBytes": size}
    if overlay is not None:
        x["mediaOverlay"] = {"available": overlay}
    return x


def book(bid, files, updated="2026-09-23T19:00:00.000Z", tags=()):
    return {"id": bid, "title": f"B{bid}", "files": files, "updatedAt": updated, "tags": list(tags)}


PAIR = [f(1, "epub", 100, False), f(2, "m4b", 200)]


def test_pair_key_needs_exactly_one_plain_epub_and_one_m4b():
    assert pair_key(PAIR) == (1, 100, 2, 200)
    assert pair_key(PAIR + [f(3, "pdf", 5)]) == (1, 100, 2, 200)          # a PDF alongside is fine
    assert pair_key(PAIR + [f(3, "m4b", 5)]) is None                      # two audiobooks
    assert pair_key(PAIR + [f(3, "epub", 5, False)]) is None              # two plain EPUBs
    assert pair_key(PAIR + [f(3, "epub", 5, True)]) is None               # already a read-along
    assert pair_key([f(1, "epub", 100)]) is None                          # ebook only
    assert pair_key([f(1, "EPUB", 100), f(2, "M4B", 200)]) == (1, 100, 2, 200)


def test_select_funnel_and_order(tmp_path):
    st = State.load(str(tmp_path / "s.json"))
    st.refuse(5, (51, 100, 52, 200), "D", ["grade D"], now=1)
    st.refuse(6, (61, 100, 62, 200), "D", ["grade D"], now=1)
    for _ in range(ERROR_LIMIT):
        st.add_error(7, (71, 100, 72, 200), "boom", now=1)
    books = [
        book(1, PAIR, updated="2026-09-22T10:00:00.000Z"),
        book(2, [f(21, "epub", 1, False), f(22, "m4b", 2)], updated="2026-09-23T20:00:00.000Z"),
        book(3, [f(31, "epub", 1, True), f(32, "epub", 1, False), f(33, "m4b", 1)]),
        book(4, [f(41, "epub", 1, False)]),
        book(5, [f(51, "epub", 100, False), f(52, "m4b", 200)]),                 # refused, same files
        book(6, [f(61, "epub", 101, False), f(62, "m4b", 200)]),                 # refused, EPUB changed
        book(7, [f(71, "epub", 100, False), f(72, "m4b", 200)]),                 # error limit
        book(8, [f(81, "epub", 1, False), f(82, "m4b", 2)], updated="2026-09-24T07:00:00.000Z"),
        book(9, [f(91, "epub", 1, False), f(92, "m4b", 2)], tags=[{"id": 3, "name": "No-ReadAlong"}]),
        book(10, [f(101, "epub", 1, False), f(102, "m4b", 2)], tags=["no-readalong"]),
    ]
    chosen, funnel = select(books, st, NOW, quiet_hours=2)
    assert [b["id"] for b in chosen] == [2, 6, 1]            # newest updatedAt first
    assert funnel == {"total": 10, "has_readalong": 1, "no_pair": 1, "tagged_no_readalong": 2,
                      "refused_same_files": 1, "error_limit": 1, "too_recent": 1, "eligible": 3}


def test_select_only_restricts_and_counts_the_rest(tmp_path):
    st = State.load(str(tmp_path / "s.json"))
    books = [book(1, PAIR), book(2, [f(21, "epub", 1, False), f(22, "m4b", 2)])]
    chosen, funnel = select(books, st, NOW, quiet_hours=2, only=frozenset({2}))
    assert [b["id"] for b in chosen] == [2] and funnel["not_in_only"] == 1


def test_an_unparseable_timestamp_counts_as_too_recent(tmp_path):
    st = State.load(str(tmp_path / "s.json"))
    chosen, funnel = select([book(1, PAIR, updated="yesterday-ish")], st, NOW, quiet_hours=2)
    assert chosen == [] and funnel["too_recent"] == 1
