"""Map fragments to audio time: interpolation, gapless tiling, audio cut plan.
All output times are integer milliseconds."""
from __future__ import annotations

import bisect
from dataclasses import dataclass
from typing import Callable

MIN_PAR_MS = 50
MAX_FILE_MS = 30 * 60 * 1000


class TimingError(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


@dataclass
class Par:
    frag_id: str
    doc_index: int
    begin: int
    end: int
    c0: int
    c1: int


@dataclass
class AudioFile:
    name: str
    start: int
    end: int


def interpolator(anchors, rate: float, duration: float) -> Callable[[float], float]:
    chars = [a.char for a in anchors]
    tss = [a.ts for a in anchors]

    def t(c: float) -> float:
        if c <= chars[0]:
            return max(0.0, tss[0] - (chars[0] - c) / rate)
        if c >= chars[-1]:
            return min(duration, tss[-1] + (c - chars[-1]) / rate)
        i = bisect.bisect_right(chars, c)
        c0, c1, t0, t1 = chars[i - 1], chars[i], tss[i - 1], tss[i]
        return t0 + (t1 - t0) * (c - c0) / (c1 - c0)

    return t


def narrated(frags, gaps):
    un = sorted((g.c_a, g.c_b) for g in gaps if g.kind == "unnarrated")
    starts = [a for a, _ in un]

    def inside(f) -> bool:
        i = bisect.bisect_right(starts, f.c0) - 1
        return i >= 0 and un[i][0] <= f.c0 and f.c1 <= un[i][1]

    return [f for f in frags if not inside(f)]


def tile(frags, t, duration_s: float) -> list[Par]:
    if not frags:
        raise TimingError("no_narrated_text")
    dur = round(duration_s * 1000)
    begins = [round(t(f.c0) * 1000) for f in frags]
    begins[0] = 0
    for i in range(1, len(begins)):
        begins[i] = min(max(begins[i], begins[i - 1]), dur)
    raw = [Par(f.id, f.doc_index, begins[i], begins[i + 1] if i + 1 < len(frags) else dur, f.c0, f.c1)
           for i, f in enumerate(frags)]
    out: list[Par] = []
    carry = None
    for p in raw:
        if p.end - p.begin < MIN_PAR_MS:
            if out:
                out[-1].end = p.end
            elif carry is None:
                carry = p.begin
            continue
        if carry is not None:
            p.begin, carry = carry, None
        out.append(p)
    if not out:
        raise TimingError("no_pars")
    out[-1].end = dur
    if out[0].begin != 0:
        raise TimingError("tiling_invariant", "first par does not start at 0")
    for a, b in zip(out, out[1:]):
        if a.end != b.begin or b.begin <= a.begin:
            raise TimingError("tiling_invariant", f"{a.frag_id}->{b.frag_id}")
    return out


def coverage(narrated_frags, pars) -> float:
    total = sum(f.c1 - f.c0 for f in narrated_frags)
    if total == 0:
        return 1.0
    have = {p.frag_id for p in pars}
    return sum(f.c1 - f.c0 for f in narrated_frags if f.id in have) / total


def cut_plan(pars, chapter_starts_s) -> list[AudioFile]:
    dur = pars[-1].end
    begins = [p.begin for p in pars]
    cuts = set()
    for cs in chapter_starts_s:
        ms = round(cs * 1000)
        if ms <= 0 or ms >= dur:
            continue
        i = bisect.bisect_left(begins, ms)
        cands = [begins[j] for j in (i - 1, i) if 0 <= j < len(begins)]
        best = min(cands, key=lambda b: abs(b - ms))
        if 0 < best < dur:
            cuts.add(best)
    bounds = [0] + sorted(cuts) + [dur]
    changed = True
    while changed:
        changed = False
        for k in range(len(bounds) - 1):
            a, b = bounds[k], bounds[k + 1]
            if b - a > MAX_FILE_MS:
                lo, hi = bisect.bisect_right(begins, a), bisect.bisect_left(begins, b)
                inner = begins[lo:hi]
                if inner:
                    mid = (a + b) // 2
                    bounds.insert(k + 1, min(inner, key=lambda x: abs(x - mid)))
                    changed = True
                    break
    return [AudioFile(f"ra-{k + 1:04d}.mp4", a, b) for k, (a, b) in enumerate(zip(bounds, bounds[1:]))]


def file_index(files, begin_ms: int) -> int:
    return bisect.bisect_right([f.start for f in files], begin_ms) - 1
