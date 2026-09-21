import json
import sqlite3
import zipfile

from app import main as M
from app import textmap
from app.absclient import AudioItem
from app.bbsource import BookRow
from app.repair import Word
from tests.conftest import make_epub, make_m4b, needs_ffmpeg, synthetic_map

BODIES = [("c0.xhtml", "<h1>Front matter</h1>" + "<p>" + "Legal text. " * 300 + "</p>"),
          ("c1.xhtml", "<p>" + " ".join(f"Sentence number {i} is here." for i in range(40)) + "</p>"),
          ("c2.xhtml", "<p>" + " ".join(f"Another line {i} ends." for i in range(40)) + "</p>")]


class FakeABS:
    def __init__(self, item):
        self._item = item

    def item(self, _):
        return self._item


class FakeWhisper:
    def __init__(self, words=None, fail=False):
        self.words, self.fail, self.calls = words or [], fail, 0

    def transcribe(self, wav):
        self.calls += 1
        if self.fail:
            from app.repair import WhisperUnavailable
            raise WhisperUnavailable("down")
        return self.words, "fake"


def setup_book(tmp_path, drop_middle=False, audio_gap_s=0.0):
    books = tmp_path / "books"
    books.mkdir()
    src = make_epub(books / "Book (2020).epub", BODIES)
    ref = textmap.reference_string(textmap.reference_documents(src))
    # front matter is un-narrated: map starts at doc 1 with a 5 s lead
    start = ref.index("Sentence number 0")
    anchors, _ = synthetic_map(ref[start:], cps=15.0, lead=5.0)
    for a in anchors:
        a["char"] += start if "t_idx" in a else 0
    anchors = [a for a in anchors if "t_idx" in a]
    duration = 5.0 + (len(ref) - start) / 15.0 + 1.0
    if drop_middle:
        c_lo, c_hi = ref.index("Sentence number 5"), ref.index("Another line 30")
        anchors = [a for a in anchors if not (c_lo < a["char"] < c_hi)]
    ch2 = 5.0 + (ref.index("Another line 0") - start) / 15.0
    if audio_gap_s:
        # a stretch of audio with (almost) no text: e.g. music between two sentences
        c_gap = ref.index("Sentence number 20")
        for a in anchors:
            if a["char"] >= c_gap:
                a["ts"] += audio_gap_s
        duration += audio_gap_s
        ch2 += audio_gap_s
    abs_dir = tmp_path / "audiobooks" / "Book [B1]"
    abs_dir.mkdir(parents=True)
    m4b = make_m4b(abs_dir / "Book.m4b", duration, [0.0, ch2])
    row = BookRow("a1", "Book", "Book (2020).epub", "lexical", len(ref), json.dumps(
        [{"char": 0, "ts": 0.0}] + anchors + [{"char": len(ref), "ts": duration + 30}]), "2026-09-21")
    item = AudioItem(str(abs_dir), str(m4b), duration, [0.0, ch2], 1)
    cfg = M.Config(db_path=str(tmp_path / "x.db"), books_roots=[str(books)], out_dir=str(tmp_path / "out"),
                   tmp_dir=str(tmp_path / "tmp"), whisper=[], only=None, max_books=3, bitrate="32k", path_map=[])
    (tmp_path / "tmp").mkdir()
    return row, item, cfg, ref, start


@needs_ffmpeg
def test_end_to_end_ok_then_skipped(tmp_path):
    row, item, cfg, ref, _ = setup_book(tmp_path)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "2026-09-21T00:00:00Z")
    assert out.status == "ok", out
    folder = tmp_path / "out" / "Book [B1]"
    epub = folder / "Book (2020) (readaloud).epub"
    manifest = json.loads((folder / ".Book (2020).readaloud.json").read_text())
    assert epub.exists() and manifest["status"] == "ok"
    assert abs(manifest["verify"]["overlay_seconds"] - item.duration) < 0.002
    with zipfile.ZipFile(epub) as z:
        assert any(n.startswith("OEBPS/Audio/ra-") for n in z.namelist())
    again = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "2026-09-21T00:00:00Z")
    assert again.status == "skipped"


@needs_ffmpeg
def test_text_mismatch_refused_and_not_retried(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    row.total_chars += 1
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "2026-09-21T00:00:00Z")
    assert out.status == "refused" and out.reason == "text_mismatch"
    assert not list((tmp_path / "out" / "Book [B1]").glob("*.epub"))
    assert M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t").status == "skipped"


