import pytest

from app import timing as T
from app.anchors import Anchor, Gap
from app.segment import Fragment


def F(i, c0, c1, doc=0):
    return Fragment(f"ra-{doc}-{i}", doc, 0, 0, c1 - c0, c0, c1)


def test_interpolator_inside_and_extrapolated():
    t = T.interpolator([Anchor(100, 10.0), Anchor(200, 20.0)], rate=10.0, duration=30.0)
    assert t(150) == pytest.approx(15.0)
    assert t(50) == pytest.approx(5.0)
    assert t(0) == pytest.approx(0.0)
    assert t(1000) == pytest.approx(30.0)


def test_narrated_filter_drops_fragments_inside_unnarrated_gaps():
    gaps = [Gap(0, 100, 0, 1, "narrated"), Gap(100, 5000, 1, 2, "unnarrated")]
    frags = [F(0, 10, 20), F(1, 200, 300), F(2, 90, 150)]
    assert [f.id for f in T.narrated(frags, gaps)] == ["ra-0-0", "ra-0-2"]


def test_tile_is_gapless_and_ends_at_duration():
    frags = [F(i, i * 10, i * 10 + 9) for i in range(5)]
    t = T.interpolator([Anchor(0, 1.0), Anchor(50, 6.0)], rate=10.0, duration=9.5)
    pars = T.tile(frags, t, 9.5)
    assert pars[0].begin == 0 and pars[-1].end == 9500
    assert all(a.end == b.begin for a, b in zip(pars, pars[1:]))
    assert sum(p.end - p.begin for p in pars) == 9500


def test_tile_merges_short_pars_including_first():
    frags = [F(0, 0, 1), F(1, 1, 2), F(2, 100, 110), F(3, 101, 102)]
    t = lambda c: {0: 0.0, 1: 0.01, 100: 5.0, 101: 5.02}[c]
    pars = T.tile(frags, t, 10.0)
    # ra-0-0 (10 ms, first) gives its time to ra-0-1; ra-0-2 (20 ms) is absorbed by ra-0-1
    assert [p.frag_id for p in pars] == ["ra-0-1", "ra-0-3"]
    assert (pars[0].begin, pars[0].end) == (0, 5020) and pars[-1].end == 10000


def test_coverage():
    frags = [F(0, 0, 10), F(1, 10, 20)]
    pars = [T.Par("ra-0-0", 0, 0, 5, 0, 10)]
    assert T.coverage(frags, pars) == pytest.approx(0.5)


def test_cut_plan_snaps_to_par_boundaries_and_caps_length():
    pars = [T.Par(f"p{i}", 0, i * 60_000, (i + 1) * 60_000, i, i + 1) for i in range(70)]  # 70 min
    files = T.cut_plan(pars, [0.0, 125.0])  # chapter at 2:05 -> snaps to 2:00
    assert files[0].start == 0 and files[0].end == 120_000
    assert files[-1].end == 70 * 60_000
    assert all(f.end - f.start <= T.MAX_FILE_MS for f in files)
    begins = {p.begin for p in pars}
    assert all(f.start in begins for f in files)
    assert T.file_index(files, 121_000 // 1000 * 1000) == 1
