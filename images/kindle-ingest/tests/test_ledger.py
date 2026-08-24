import json
import pytest
from app.ledger import Ledger, LedgerCorrupt, OK, FAILED, RETRYABLE, UPLOADING


def test_last_record_wins(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", RETRYABLE, attempts=1)
    l.record("B1", OK, bookorbit_id=42)
    assert l.get("B1")["outcome"] == OK
    assert l.get("B1")["bookorbit_id"] == 42


def test_fields_merge_across_records(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", RETRYABLE, device_kfx_size=100)
    l.record("B1", OK)
    assert l.get("B1")["device_kfx_size"] == 100      # not clobbered


def test_survives_torn_final_line(tmp_path):
    p = tmp_path / "b.jsonl"
    l = Ledger(p)
    l.record("B1", OK)
    with open(p, "a") as f:
        f.write('{"asin": "B2", "outc')               # torn write
    l2 = Ledger(p)
    assert l2.get("B1")["outcome"] == OK
    assert l2.get("B2") is None


def test_corrupt_midfile_raises_rather_than_reading_empty(tmp_path):
    p = tmp_path / "b.jsonl"
    with open(p, "w") as f:
        f.write('{"asin": "B1", "outcome": "ok"}\n')
        f.write("GARBAGE NOT JSON\n")
        f.write('{"asin": "B2", "outcome": "ok"}\n')
    with pytest.raises(LedgerCorrupt):
        Ledger(p)


def test_record_without_asin_is_corruption(tmp_path):
    p = tmp_path / "b.jsonl"
    with open(p, "w") as f:
        f.write('{"outcome": "ok"}\n')
        f.write('{"asin": "B2", "outcome": "ok"}\n')
    with pytest.raises(LedgerCorrupt):
        Ledger(p)


def test_persists_across_instances(tmp_path):
    p = tmp_path / "b.jsonl"
    Ledger(p).record("B1", OK, bookorbit_id=7)
    assert Ledger(p).get("B1")["bookorbit_id"] == 7


def test_by_outcome_and_asins_and_counts(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", OK)
    l.record("B2", FAILED)
    l.record("B3", OK)
    assert [r["asin"] for r in l.by_outcome(FAILED)] == ["B2"]
    assert l.asins() == {"B1", "B2", "B3"}
    assert l.counts() == {OK: 2, FAILED: 1}


def test_uploading_intent_is_visible_for_reconciliation(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", UPLOADING)
    assert [r["asin"] for r in l.by_outcome(UPLOADING)] == ["B1"]


def test_missing_file_is_empty_not_an_error(tmp_path):
    assert Ledger(tmp_path / "nope.jsonl").asins() == set()


# --- regressions for bugs found in review -----------------------------------

def test_torn_tail_is_repaired_so_the_next_record_is_not_lost(tmp_path):
    """A torn write must not swallow the following record, and must not brick
    the ledger on the write after that."""
    p = tmp_path / "b.jsonl"
    Ledger(p).record("B1", OK)
    with open(p, "a") as f:
        f.write('{"asin": "B2", "outc')          # crash mid-write
    Ledger(p).record("B3", OK)
    assert Ledger(p).get("B3") is not None       # previously: lost
    Ledger(p).record("B4", OK)
    assert Ledger(p).get("B4") is not None       # previously: LedgerCorrupt forever


def test_non_utf8_is_corruption_not_a_decode_crash(tmp_path):
    p = tmp_path / "b.jsonl"
    with open(p, "wb") as f:
        f.write(b'{"asin":"B1","outcome":"ok"}\n\xff\xfe garbage\n{"asin":"B2","outcome":"ok"}\n')
    with pytest.raises(LedgerCorrupt):
        Ledger(p)


def test_valid_json_that_is_not_an_object_is_corruption(tmp_path):
    p = tmp_path / "b.jsonl"
    with open(p, "w") as f:
        f.write('123\n{"asin":"B2","outcome":"ok"}\n')
    with pytest.raises(LedgerCorrupt):
        Ledger(p)


def test_blank_line_midfile_is_corruption(tmp_path):
    p = tmp_path / "b.jsonl"
    with open(p, "w") as f:
        f.write('{"asin":"B1","outcome":"ok"}\n\n{"asin":"B2","outcome":"ok"}\n')
    with pytest.raises(LedgerCorrupt):
        Ledger(p)


def test_unknown_outcome_is_rejected(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    with pytest.raises(ValueError):
        l.record("B1", "OK")          # wrong case
    with pytest.raises(ValueError):
        l.record("B1", "retry")       # typo


def test_changing_outcome_clears_stale_per_attempt_fields(tmp_path):
    """A failed book must not inherit a bookorbit_id -- that would make it look
    uploaded and licence deleting the device copy."""
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", OK, bookorbit_id=42)
    l.record("B1", FAILED, error="drm")
    rec = l.get("B1")
    assert rec["outcome"] == FAILED
    assert "bookorbit_id" not in rec
    l.record("B1", OK, bookorbit_id=43)
    assert "error" not in l.get("B1")


def test_durable_fields_survive_outcome_change(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", RETRYABLE, device_kfx_size=100)
    l.record("B1", OK, bookorbit_id=1)
    assert l.get("B1")["device_kfx_size"] == 100


def test_first_seen_is_stable_while_ts_advances(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    a = l.record("B1", RETRYABLE)
    b = l.record("B1", OK)
    assert b["first_seen"] == a["first_seen"]
    assert b["ts"] >= a["ts"]


def test_queries_return_copies_not_live_state(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", OK)
    l.get("B1")["outcome"] = "tampered"
    assert l.get("B1")["outcome"] == OK