@needs_ffmpeg
def test_hole_repaired_from_transcript(tmp_path):
    row, item, cfg, ref, start = setup_book(tmp_path, drop_middle=True)
    words = []
    import re
    for m in re.finditer(r"\S+", ref[start:]):
        words.append(Word(m.group(0), 5.0 + m.start() / 15.0, 5.0 + m.start() / 15.0 + 0.2))

    class RangeWhisper(FakeWhisper):
        """Returns chunk-relative words, as a real whisper server does."""
        def transcribe(self, wav):
            self.calls += 1
            s_ms, e_ms = (int(x) for x in wav.stem.split("-"))
            s, e = s_ms / 1000, e_ms / 1000
            return [Word(x.text, x.start - s, x.end - s) for x in self.words if s <= x.start < e], "fake"

    w = RangeWhisper(words=words)
    out = M.process_book(row, cfg, FakeABS(item), w, "2026-09-21T00:00:00Z")
    assert out.status == "ok", out
    assert out.detail["repaired_anchors"] > 0 and w.calls >= 1


@needs_ffmpeg
def test_hole_with_whisper_down_is_deferred(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path, drop_middle=True)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(fail=True), "t")
    assert out.status == "deferred" and out.reason == "whisper_unavailable"
    assert M.process_book(row, cfg, FakeABS(item), FakeWhisper(fail=True), "t").status == "deferred"


class FakeDB:
    def __init__(self, rows):
        self.rows = rows

    def eligible(self, only):
        return list(self.rows)

    def map_json(self, abs_id):
        return next(r.map_json for r in self.rows if r.abs_id == abs_id)


class ABSByID:
    """Item for known ids; raises (-> deferred abs_unavailable) for every other id."""
    def __init__(self, items):
        self.items = items

    def item(self, abs_id):
        if abs_id not in self.items:
            raise ConnectionError("server down")
        return self.items[abs_id]


