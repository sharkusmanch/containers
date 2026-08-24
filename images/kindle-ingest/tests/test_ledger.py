import json
import pytest
from app.ledger import Ledger, LedgerCorrupt, OK, FAILED, RETRYABLE, UPLOADING


def test_last_record_wins(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", outcome=RETRYABLE, attempts=1)
    l.record("B1", outcome=OK, bookorbit_id=42)
    assert l.get("B1")["outcome"] == OK
    assert l.get("B1")["bookorbit_id"] == 42


def test_fields_merge_across_records(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", device_kfx_size=100)
    l.record("B1", outcome=OK)
    assert l.get("B1")["device_kfx_size"] == 100      # not clobbered


def test_survives_torn_final_line(tmp_path):
    p = tmp_path / "b.jsonl"
    l = Ledger(p)
    l.record("B1", outcome=OK)
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
    Ledger(p).record("B1", outcome=OK, bookorbit_id=7)
    assert Ledger(p).get("B1")["bookorbit_id"] == 7


def test_by_outcome_and_asins_and_counts(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", outcome=OK)
    l.record("B2", outcome=FAILED)
    l.record("B3", outcome=OK)
    assert [r["asin"] for r in l.by_outcome(FAILED)] == ["B2"]
    assert l.asins() == {"B1", "B2", "B3"}
    assert l.counts() == {OK: 2, FAILED: 1}


def test_uploading_intent_is_visible_for_reconciliation(tmp_path):
    l = Ledger(tmp_path / "b.jsonl")
    l.record("B1", outcome=UPLOADING)
    assert [r["asin"] for r in l.by_outcome(UPLOADING)] == ["B1"]


def test_missing_file_is_empty_not_an_error(tmp_path):
    assert Ledger(tmp_path / "nope.jsonl").asins() == set()
