import pytest

from app import anchors as A


def raw(pairs):
    return [{"char": c, "ts": t, "t_idx": i} for i, (c, t) in enumerate(pairs)]


def test_clean_drops_synthetic_and_sorts():
    r = [{"char": 0, "ts": 0.0}] + raw([(10, 1.0), (5, 0.5)]) + [{"char": 99, "ts": 999.0}]
    assert A.clean(r) == [A.Anchor(5, 0.5), A.Anchor(10, 1.0)]


def test_clean_uses_longest_increasing_subsequence():
    pairs = [(i * 10, i * 1.0) for i in range(1000)]
    pairs[1] = (10, 500.0)  # one early outlier must not wipe out the rest
    out = A.clean(raw(pairs))
    assert len(out) == 999 and A.Anchor(10, 500.0) not in out


def test_clean_refuses_when_too_many_dropped():
    pairs = [(i * 10, float((i * 7) % 13)) for i in range(100)]
    with pytest.raises(A.AnchorError) as e:
        A.clean(raw(pairs))
    assert e.value.reason == "nonmonotone_map"


def test_book_rate_is_median_over_all_pairs():
    anchors = [A.Anchor(c, c / 15.0) for c in range(0, 300, 6)]
    assert A.book_rate(anchors) == pytest.approx(15.0)


def test_gap_kinds():
    rate = 15.0
    anchors = [A.Anchor(c, c / rate) for c in range(0, 1001, 5)]           # narrated 0..1000
    anchors += [A.Anchor(20000, 1000 / rate + 2.0)]                          # 19k chars in 2s -> unnarrated
    t = anchors[-1].ts
    anchors += [A.Anchor(30000, t + 10000 / 14.0)]                           # 10k chars over 714s -> hole
    t = anchors[-1].ts
    anchors += [A.Anchor(30010, t + 70.0)]                                   # 10 chars over 70s -> audio_only
    g = A.gaps(anchors, total_chars=30010, duration=anchors[-1].ts, rate=rate)
    kinds = [x.kind for x in g if x.dchar > 5 or x.dts > 5]
    assert kinds == ["unnarrated", "hole", "audio_only"]


def test_head_and_tail_gaps():
    anchors = [A.Anchor(5000, 20.0), A.Anchor(5010, 20.7)]
    g = A.gaps(anchors, total_chars=5020, duration=21.5, rate=15.0)
    assert g[0].c_a == 0 and g[0].kind == "unnarrated"      # 5000 chars in 20s = 250 cps
    assert g[-1].c_b == 5020 and g[-1].ts_b == 21.5


def test_merge_keeps_monotone_union():
    base = [A.Anchor(0, 0.0), A.Anchor(100, 10.0)]
    extra = [A.Anchor(50, 5.0), A.Anchor(60, 12.0)]
    assert A.merge(base, extra) == [A.Anchor(0, 0.0), A.Anchor(50, 5.0), A.Anchor(100, 10.0)]
