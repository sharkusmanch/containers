import pytest
import requests

from app import repair as R
from app.anchors import Anchor, Gap


class FakeResp:
    def __init__(self, status, payload):
        self.status_code, self._p = status, payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        return self._p


class FakeSession:
    def __init__(self, behaviours):
        self.behaviours, self.calls = behaviours, []

    def post(self, url, **kw):
        self.calls.append(url)
        b = self.behaviours[url]
        if isinstance(b, Exception):
            raise b
        return b


def test_parse_words_both_shapes():
    top = {"words": [{"word": " Hi", "start": 0.0, "end": 0.3}]}
    seg = {"segments": [{"words": [{"word": "there", "start": 0.3, "end": 0.6}]}]}
    assert R.parse_words(top) == [R.Word("Hi", 0.0, 0.3)]
    assert R.parse_words(seg) == [R.Word("there", 0.3, 0.6)]


def test_client_falls_back_to_second_endpoint(tmp_path):
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")
    s = FakeSession({"http://a/v1/audio/transcriptions": requests.ConnectionError("down"),
                     "http://b/v1/audio/transcriptions": FakeResp(200, {"words": []})})
    c = R.WhisperClient([("http://a/v1", "big"), ("http://b/v1", "small")], session=s)
    assert c.transcribe(wav) == ([], "small")


def test_client_raises_when_all_down(tmp_path):
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")
    s = FakeSession({"http://a/v1/audio/transcriptions": FakeResp(503, {})})
    with pytest.raises(R.WhisperUnavailable):
        R.WhisperClient([("http://a/v1", "m")], session=s).transcribe(wav)


def test_book_tokens_join_drop_caps():
    text = "xx T hree men. A dog."
    toks = R.book_tokens(text, 3, len(text))
    assert [w for w, _ in toks] == ["three", "men", "a", "dog"]
    assert toks[0][1] == 3


def test_align_words_needs_three_word_blocks():
    b = [("the", 100), ("cat", 104), ("sat", 108), ("down", 112), ("x", 117)]
    t = [("the", 10.0), ("cat", 10.3), ("sat", 10.6), ("down", 10.9), ("y", 11.2)]
    out = R.align_words(b, t, 0, 1000, 5.0, 20.0)
    assert out == [Anchor(100, 10.0), Anchor(104, 10.3), Anchor(108, 10.6), Anchor(112, 10.9)]
    assert R.align_words(b[:2], t[:2], 0, 1000, 5.0, 20.0) == []


def test_repair_hole_chunks_and_offsets():
    text = "a " * 10 + "one two three four five six " + "b " * 10
    gap = Gap(19, len(text) - 20, 100.0, 1400.0, "hole")
    calls = []

    def transcribe_range(start, end):
        calls.append((start, end))
        if start == 100.0:
            return [R.Word(w, 100.0 + i, 100.5 + i) for i, w in enumerate("one two three four five six".split())]
        return []

    out = R.repair_hole(gap, text, transcribe_range)
    assert calls == [(100.0, 700.0), (700.0, 1300.0), (1300.0, 1400.0)]
    assert [a.ts for a in out] == [100.0, 101.0, 102.0, 103.0, 104.0, 105.0]
    assert all(gap.c_a < a.char < gap.c_b for a in out)
