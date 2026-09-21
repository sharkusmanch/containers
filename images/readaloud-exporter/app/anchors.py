"""Alignment-map anchors: cleaning, narration rate, gap classification."""
from __future__ import annotations

import bisect
import statistics
from dataclasses import dataclass

UNNARRATED_FACTOR = 2.5
AUDIO_ONLY_FACTOR = 0.2
HOLE_SECONDS = 60.0
LONG_CHARS = 2000


class AnchorError(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


@dataclass(frozen=True)
class Anchor:
    char: int
    ts: float


@dataclass
class Gap:
    c_a: int
    c_b: int
    ts_a: float
    ts_b: float
    kind: str

    @property
    def dchar(self) -> int:
        return self.c_b - self.c_a

    @property
    def dts(self) -> float:
        return self.ts_b - self.ts_a


def _lis(anchors: list[Anchor]) -> list[Anchor]:
    """Longest subsequence strictly increasing in ts (input strictly increasing in char)."""
    tails: list[float] = []
    tails_idx: list[int] = []
    prev = [-1] * len(anchors)
    for i, a in enumerate(anchors):
        k = bisect.bisect_left(tails, a.ts)
        if k == len(tails):
            tails.append(a.ts)
            tails_idx.append(i)
        else:
            tails[k] = a.ts
            tails_idx[k] = i
        prev[i] = tails_idx[k - 1] if k > 0 else -1
    out = []
    i = tails_idx[-1] if tails_idx else -1
    while i >= 0:
        out.append(anchors[i])
        i = prev[i]
    return out[::-1]


def _dedupe_sorted(items: list[Anchor]) -> list[Anchor]:
    items = sorted(items, key=lambda a: (a.char, a.ts))
    out: list[Anchor] = []
    for a in items:
        if out and out[-1].char == a.char:
            continue
        out.append(a)
    return out


def clean(raw: list[dict], max_drop: float = 0.005) -> list[Anchor]:
    real = [Anchor(int(a["char"]), float(a["ts"])) for a in raw if "t_idx" in a]
    if not real:
        raise AnchorError("no_anchors")
    kept = _lis(_dedupe_sorted(real))
    dropped = len(real) - len(kept)
    if dropped > max_drop * len(real):
        raise AnchorError("nonmonotone_map", f"{dropped}/{len(real)} anchors dropped")
    return kept


def merge(anchors: list[Anchor], extra: list[Anchor]) -> list[Anchor]:
    return _lis(_dedupe_sorted(list(anchors) + list(extra)))


def book_rate(anchors: list[Anchor]) -> float:
    rates = [(b.char - a.char) / (b.ts - a.ts) for a, b in zip(anchors, anchors[1:]) if b.ts > a.ts]
    if not rates:
        raise AnchorError("no_rate")
    return statistics.median(rates)


def _kind(dchar: int, dts: float, rate: float) -> str:
    if dchar > LONG_CHARS and (dts <= 0 or dchar / dts > UNNARRATED_FACTOR * rate):
        return "unnarrated"
    if dts > HOLE_SECONDS:
        if dchar / dts < AUDIO_ONLY_FACTOR * rate:
            return "audio_only"
        return "hole"
    return "narrated"


def gaps(anchors: list[Anchor], total_chars: int, duration: float, rate: float) -> list[Gap]:
    pts = [(0, 0.0)] + [(a.char, a.ts) for a in anchors] + [(total_chars, duration)]
    out = []
    for (ca, ta), (cb, tb) in zip(pts, pts[1:]):
        dchar, dts = cb - ca, max(0.0, tb - ta)
        if dchar <= 0 and dts <= 0:
            continue
        out.append(Gap(ca, cb, ta, max(ta, tb), _kind(dchar, dts, rate)))
    return out
