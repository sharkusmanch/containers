import zipfile

from tests.conftest import make_epub, make_m4b, needs_ffmpeg, synthetic_map


def test_make_epub_structure(tmp_path):
    p = make_epub(tmp_path / "b.epub", [("c1.xhtml", "<p>Hello.</p>")])
    with zipfile.ZipFile(p) as z:
        assert z.namelist()[0] == "mimetype"
        assert z.getinfo("mimetype").compress_type == zipfile.ZIP_STORED
        assert "OEBPS/Text/c1.xhtml" in z.namelist()


def test_synthetic_map_shape():
    anchors, duration = synthetic_map("one two three", cps=10)
    assert anchors[0] == {"char": 0, "ts": 0.0}
    assert "t_idx" not in anchors[-1] and anchors[-1]["ts"] > duration
    assert [a["char"] for a in anchors[1:-1]] == [0, 4, 8]


@needs_ffmpeg
def test_make_m4b(tmp_path):
    import subprocess
    p = make_m4b(tmp_path / "a.m4b", 4.0, [0.0, 2.0])
    out = subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True, check=True).stdout.strip().splitlines()
    assert len(out) == 2