@needs_ffmpeg
def test_corrupt_previous_manifest_is_ignored(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    folder = tmp_path / "out" / "Book [B1]"
    folder.mkdir(parents=True)
    (folder / ".Book (2020).readaloud.json").write_text("{not json")
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "ok", out
    assert json.loads((folder / ".Book (2020).readaloud.json").read_text())["status"] == "ok"


def test_run_survives_a_book_that_raises(tmp_path, monkeypatch):
    rows = [BookRow("bad", "Bad", "x.epub", "lexical", 1, "[]", "t"),
            BookRow("good", "Good", "y.epub", "lexical", 1, "[]", "t")]

    def fake_process(row, *a, **k):
        if row.abs_id == "bad":
            raise RuntimeError("boom")
        return M.Outcome(row.abs_id, row.title, "ok")

    monkeypatch.setattr(M, "process_book", fake_process)
    cfg = M.Config(out_dir=str(tmp_path), tmp_dir=str(tmp_path), max_books=3)
    outs = M.run(cfg, FakeDB(rows), None, None)
    assert [(o.abs_id, o.status) for o in outs] == [("bad", "error"), ("good", "ok")]
    assert outs[0].reason == "RuntimeError" and "boom" in outs[0].detail["error"]


def test_process_book_never_raises_on_pre_try_failure(tmp_path):
    row = BookRow("a1", "Book", "Book.epub", "lexical", 1, "[]", "t")
    item = AudioItem(str(tmp_path / "Book [B1]"), str(tmp_path / "missing.m4b"), 10.0, [0.0], 1)
    cfg = M.Config(books_roots=[str(tmp_path)], out_dir=str(tmp_path / "out"),
                   tmp_dir=str(tmp_path / "does-not-exist"))
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "error" and out.reason == "FileNotFoundError"


@needs_ffmpeg
def test_deferred_books_do_not_count_against_cap(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    cfg.max_books = 1
    rows = [BookRow("d1", "D1", "x.epub", "lexical", 1, "[]", "t"),
            BookRow("d2", "D2", "y.epub", "lexical", 1, "[]", "t"), row]
    outs = M.run(cfg, FakeDB(rows), ABSByID({"a1": item}), FakeWhisper())
    assert [(o.abs_id, o.status) for o in outs] == [("d1", "deferred"), ("d2", "deferred"), ("a1", "ok")]


def test_cap_counts_ok_and_refused_only(tmp_path, monkeypatch):
    statuses = {"r1": "refused", "o1": "ok", "x": "ok"}
    rows = [BookRow(i, i, "e.epub", "lexical", 1, "[]", "t") for i in statuses]
    monkeypatch.setattr(M, "process_book", lambda row, *a, **k: M.Outcome(row.abs_id, row.title, statuses[row.abs_id]))
    outs = M.run(M.Config(max_books=2), FakeDB(rows), None, None)
    assert [o.abs_id for o in outs] == ["r1", "o1"]


@needs_ffmpeg
def test_missing_readaloud_is_re_exported(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    assert M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t").status == "ok"
    epub = tmp_path / "out" / "Book [B1]" / "Book (2020) (readaloud).epub"
    epub.unlink()
    again = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert again.status == "ok" and epub.exists()


class MapDB:
    """eligible() rows carry no map (as the real DB); map_json() is recorded per call."""
    def __init__(self, row):
        self.full, self.calls = row.map_json, []
        self.row = BookRow(row.abs_id, row.title, row.ebook_filename, row.align_method, row.total_chars,
                           "", row.last_updated)

    def eligible(self, only):
        return [self.row]

    def map_json(self, abs_id):
        self.calls.append(abs_id)
        return self.full


@needs_ffmpeg
def test_run_loads_the_map_lazily_for_the_processed_book(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    db = MapDB(row)
    outs = M.run(cfg, db, FakeABS(item), FakeWhisper())
    assert [(o.abs_id, o.status) for o in outs] == [("a1", "ok")], outs
    assert db.calls == ["a1"]


def test_code_hash_covers_the_package_source():
    import hashlib
    from pathlib import Path
    h = hashlib.sha256()
    for p in sorted(Path(M.__file__).parent.glob("*.py")):
        h.update(p.name.encode() + b"\0" + p.read_bytes() + b"\0")
    assert M.CODE_SHA256 == h.hexdigest()


@needs_ffmpeg
def test_code_change_reprocesses_a_refused_book(tmp_path, monkeypatch):
    row, item, cfg, _, _ = setup_book(tmp_path)
    row.total_chars += 1
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "refused" and out.detail["fingerprint_inputs"]["code_sha256"] == M.CODE_SHA256
    manifest = json.loads((tmp_path / "out" / "Book [B1]" / ".Book (2020).readaloud.json").read_text())
    assert manifest["code_sha256"] == M.CODE_SHA256
    assert M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t").status == "skipped"
    monkeypatch.setattr(M, "CODE_SHA256", "0" * 64)
    again = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert again.status == "refused" and again.reason == "text_mismatch"


@needs_ffmpeg
def test_audio_only_gap_is_repaired_but_not_gated(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path, audio_gap_s=90.0)
    w = FakeWhisper()  # the stretch is music: the transcript finds nothing
    out = M.process_book(row, cfg, FakeABS(item), w, "t")
    assert out.status == "ok", out
    d = out.detail
    assert w.calls >= 1
    assert d["audio_only_gaps"] == 1 and d["audio_only_seconds"] >= 90.0 and d["audio_only_max_s"] >= 90.0
    assert d["residual_audio_only"] == 1 and d["max_par_s"] >= 90.0
    assert d["holes"] == 0


@needs_ffmpeg
def test_audio_only_gap_with_whisper_down_is_deferred(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path, audio_gap_s=90.0)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(fail=True), "t")
    assert out.status == "deferred" and out.reason == "whisper_unavailable"


def _patch_opf(epub, fn):
    with zipfile.ZipFile(epub) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    with zipfile.ZipFile(epub, "w") as z:
        for info, data in items:
            if info.filename.endswith(".opf"):
                data = fn(data.decode()).encode()
            z.writestr(info, data, compress_type=info.compress_type)


@needs_ffmpeg
def test_book_wide_pre_paginated_is_refused(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    _patch_opf(tmp_path / "books" / "Book (2020).epub", lambda o: o.replace(
        "</metadata>", '<meta property="rendition:layout">pre-paginated</meta></metadata>'))
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "refused" and out.reason == "fixed_layout"


@needs_ffmpeg
def test_per_item_pre_paginated_spine_property_is_not_fixed_layout(tmp_path):
    row, item, cfg, _, _ = setup_book(tmp_path)
    epub = tmp_path / "books" / "Book (2020).epub"
    _patch_opf(epub, lambda o: o.replace('<itemref idref="d0"/>',
                                         '<itemref idref="d0" properties="rendition:layout-pre-paginated"/>'))
    assert not M._is_fixed_layout(epub)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "ok", out


@needs_ffmpeg
def test_audio_encode_failure_is_a_refusal(tmp_path, monkeypatch):
    row, item, cfg, _, _ = setup_book(tmp_path)

    def boom(*a, **k):
        raise M.audio.AudioError("ffmpeg failed (1): bad stream")

    monkeypatch.setattr(M.audio, "encode_opus", boom)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "refused" and out.reason == "audio_encode_failed", out
    assert "bad stream" in out.detail["error"]


@needs_ffmpeg
def test_epub_structure_error_is_a_refusal_and_part_removed(tmp_path, monkeypatch):
    row, item, cfg, _, _ = setup_book(tmp_path)

    def broken(src, dst, *a, **k):
        from pathlib import Path
        Path(dst).write_bytes(b"partial")
        raise ValueError("manifest collision: x y")

    monkeypatch.setattr(M.epubwrite, "write_readaloud", broken)
    out = M.process_book(row, cfg, FakeABS(item), FakeWhisper(), "t")
    assert out.status == "refused" and out.reason == "epub_structure", out
    folder = tmp_path / "out" / "Book [B1]"
    assert not list(folder.glob("*.part")) and not list(folder.glob(".*.part"))
    assert not list(folder.glob("*.epub"))


def test_from_env_parses_valid_config():
    cfg = M.Config.from_env({"WHISPER_ENDPOINTS": "http://a/v1|big, http://b/v1|small",
                             "MAX_BOOKS_PER_RUN": "0", "EXPORT_ONLY_ABS_IDS": "x, y"})
    assert cfg.whisper == [("http://a/v1", "big"), ("http://b/v1", "small")]
    assert cfg.max_books == 0 and cfg.only == {"x", "y"}
    assert M.Config.from_env({}).whisper == []


import pytest  # noqa: E402


@pytest.mark.parametrize("env", [
    {"WHISPER_ENDPOINTS": "http://a/v1"},
    {"WHISPER_ENDPOINTS": "http://a/v1|"},
    {"WHISPER_ENDPOINTS": "|model"},
    {"MAX_BOOKS_PER_RUN": "three"},
    {"MAX_BOOKS_PER_RUN": "-1"},
])
def test_from_env_rejects_bad_config(env):
    with pytest.raises(M.ConfigError):
        M.Config.from_env(env)


def test_main_returns_2_on_bad_config(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    sqlite3.connect(db).close()
    monkeypatch.setenv("DB_PATH", str(db))
    monkeypatch.setenv("WHISPER_ENDPOINTS", "http://a/v1")
    assert M.main() == 2
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["event"] == "config_error" and "WHISPER_ENDPOINTS" in line["error"]


def test_main_returns_2_on_missing_db(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "missing.db"))
    monkeypatch.delenv("WHISPER_ENDPOINTS", raising=False)
    monkeypatch.delenv("MAX_BOOKS_PER_RUN", raising=False)
    assert M.main() == 2
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["event"] == "config_error" and "missing.db" in line["error"]


def test_main_logs_config_line_without_secrets(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    c = sqlite3.connect(db)
    c.executescript("""
    create table books(abs_id text, abs_title text, ebook_filename text, status text, audio_source text);
    create table book_alignments(abs_id text, alignment_map_json text, last_updated text, align_method text,
                                 total_chars int);
    create table settings(key text, value text);
    insert into settings values ('ABS_SERVER','http://abs:80'),('ABS_KEY','sekrit');
    """)
    c.commit()
    c.close()
    monkeypatch.setenv("DB_PATH", str(db))
    monkeypatch.setenv("WHISPER_ENDPOINTS", "http://a/v1|big")
    monkeypatch.setenv("EXPORT_ONLY_ABS_IDS", "x,y")
    monkeypatch.setenv("OUT_DIR", str(tmp_path / "out"))
    monkeypatch.delenv("MAX_BOOKS_PER_RUN", raising=False)
    assert M.main() == 0
    out = capsys.readouterr().out
    lines = [json.loads(x) for x in out.strip().splitlines()]
    cfg_lines = [x for x in lines if x["event"] == "config"]
    assert len(cfg_lines) == 1 and lines[0]["event"] == "config"
    c = cfg_lines[0]
    assert c["whisper_endpoints"] == ["http://a/v1|big"] and c["only_count"] == 2
    assert c["max_books"] == 3 and c["out_dir"] == str(tmp_path / "out")
    assert "sekrit" not in out
