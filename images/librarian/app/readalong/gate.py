"""Publish gate. Refuse rather than degrade: a readaloud only reaches the
library when Storyteller grades it S or A — or B/C with no unaligned audio
stretch longer than MAX_HOLE_SECONDS — AND our own SMIL sum agrees with the m4b
within BookOrbit's bridge tolerance.

Loosened 2026-09-22 (user decision) after the bulk run refused 15 of 80 titles:
every B/C refusal was unnarrated front/back matter (dedications, annotations,
character lists) or chapter announcements spread across tracks, never a long
misaligned stretch — and the longest hole is what actually puts a reader in the
wrong place. Empty SMIL files (a front/back-matter page with nothing to play)
no longer refuse either; they are still recorded in the state file. D/F stay refused.

summarize_report() is deliberately tolerant about WHERE the v3 report view puts
its numbers (top level, `summary`, or `totals`) but never invents them: a
missing grade fails the gate and the raw keys are recorded for the analysis.
"""
from dataclasses import dataclass, field

PASS_GRADES = ("S", "A")
HOLE_GRADES = ("B", "C")      # pass only when no audio hole exceeds MAX_HOLE_SECONDS
MAX_HOLE_SECONDS = 60.0


def TOLERANCE(m4b_seconds):
    return min(0.05 * m4b_seconds, 300.0)


@dataclass
class ReportSummary:
    grade: str | None = None
    sentence_coverage: float | None = None
    audio_coverage: float | None = None
    failed_chapters: int | None = None
    unaligned_audio_seconds: float | None = None
    max_hole_seconds: float | None = None
    raw_keys: list = field(default_factory=list)


def _find(view, *names):
    for scope in (view, view.get("summary") or {}, view.get("totals") or {}, view.get("latest") or {}):
        if isinstance(scope, dict):
            for n in names:
                if scope.get(n) is not None:
                    return scope[n]
    return None


def summarize_report(view):
    view = view or {}
    g = _find(view, "grade")
    return ReportSummary(
        grade=str(g).upper() if g is not None else None,
        sentence_coverage=_f(_find(view, "sentenceCoverage", "sentence_coverage")),
        audio_coverage=_f(_find(view, "audioCoverage", "audio_coverage")),
        failed_chapters=_i(_find(view, "failedChapters", "failed_chapters")),
        unaligned_audio_seconds=_f(_find(view, "unalignedAudio", "unalignedAudioSeconds", "looseSeconds")),
        max_hole_seconds=_max_hole(view),
        raw_keys=sorted(view.keys()),
    )


def _max_hole(view):
    """Longest unaligned audio stretch BETWEEN the first and last aligned
    sentence, from the v3 report's `holes` ({"audio": {"track","start","end"}}),
    placed on one timeline with `tracks[].offset`. Audio before the first or
    after the last aligned sentence (opening credits, audio-only bonus chapters,
    afterwords) cannot put a reader in the wrong place, so it is ignored; so is
    a hole attached to a chapter Storyteller itself classifies "audio-only" (an
    empty ebook page whose content exists only as audio — the Cradle books'
    25–30 min "Bonus Chapter", which sits before an aligned "Bloopers" section).
    None when the report has no `holes` key: unknown, never invented."""
    holes = view.get("holes")
    if holes is None:
        return None
    offsets = {t.get("index"): float(t.get("offset") or 0) for t in (view.get("tracks") or []) if isinstance(t, dict)}

    def span(a):
        if not isinstance(a, dict) or a.get("start") is None or a.get("end") is None:
            return None
        base = offsets.get(a.get("track"), 0.0)
        return base + float(a["start"]), base + float(a["end"])

    aligned = [span(sp.get("audio")) for sp in (view.get("spans") or [])
               if isinstance(sp, dict) and sp.get("state") == "aligned"]
    aligned = [a for a in aligned if a]
    audio_only = {i.get("index") for i in (view.get("items") or [])
                  if isinstance(i, dict) and i.get("status") == "audio-only"}
    first = min((a[0] for a in aligned), default=None)
    last = max((a[1] for a in aligned), default=None)
    lengths = []
    for h in holes:
        hs = span(h.get("audio")) if isinstance(h, dict) else None
        if not hs or h.get("spine") in audio_only:
            continue
        if first is not None and (hs[1] <= first or hs[0] >= last):
            continue
        lengths.append(hs[1] - hs[0])
    return max(lengths, default=0.0)


def _f(v):
    return None if v is None else float(v)


def _i(v):
    return None if v is None else int(v)


@dataclass
class Verdict:
    passed: bool
    reasons: list


def decide(summary, overlay, m4b_seconds):
    reasons = []
    if summary.grade in HOLE_GRADES:
        if summary.max_hole_seconds is None:
            reasons.append(f"grade {summary.grade!r} needs the report's audio holes, which are missing")
        elif summary.max_hole_seconds > MAX_HOLE_SECONDS:
            reasons.append(f"grade {summary.grade!r} with an unaligned audio hole of "
                           f"{summary.max_hole_seconds:.0f}s (> {MAX_HOLE_SECONDS:.0f}s)")
    elif summary.grade not in PASS_GRADES:
        reasons.append(f"grade {summary.grade!r} not in {PASS_GRADES + HOLE_GRADES}")
    diff = abs(overlay.total_seconds - m4b_seconds)
    tol = TOLERANCE(m4b_seconds)
    if diff > tol:
        reasons.append(f"duration mismatch: overlay {overlay.total_seconds:.1f}s vs m4b {m4b_seconds:.1f}s (diff {diff:.1f}s > {tol:.1f}s)")
    if overlay.spine_with_overlay == 0:
        reasons.append("no spine item has a media-overlay")
    if overlay.zero_length_clips > 0:
        reasons.append(f"{overlay.zero_length_clips} zero-length overlay clips (BookOrbit findItemBySeconds bug)")
    return Verdict(not reasons, reasons)
