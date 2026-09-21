import posixpath
import zipfile

from app import epubwrite as W
from app import segment, textmap
from app.timing import AudioFile, Par
from app.verify import verify
from tests.conftest import make_epub


def fixture(tmp_path, gap=False):
    src = make_epub(tmp_path / "src.epub", [("c0.xhtml", "<p>One. Two.</p>"), ("c1.xhtml", "<p>Three.</p>")])
    docs = textmap.build(src)
    pars, t = [], 0
    for d in docs:
        frags = segment.fragments(d)
        segment.wrap(d, frags)
        for f in frags:
            pars.append(Par(f.id, d.index, t, t + 1000, f.c0, f.c1))
            t += 1000
    if gap:
        pars[1].end -= 200
    files = [AudioFile("ra-0001.mp4", 0, 3000)]
    p = tmp_path / "ra-0001.mp4"
    p.write_bytes(b"\0")
    dst = tmp_path / "out.epub"
    W.write_readaloud(src, dst, docs, pars, files, {"ra-0001.mp4": p}, "2026-09-21T00:00:00Z")
    return src, dst


def fake_duration(zf, name):
    return 3.0


def test_good_output_passes(tmp_path):
    src, dst = fixture(tmp_path)
    r = verify(src, dst, 3.0, audio_duration=fake_duration)
    assert r.ok, r.failures
    assert r.overlay_seconds == 3.0


def test_duration_mismatch_fails_v1(tmp_path):
    src, dst = fixture(tmp_path)
    r = verify(src, dst, 10.0, audio_duration=fake_duration)
    assert not r.ok and any(f.startswith("V1") for f in r.failures)


def test_gap_fails_v3(tmp_path):
    src, dst = fixture(tmp_path, gap=True)
    r = verify(src, dst, 2.8, audio_duration=fake_duration)
    assert any(f.startswith("V3") for f in r.failures)


def test_text_change_fails_v5(tmp_path):
    src, dst = fixture(tmp_path)
    tampered = tmp_path / "t.epub"
    with zipfile.ZipFile(dst) as zi, zipfile.ZipFile(tampered, "w") as zo:
        for info in zi.infolist():
            data = zi.read(info)
            if info.filename == "OEBPS/Text/c1.xhtml":
                data = data.replace(b"Three.", b"Thr33.")
            zo.writestr(info, data)
    r = verify(src, tampered, 3.0, audio_duration=fake_duration)
    # V5 (edited-tree body text) and V6 (bs4/ebooklib reference text) are independent
    # checks over independent representations of the document; a real non-whitespace
    # text change must be caught by both.
    assert any(f.startswith("V5") for f in r.failures)
    assert any(f.startswith("V6") for f in r.failures)


def test_irregular_whitespace_at_split_point_passes_v6(tmp_path):
    # Regression: a sentence boundary that falls on non-ASCII-space whitespace (here a
    # hair space, U+200A, between the closing quotes) makes segment.wrap() split the
    # text node so bs4's get_text(" ", strip=True) re-joins across that split with a
    # single ASCII space, differing byte-for-byte from the untouched source even though
    # no non-whitespace text changed. V6 must be whitespace-insensitive.
    body = "<p>Define ‘a little.’ ” I consider lying.</p>"
    src = make_epub(tmp_path / "src.epub", [("c0.xhtml", body)])
    docs = textmap.build(src)
    pars, t = [], 0
    for d in docs:
        frags = segment.fragments(d)
        segment.wrap(d, frags)
        for f in frags:
            pars.append(Par(f.id, d.index, t, t + 1000, f.c0, f.c1))
            t += 1000
    assert len(pars) >= 2  # the boundary must actually split the text node
    files = [AudioFile("ra-0001.mp4", 0, len(pars) * 1000)]
    p = tmp_path / "ra-0001.mp4"
    p.write_bytes(b"\0")
    dst = tmp_path / "out_ws.epub"
    W.write_readaloud(src, dst, docs, pars, files, {"ra-0001.mp4": p}, "2026-09-21T00:00:00Z")
    r = verify(src, dst, len(pars) * 1.0, audio_duration=lambda zf, name: len(pars) * 1.0)
    assert r.ok, r.failures


# --- two-audio-file fixture: ra-0001.mp4 covers 0-2000ms, ra-0002.mp4 covers 2000-3000ms ---

def two_file_fixture(tmp_path):
    src = make_epub(tmp_path / "src.epub", [("c0.xhtml", "<p>One. Two.</p>"), ("c1.xhtml", "<p>Three.</p>")])
    docs = textmap.build(src)
    pars, t = [], 0
    for d in docs:
        frags = segment.fragments(d)
        segment.wrap(d, frags)
        for f in frags:
            pars.append(Par(f.id, d.index, t, t + 1000, f.c0, f.c1))
            t += 1000
    files = [AudioFile("ra-0001.mp4", 0, 2000), AudioFile("ra-0002.mp4", 2000, 3000)]
    audio_paths = {}
    for f in files:
        p = tmp_path / f.name
        p.write_bytes(b"\0")
        audio_paths[f.name] = p
    dst = tmp_path / "out2.epub"
    W.write_readaloud(src, dst, docs, pars, files, audio_paths, "2026-09-21T00:00:00Z")
    return src, dst


def fake_duration_two(overrides=None):
    durations = {"ra-0001.mp4": 2.0, "ra-0002.mp4": 1.0}
    if overrides:
        durations.update(overrides)

    def f(zf, name):
        return durations[posixpath.basename(name)]

    return f


def test_two_files_fully_consumed_passes(tmp_path):
    src, dst = two_file_fixture(tmp_path)
    r = verify(src, dst, 3.0, audio_duration=fake_duration_two())
    assert r.ok, r.failures


def test_file_not_fully_consumed_fails_v3(tmp_path):
    src, dst = two_file_fixture(tmp_path)
    r = verify(src, dst, 3.0, audio_duration=fake_duration_two({"ra-0001.mp4": 2.5}))
    assert any(f.startswith("V3") for f in r.failures)


def test_new_file_nonzero_start_fails_v3(tmp_path):
    src, dst = two_file_fixture(tmp_path)
    tampered = tmp_path / "t2.epub"
    with zipfile.ZipFile(dst) as zi, zipfile.ZipFile(tampered, "w") as zo:
        for info in zi.infolist():
            data = zi.read(info)
            if info.filename == "OEBPS/MediaOverlays/ra-0001.smil":
                data = data.replace(b'clipBegin="0.000s"', b'clipBegin="0.100s"')
            zo.writestr(info, data)
    r = verify(src, tampered, 3.0, audio_duration=fake_duration_two())
    assert any(f.startswith("V3") for f in r.failures)
