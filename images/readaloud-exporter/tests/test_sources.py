import sqlite3

from app import absclient, bbsource


def make_db(path):
    c = sqlite3.connect(path)
    c.executescript("""
    create table books(abs_id text, abs_title text, ebook_filename text, status text, audio_source text);
    create table book_alignments(abs_id text, alignment_map_json text, last_updated text, align_method text, total_chars int);
    create table settings(key text, value text);
    insert into books values ('a1','Zeta','z.epub','active','ABS'),('a2','Alpha','a.epub','active','ABS'),
      ('a3','Linear','l.epub','active','ABS'),('a4','Paused','p.epub','paused','ABS');
    insert into book_alignments values ('a1','[{"char": 1}]','2026-01-01','lexical',10),('a2','[]','2026-01-02','lexical_timed',20),
      ('a3','[]','x','linear',5),('a4','[]','x','lexical',5);
    insert into settings values ('ABS_SERVER','http://abs:80'),('ABS_KEY','k');
    """)
    c.commit()
    c.close()


def test_eligible_filters_and_sorts(tmp_path):
    db = tmp_path / "d.db"
    make_db(db)
    b = bbsource.BookBridgeDB(db)
    assert [r.abs_id for r in b.eligible(None)] == ["a2", "a1"]
    assert [r.abs_id for r in b.eligible({"a1"})] == ["a1"]
    assert b.settings()["ABS_SERVER"] == "http://abs:80"


def test_eligible_rows_carry_no_map_and_map_loads_on_demand(tmp_path):
    db = tmp_path / "d.db"
    make_db(db)
    b = bbsource.BookBridgeDB(db)
    rows = b.eligible(None)
    assert rows and all(r.map_json == "" for r in rows)
    assert b.map_json("a1") == '[{"char": 1}]'


def test_eligible_allowlist_is_pushed_into_sql(tmp_path):
    db = tmp_path / "d.db"
    make_db(db)
    b = bbsource.BookBridgeDB(db)
    seen = []
    b.conn.set_trace_callback(seen.append)
    assert [r.abs_id for r in b.eligible({"a1"})] == ["a1"]
    q = [x for x in seen if "book_alignments" in x]
    assert q and "b.abs_id in ('a1')" in q[-1] and "alignment_map_json" not in q[-1]
    seen.clear()
    assert [r.abs_id for r in b.eligible(set())] == []


def test_db_is_read_only(tmp_path):
    db = tmp_path / "d.db"
    make_db(db)
    b = bbsource.BookBridgeDB(db)
    try:
        b.conn.execute("insert into settings values ('x','y')")
        raised = False
    except sqlite3.OperationalError:
        raised = True
    assert raised


def test_resolve_epub_recursive(tmp_path):
    (tmp_path / "books" / "Author").mkdir(parents=True)
    target = tmp_path / "books" / "Author" / "Book [x].epub"
    target.write_bytes(b"x")
    assert bbsource.resolve_epub("Book [x].epub", [str(tmp_path / "nope"), str(tmp_path / "books")]) == target
    assert bbsource.resolve_epub("missing.epub", [str(tmp_path / "books")]) is None


class Resp:
    def __init__(self, j):
        self.j = j

    def raise_for_status(self):
        pass

    def json(self):
        return self.j


class Sess:
    def __init__(self, j):
        self.j, self.calls = j, []

    def get(self, url, **kw):
        self.calls.append((url, kw))
        return Resp(self.j)


def test_abs_item_parsing():
    j = {"path": "/audiobooks/Book [B1]", "media": {"duration": 100.5,
         "audioFiles": [{"metadata": {"path": "/audiobooks/Book [B1]/Book.m4b"}}],
         "chapters": [{"start": 0}, {"start": 50.25}]}}
    s = Sess(j)
    item = absclient.ABSClient("http://abs:80", "tok", session=s).item("id1")
    assert item == absclient.AudioItem("/audiobooks/Book [B1]", "/audiobooks/Book [B1]/Book.m4b", 100.5, [0.0, 50.25], 1)
    assert s.calls[0][0] == "http://abs:80/api/items/id1"
    assert s.calls[0][1]["headers"]["Authorization"] == "Bearer tok"
