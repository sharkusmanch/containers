import os, time
from app.intake import scan, Stability, primary_file, arrival_key, classify, sha256_file
from app.store import Store
from app import states

def mk(p, data=b"x"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f: f.write(data)

def test_scan_kinds(tmp_path):
    r = str(tmp_path)
    mk(f"{r}/libation/Foo [B0ABCDEFGH]/Foo [B0ABCDEFGH].m4b")
    mk(f"{r}/libation/Court [1980085722]/Court [1980085722].m4b")
    mk(f"{r}/libation/not-an-arrival/x.m4b")
    mk(f"{r}/kindle/B0KINDLE01.epub"); mk(f"{r}/kindle/B0KINDLE01.json", b'{"sha256":"x"}')
    mk(f"{r}/kindle/B0NOSIDE01.epub")
    mk(f"{r}/manual/book.epub"); mk(f"{r}/manual/.hidden")
    got = {(c.source, c.source_id) for c in scan(r)}
    assert got == {("libation", "B0ABCDEFGH"), ("libation", "1980085722"),
                   ("kindle", "B0KINDLE01"), ("manual", "book.epub")}

def test_stability_needs_quiet_period_and_no_partials(tmp_path):
    r = str(tmp_path)
    mk(f"{r}/libation/Foo [B0ABCDEFGH]/Foo.m4b")
    mk(f"{r}/libation/Foo [B0ABCDEFGH]/Foo.aax.tmp")
    st = Stability(quiet_period=600)
    c = scan(r)[0]
    assert st.observe(c, 0) is False
    assert st.observe(c, 700) is False          # partial present
    os.remove(f"{r}/libation/Foo [B0ABCDEFGH]/Foo.aax.tmp")
    c = scan(r)[0]
    assert st.observe(c, 800) is False          # signature changed -> clock reset
    assert st.observe(c, 1401) is True

def test_primary_is_largest_m4b(tmp_path):
    r = str(tmp_path)
    mk(f"{r}/libation/O [B0718Z5K4C]/O [B0718Z5K4C].m4b", b"a" * 10)
    mk(f"{r}/libation/O [B0718Z5K4C]/O [B0718Z5K4C] (1).m4b", b"a" * 99)
    assert primary_file(scan(r)[0]).endswith("(1).m4b")

def test_classify(tmp_path):
    a = Store(str(tmp_path / "arr.jsonl"), "key", frozenset({states.READY, states.FILED}))
    c = type("C", (), {"source": "libation", "source_id": "B0X"})()
    k = arrival_key(c, "abcdef0123456789")
    assert classify(k, c, "abcdef0123456789", a, {}) == ("new", {"previously_filed": None})
    assert classify(k, c, "abcdef0123456789", a, {"abcdef0123456789": 7}) == ("duplicate", {"book_id": 7})
    a.record("libation:B0X:000000000000", states.FILED, book_id=9, sha256="0" * 64)
    assert classify(k, c, "abcdef0123456789", a, {})[1] == {"previously_filed": 9}
    a.record(k, states.READY)
    assert classify(k, c, "abcdef0123456789", a, {}) == ("skip", {})

def test_scan_missing_root_and_missing_subdirs_never_raise(tmp_path):
    missing_root = str(tmp_path / "does-not-exist")
    assert scan(missing_root) == []

    r = str(tmp_path / "partial-root")
    mk(f"{r}/libation/Foo [B0ABCDEFGH]/Foo [B0ABCDEFGH].m4b")
    # kindle/ and manual/ are never created
    got = {(c.source, c.source_id) for c in scan(r)}
    assert got == {("libation", "B0ABCDEFGH")}

def test_scan_does_not_follow_symlink_out_of_intake_root(tmp_path):
    r = str(tmp_path / "root")
    outside = tmp_path / "outside"
    mk(str(outside / "secret.m4b"))
    os.makedirs(f"{r}/manual", exist_ok=True)
    os.symlink(str(outside), f"{r}/manual/escape")
    os.makedirs(f"{r}/libation", exist_ok=True)
    os.symlink(str(outside), f"{r}/libation/Foo [B0ABCDEFGH]")
    got = scan(r)
    assert got == []
