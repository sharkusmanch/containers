import json
import os
import threading
import pytest
from app.store import Store, StoreCorrupt

STATES = frozenset({"ready", "filed"})


def test_record_and_reload(tmp_path):
    p = tmp_path / "a.jsonl"
    s = Store(str(p), "key", STATES)
    s.record("k1", "ready", title="T")
    s.record("k1", "filed", book_id=5)
    s2 = Store(str(p), "key", STATES)
    r = s2.get("k1")
    assert r["state"] == "filed" and r["title"] == "T" and r["book_id"] == 5
    assert r["first_seen"] <= r["ts"]


def test_unknown_state_rejected(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    with pytest.raises(ValueError):
        s.record("k", "bogus")


def test_torn_tail_repaired_before_append(tmp_path):
    p = tmp_path / "a.jsonl"
    s = Store(str(p), "key", STATES)
    s.record("k1", "ready")
    with open(p, "a") as f:
        f.write('{"key": "k2", "sta')          # torn write
    s2 = Store(str(p), "key", STATES)          # tolerated on load
    assert s2.get("k2") is None
    s2.record("k3", "ready")                   # repair then append
    lines = p.read_text().splitlines()
    assert all(json.loads(l) for l in lines) and len(lines) == 2


def test_midfile_corruption_halts(tmp_path):
    p = tmp_path / "a.jsonl"
    p.write_text('{"key":"a","state":"ready"}\nNOT JSON\n{"key":"b","state":"ready"}\n')
    with pytest.raises(StoreCorrupt):
        Store(str(p), "key", STATES)


def test_error_cleared_on_state_change(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k", "ready", error="boom")
    assert "error" not in s.record("k", "filed")


# --- additional coverage -----------------------------------------------------

def test_get_missing_key_is_none(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    assert s.get("nope") is None


def test_all_and_by_state(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k1", "ready")
    s.record("k2", "filed")
    s.record("k3", "ready")
    assert {r["key"] for r in s.all()} == {"k1", "k2", "k3"}
    assert {r["key"] for r in s.by_state("ready")} == {"k1", "k3"}


def test_counts(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k1", "ready")
    s.record("k2", "filed")
    s.record("k3", "ready")
    assert s.counts() == {"ready": 2, "filed": 1}


def test_missing_file_is_empty_not_an_error(tmp_path):
    assert Store(str(tmp_path / "nope.jsonl"), "key", STATES).all() == []


def test_fields_merge_across_state_changes(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k1", "ready", size=100)
    s.record("k1", "filed")
    assert s.get("k1")["size"] == 100          # not per-attempt, so retained


def test_queries_return_copies_not_live_state(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k1", "ready")
    s.get("k1")["state"] = "tampered"
    assert s.get("k1")["state"] == "ready"


def test_first_seen_stable_while_ts_advances(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    a = s.record("k1", "ready")
    b = s.record("k1", "filed")
    assert b["first_seen"] == a["first_seen"]
    assert b["ts"] >= a["ts"]


def test_configurable_key_field(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "asin", STATES)
    s.record("B1", "ready")
    assert s.get("B1")["asin"] == "B1"


def test_detail_also_cleared_on_state_change(tmp_path):
    s = Store(str(tmp_path / "a.jsonl"), "key", STATES)
    s.record("k", "ready", detail="context")
    assert "detail" not in s.record("k", "filed")


def test_concurrent_writes_are_lock_guarded(tmp_path):
    """20 threads x 10 records each -> reloadable file with 200 lines, no
    interleaved/corrupted writes and no lost records."""
    p = tmp_path / "a.jsonl"
    s = Store(str(p), "key", STATES)

    def worker(n):
        for i in range(10):
            s.record(f"t{n}-{i}", "ready")

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = p.read_text().splitlines()
    assert len(lines) == 200
    for line in lines:
        assert json.loads(line)  # every line is valid, independently-parseable JSON

    reloaded = Store(str(p), "key", STATES)
    assert len(reloaded.all()) == 200
