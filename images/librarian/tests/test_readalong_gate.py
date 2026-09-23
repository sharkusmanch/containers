from app.readalong.gate import summarize_report, decide, TOLERANCE
from app.readalong.smil import Overlay


def test_tolerance_is_min_of_5pct_and_300s():
    assert TOLERANCE(1000) == 50.0
    assert TOLERANCE(100000) == 300.0


def test_summarize_report_reads_flat_or_nested_shapes():
    s = summarize_report({"grade": "A", "sentenceCoverage": 91.2, "audioCoverage": 97.0,
                          "failedChapters": 1, "unalignedAudio": 12.5})
    assert (s.grade, s.sentence_coverage, s.audio_coverage, s.failed_chapters, s.unaligned_audio_seconds) == ("A", 91.2, 97.0, 1, 12.5)
    s = summarize_report({"summary": {"grade": "S", "sentenceCoverage": 99, "audioCoverage": 99.5}, "totals": {"failedChapters": 0}})
    assert s.grade == "S" and s.failed_chapters == 0
    s = summarize_report({"something": 1})
    assert s.grade is None and "something" in s.raw_keys


def test_decide_passes_on_grade_and_duration():
    s = summarize_report({"grade": "S", "sentenceCoverage": 99, "audioCoverage": 99.5, "failedChapters": 0})
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=9, spine_without_overlay=["toc.xhtml"])
    v = decide(s, o, m4b_seconds=10200)   # 200s off, tolerance 300
    assert v.passed and v.reasons == []


def test_decide_fails_on_grade_duration_empty_smil_or_missing_report():
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=10)
    assert not decide(summarize_report({"grade": "B"}), o, 10000).passed
    v = decide(summarize_report({"grade": "S"}), o, 10400)
    assert not v.passed and any("duration" in r for r in v.reasons)
    v = decide(summarize_report({}), o, 10000)
    assert not v.passed and any("grade" in r for r in v.reasons)


def test_decide_refuses_zero_length_overlay_clips():
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=10, zero_length_clips=4)
    v = decide(summarize_report({"grade": "S"}), o, 10000)
    assert not v.passed
    assert any("zero-length" in r and "4" in r for r in v.reasons)


HOLES_SHORT = [{"audio": {"track": 0, "start": 0, "end": 11.3}}, {"audio": {"track": 21, "start": 563.4, "end": 577.3}}]
HOLES_LONG = HOLES_SHORT + [{"audio": {"track": 5, "start": 100.0, "end": 190.0}}]


def test_summarize_report_measures_longest_unaligned_audio_hole():
    assert summarize_report({"grade": "C", "holes": HOLES_LONG}).max_hole_seconds == 90.0
    assert summarize_report({"grade": "C", "holes": []}).max_hole_seconds == 0.0
    assert summarize_report({"grade": "C"}).max_hole_seconds is None


def test_decide_accepts_b_and_c_only_when_no_audio_hole_exceeds_60s():
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=10)
    for g in ("B", "C"):
        assert decide(summarize_report({"grade": g, "holes": HOLES_SHORT}), o, 10000).passed
        v = decide(summarize_report({"grade": g, "holes": HOLES_LONG}), o, 10000)
        assert not v.passed and any("90" in r and "hole" in r for r in v.reasons)
        v = decide(summarize_report({"grade": g}), o, 10000)          # holes unknown -> never invent
        assert not v.passed


def test_decide_still_refuses_d_and_f_even_without_holes():
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=10)
    for g in ("D", "F"):
        assert not decide(summarize_report({"grade": g, "holes": []}), o, 10000).passed


def test_decide_tolerates_empty_smil_files():
    o = Overlay(total_seconds=10000, spine_total=10, spine_with_overlay=10, empty_smils=["ack.smil"])
    assert decide(summarize_report({"grade": "S"}), o, 10000).passed


def test_max_hole_ignores_audio_before_the_first_or_after_the_last_aligned_sentence():
    view = {"grade": "C",
            "tracks": [{"index": 0, "offset": 0}, {"index": 1, "offset": 100}, {"index": 2, "offset": 1000}],
            "spans": [{"state": "aligned", "audio": {"track": 1, "start": 0, "end": 800}},
                      {"state": "unmatched", "audio": None}],
            "holes": [{"audio": {"track": 0, "start": 0, "end": 100}},      # 100s intro before any text
                      {"audio": {"track": 1, "start": 300, "end": 330}},    # 30s interior gap
                      {"audio": {"track": 2, "start": 0, "end": 1800}}]}    # 30-min bonus audio after the end
    assert summarize_report(view).max_hole_seconds == 30.0
    view["holes"].append({"audio": {"track": 1, "start": 400, "end": 490}})  # 90s interior gap
    assert summarize_report(view).max_hole_seconds == 90.0


def test_max_hole_ignores_gaps_attached_to_audio_only_chapters():
    view = {"grade": "C",
            "tracks": [{"index": 0, "offset": 0}, {"index": 1, "offset": 1000}, {"index": 2, "offset": 3000}],
            "items": [{"index": 5, "status": "aligned"}, {"index": 6, "status": "audio-only"}, {"index": 7, "status": "aligned"}],
            "spans": [{"state": "aligned", "audio": {"track": 0, "start": 0, "end": 1000}},
                      {"state": "aligned", "audio": {"track": 2, "start": 0, "end": 400}}],
            "holes": [{"spine": 6, "audio": {"track": 1, "start": 0, "end": 1800}},     # bonus chapter, audio only
                      {"spine": 5, "audio": {"track": 0, "start": 500, "end": 540}}]}   # real 40s gap
    assert summarize_report(view).max_hole_seconds == 40.0
