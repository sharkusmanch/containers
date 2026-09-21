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
    assert any(f.startswith("V5") for f in r.failures)
