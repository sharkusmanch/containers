import pytest

from app import audio
from tests.conftest import make_m4b, needs_ffmpeg


@needs_ffmpeg
def test_encode_opus_segment_duration(tmp_path):
    src = make_m4b(tmp_path / "a.m4b", 6.0, [0.0, 3.0])
    out = tmp_path / "seg.mp4"
    audio.encode_opus(src, 1000, 3500, out)
    assert audio.probe_duration(out) == pytest.approx(2.5, abs=0.1)


@needs_ffmpeg
def test_cut_wav_16k_mono(tmp_path):
    import wave
    src = make_m4b(tmp_path / "a.m4b", 4.0, [0.0])
    out = tmp_path / "c.wav"
    audio.cut_wav(src, 0.5, 2.5, out)
    with wave.open(str(out)) as w:
        assert w.getnchannels() == 1 and w.getframerate() == 16000
        assert w.getnframes() / 16000 == pytest.approx(2.0, abs=0.05)


def test_missing_input_raises(tmp_path):
    if not audio.have_ffmpeg():
        pytest.skip("ffmpeg not installed")
    with pytest.raises(audio.AudioError):
        audio.probe_duration(tmp_path / "nope.mp4")
