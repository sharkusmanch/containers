"""Repair unanchored narrated stretches: transcribe exactly the audio between
two anchors and align it word-by-word to exactly the text between them."""
from __future__ import annotations

import difflib
import os
import re
import unicodedata
from dataclasses import dataclass
from typing import Callable

import requests

from app.anchors import Anchor, Gap

CHUNK_SECONDS = 600
MIN_BLOCK = 3
_TOKEN = re.compile(r"[\w'’]+", re.UNICODE)


@dataclass
class Word:
    text: str
    start: float
    end: float


class WhisperUnavailable(Exception):
    pass


def parse_words(j: dict) -> list[Word]:
    ws = j.get("words") or [w for s in (j.get("segments") or []) for w in (s.get("words") or [])]
    return [Word(str(w.get("word", "")).strip(), float(w["start"]), float(w["end"]))
            for w in ws if "start" in w and "end" in w]


class WhisperClient:
    def __init__(self, endpoints: list[tuple[str, str]], session=None, timeout=(5, 1800)):
        self.endpoints = endpoints
        self.session = session or requests.Session()
        self.timeout = timeout

    def transcribe(self, wav_path) -> tuple[list[Word], str]:
        if not self.endpoints:
            raise WhisperUnavailable("no whisper endpoints configured (WHISPER_ENDPOINTS is empty)")
        errors = []
        for url, model in self.endpoints:
            try:
                with open(wav_path, "rb") as fh:
                    r = self.session.post(
                        url.rstrip("/") + "/audio/transcriptions",
                        files={"file": (os.path.basename(str(wav_path)), fh, "audio/wav")},
                        data={"model": model, "response_format": "verbose_json",
                              "timestamp_granularities[]": "word", "language": "en"},
                        timeout=self.timeout)
                r.raise_for_status()
                return parse_words(r.json()), model
            except (requests.RequestException, ValueError, KeyError) as e:
                errors.append(f"{url}: {e}")
        raise WhisperUnavailable("; ".join(errors))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().replace("'", "").replace("’", "")


def book_tokens(text: str, c_a: int, c_b: int) -> list[tuple[str, int]]:
    toks = [(m.group(0), c_a + m.start()) for m in _TOKEN.finditer(text[c_a:c_b])]
    out, i = [], 0
    while i < len(toks):
        w, off = toks[i]
        if len(w) == 1 and w.isupper() and w not in ("A", "I") and i + 1 < len(toks):
            nw, noff = toks[i + 1]
            if noff == off + 2 and text[off + 1].isspace() and nw[:1].islower():
                out.append((norm(w + nw), off))
                i += 2
                continue
        out.append((norm(w), off))
        i += 1
    return [(w, o) for w, o in out if w]


def transcript_tokens(words: list[Word]) -> list[tuple[str, float]]:
    out = []
    for w in words:
        for m in _TOKEN.finditer(w.text):
            t = norm(m.group(0))
            if t:
                out.append((t, w.start))
    return out


def align_words(btoks, ttoks, c_a, c_b, ts_a, ts_b) -> list[Anchor]:
    sm = difflib.SequenceMatcher(None, [w for w, _ in btoks], [w for w, _ in ttoks], autojunk=False)
    out = []
    for blk in sm.get_matching_blocks():
        if blk.size < MIN_BLOCK:
            continue
        for k in range(blk.size):
            c, t = btoks[blk.a + k][1], ttoks[blk.b + k][1]
            if c_a < c < c_b and ts_a <= t < ts_b:
                out.append(Anchor(c, t))
    return out


def repair_hole(gap: Gap, ref_text: str,
                transcribe_range: Callable[[float, float], list[Word]]) -> list[Anchor]:
    words: list[Word] = []
    t = gap.ts_a
    while t < gap.ts_b - 0.01:
        e = min(gap.ts_b, t + CHUNK_SECONDS)
        words.extend(transcribe_range(t, e))
        t = e
    return align_words(book_tokens(ref_text, gap.c_a, gap.c_b), transcript_tokens(words),
                       gap.c_a, gap.c_b, gap.ts_a, gap.ts_b)
