"""Intake hand-off mode: the librarian files what kindle-ingest converts.

Once cleanup deletes the device copy, the intake file is the only copy of the
book outside the archive, so every write is durable (hidden temp + fsync +
os.replace + dir fsync) and cleanup still demands the full local conjunction.
"""
import dataclasses
import json
import os
import stat
import types

import pytest

from app import handoff as H
from app import main as M
from app.config import Config, ConfigError
from app.device import DeviceBook
from app.ledger import Ledger, FAILED, NEEDS_DECISION, OK, RETRYABLE, UPLOADING
from app.verify import sha256_file

from .test_main import FakeApi, FakeDevice, FakeNotifier, _MetaApi, _ctx, _stub_pipeline

BASE = {"BOOKORBIT_URL": "https://x/", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"}


# --- config ------------------------------------------------------------------

def test_handoff_mode_defaults_to_upload(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("HANDOFF_MODE", raising=False)
    monkeypatch.delenv("INTAKE_DIR", raising=False)
    c = Config.from_env()
    assert c.handoff_mode == "upload"
    assert c.intake_dir == "/intake"


def test_handoff_mode_intake_and_intake_dir(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HANDOFF_MODE", "intake")
    monkeypatch.setenv("INTAKE_DIR", "/media/library_intake/kindle")
    c = Config.from_env()
    assert c.handoff_mode == "intake"
    assert c.intake_dir == "/media/library_intake/kindle"


@pytest.mark.parametrize("bad", ["Intake ", "uploads", "both", "INTAKE"])
def test_unknown_handoff_mode_is_an_error(monkeypatch, bad):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HANDOFF_MODE", bad)
    with pytest.raises(ConfigError):
        Config.from_env()


# --- handoff unit ------------------------------------------------------------

def _src(tmp_path, data=b"epub-bytes"):
    p = tmp_path / "src.epub"
    p.write_bytes(data)
    return str(p)


def test_handoff_writes_epub_and_sidecar(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    src = _src(tmp_path)
    r = H.to_intake(str(intake), "B0ABC12345", src, "A Title", [])
    dst = intake / "B0ABC12345.epub"
    assert dst.read_bytes() == b"epub-bytes"
    assert r.sha256 == sha256_file(src) == sha256_file(str(dst))
    assert r.path == str(dst)
    side = json.loads((intake / "B0ABC12345.json").read_text())
    assert side == {"asin": "B0ABC12345", "title": "A Title", "authors": [],
                    "source": "kindle", "sha256": r.sha256, "kind": "epub"}
    assert stat.S_IMODE(dst.stat().st_mode) == 0o664
    assert stat.S_IMODE((intake / "B0ABC12345.json").stat().st_mode) == 0o664
    assert sorted(os.listdir(intake)) == ["B0ABC12345.epub", "B0ABC12345.json"]


def test_handoff_mode_bits_ignore_umask(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    old = os.umask(0o077)
    try:
        H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    finally:
        os.umask(old)
    assert stat.S_IMODE((intake / "B0ABC12345.epub").stat().st_mode) == 0o664


def test_handoff_temp_files_are_hidden(tmp_path, monkeypatch):
    intake = tmp_path / "intake"
    intake.mkdir()
    seen = []
    real = os.replace
    def spy(a, b):
        seen.append(os.path.basename(a))
        return real(a, b)
    monkeypatch.setattr(H.os, "replace", spy)
    H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert seen == [".B0ABC12345.epub.tmp", ".B0ABC12345.json.tmp"]


def test_handoff_same_file_already_present_is_done(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"epub-bytes")
    r = H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert r.sha256 == sha256_file(str(intake / "B0ABC12345.epub"))
    side = json.loads((intake / "B0ABC12345.json").read_text())
    assert side["sha256"] == r.sha256            # missing sidecar was written


def test_handoff_same_file_keeps_existing_sidecar(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"epub-bytes")
    (intake / "B0ABC12345.json").write_text('{"keep": true}')
    H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert json.loads((intake / "B0ABC12345.json").read_text()) == {"keep": True}


def test_handoff_different_file_present_is_a_conflict(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"something else")
    with pytest.raises(H.IntakeConflict):
        H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert (intake / "B0ABC12345.epub").read_bytes() == b"something else"
    assert not (intake / "B0ABC12345.json").exists()


def test_handoff_rehash_mismatch_fails(tmp_path, monkeypatch):
    intake = tmp_path / "intake"
    intake.mkdir()
    src = _src(tmp_path)
    real = H.sha256_file
    def lying(p):
        return "0" * 64 if p.endswith("B0ABC12345.epub") and "intake" in p else real(p)
    monkeypatch.setattr(H, "sha256_file", lying)
    with pytest.raises(H.HandoffFailed):
        H.to_intake(str(intake), "B0ABC12345", src, "T", [])
    assert not (intake / "B0ABC12345.json").exists()   # no sidecar for a bad copy


def test_handoff_io_error_is_handoff_failed_and_leaves_no_temp(tmp_path, monkeypatch):
    intake = tmp_path / "intake"
    intake.mkdir()
    def boom(a, b):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(H.os, "replace", boom)
    with pytest.raises(H.HandoffFailed):
        H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert os.listdir(intake) == []


# --- _process in intake mode -------------------------------------------------

class _SpyApi(_MetaApi):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.find_calls = 0
        self.limit_calls = 0
    def find_by_asin(self, asin):
        self.find_calls += 1
        return super().find_by_asin(asin)
    def upload_limit_bytes(self):
        self.limit_calls += 1
        return super().upload_limit_bytes()


def _intake_cfg(cfg, tmp_path, **kw):
    d = tmp_path / "intake"
    d.mkdir(exist_ok=True)
    return dataclasses.replace(cfg, handoff_mode="intake", intake_dir=str(d), **kw)


def test_intake_mode_hands_the_epub_off_and_skips_bookorbit(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0INTAKE01", "Halo_ Rise of Atriox_B0INTAKE01", 100, 2)
    api = _SpyApi()
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    r = M.run_cycle(ctx)
    assert api.upload_calls == 0 and api.find_calls == 0 and api.limit_calls == 0
    assert api.meta == []
    dst = os.path.join(cfg.intake_dir, "B0INTAKE01.epub")
    assert open(dst, "rb").read() == b"e"
    side = json.load(open(os.path.join(cfg.intake_dir, "B0INTAKE01.json")))
    assert side == {"asin": "B0INTAKE01", "title": "Halo: Rise of Atriox",
                    "authors": [], "source": "kindle",
                    "sha256": sha256_file(dst), "kind": "epub"}
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == OK
    assert rec["handoff"] == "intake"
    assert rec["artifact_sha256"] == sha256_file(dst)
    assert rec["kind"] == "epub"
    assert rec["artifact"] and os.path.exists(rec["artifact"])
    assert "bookorbit_id" not in rec
    assert r.handed_off == 1 and r.uploaded == 0


def test_intake_mode_sends_no_success_push(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0INTAKE02", "Some Book_B0INTAKE02", 100, 2)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), _SpyApi())
    M.run_cycle(ctx)
    assert ctx.notifier.success == []
    assert ctx.ledger.get(b.asin)["announced"] is True


def test_intake_mode_same_file_already_in_intake_is_ok(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    open(os.path.join(cfg.intake_dir, "B0INTAKE03.epub"), "wb").write(b"e")
    b = DeviceBook("B0INTAKE03", "Some Book_B0INTAKE03", 100, 2)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), _SpyApi())
    M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == OK and rec["handoff"] == "intake"
    assert os.path.exists(os.path.join(cfg.intake_dir, "B0INTAKE03.json"))


def test_intake_mode_different_file_in_intake_needs_a_decision(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    open(os.path.join(cfg.intake_dir, "B0INTAKE04.epub"), "wb").write(b"other")
    b = DeviceBook("B0INTAKE04", "Some Book_B0INTAKE04", 100, 2)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), _SpyApi())
    r = M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == NEEDS_DECISION
    assert rec["detail"] == "intake already holds a different file for this ASIN"
    assert r.needs_decision == 1
    assert ctx.notifier.decisions == [b.asin]          # decisions still notify
    assert open(os.path.join(cfg.intake_dir, "B0INTAKE04.epub"), "rb").read() == b"other"


def test_intake_mode_write_failure_is_retryable(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    def boom(*a, **k):
        raise H.HandoffFailed("disk full")
    monkeypatch.setattr(M.handoff, "to_intake", boom)
    b = DeviceBook("B0INTAKE05", "Some Book_B0INTAKE05", 100, 2)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), _SpyApi())
    M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == RETRYABLE
    assert "disk full" in rec["error"]


def test_intake_mode_comics_still_upload(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    monkeypatch.setattr(M, "classify", lambda p: type(
        "C", (), {"is_comic": True, "confidence": "confident", "reasons": []})())
    monkeypatch.setattr(M, "epub_to_cbz",
                        lambda e, c: open(c, "wb").write(b"cbz") and 1)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0COMIC001", "A Comic_B0COMIC001", 100, 2)
    api = _SpyApi()
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    M.run_cycle(ctx)
    assert api.upload_calls == 1
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == OK and rec["kind"] == "cbz"
    assert "handoff" not in rec
    assert os.listdir(cfg.intake_dir) == []


def test_upload_mode_writes_nothing_to_intake(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    d = tmp_path / "intake"
    d.mkdir()
    cfg = dataclasses.replace(cfg, intake_dir=str(d))
    assert cfg.handoff_mode == "upload"
    b = DeviceBook("B0UPLOAD01", "Some Book_B0UPLOAD01", 100, 2)
    api = _SpyApi()
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    M.run_cycle(ctx)
    assert api.upload_calls == 1
    assert os.listdir(d) == []
    assert "handoff" not in ctx.ledger.get(b.asin)


def test_reconcile_ignores_intake_records(cfg, tmp_path):
    cfg = _intake_cfg(cfg, tmp_path)
    led = Ledger(cfg.ledger_path)
    led.record("B0INTAKE06", OK, handoff="intake", artifact_sha256="a" * 64)
    class NoFind(FakeApi):
        def find_by_asin(self, asin):
            raise AssertionError("must not look intake records up in BookOrbit")
    ctx = _ctx(cfg, FakeDevice(), NoFind(), led)
    assert M.reconcile_startup(ctx) == 0
    assert led.get("B0INTAKE06")["outcome"] == OK


# --- cleanup gating ----------------------------------------------------------

def _intake_ok(cfg, asin, intake_bytes=b"e", place=True, archive_sha=None):
    art = os.path.join(cfg.data_dir, "epub", f"{asin}.epub")
    os.makedirs(os.path.dirname(art), exist_ok=True)
    open(art, "wb").write(b"e")
    arc = os.path.join(cfg.data_dir, "archive", f"{asin}.kfx-zip")
    os.makedirs(os.path.dirname(arc), exist_ok=True)
    open(arc, "wb").write(b"arc")
    dst = os.path.join(cfg.intake_dir, f"{asin}.epub")
    if place:
        open(dst, "wb").write(intake_bytes)
    led = Ledger(cfg.ledger_path)
    led.record(asin, OK, artifact=art, kind="epub", handoff="intake",
               intake_path=dst, artifact_sha256=sha256_file(art),
               archive_sha256=archive_sha or sha256_file(arc), announced=True)
    return led


class _NoVerifyApi(FakeApi):
    def verify(self, book_id, path):
        raise AssertionError("intake records must not be verified in BookOrbit")


def _cleanup_ctx(cfg, tmp_path, monkeypatch, asin, **kw):
    cfg = _intake_cfg(cfg, tmp_path, cleanup_enabled=True)
    led = _intake_ok(cfg, asin, **kw)
    b = DeviceBook(asin, f"T_{asin}", 100, 2)
    d = FakeDevice({b.asin: b})
    return M._cleanup, _ctx(cfg, d, _NoVerifyApi(), led), d, b


def test_cleanup_deletes_when_intake_file_matches(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI01")
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert res.deleted == 1 and d.deleted
    rec = ctx.ledger.get(b.asin)
    assert rec["cleaned"] is True and rec["handoff"] == "intake"


def test_cleanup_deletes_when_librarian_moved_the_file(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI02", place=False)
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert res.deleted == 1


def test_cleanup_refuses_when_intake_file_differs(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI03",
                                 intake_bytes=b"tampered")
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert res.deleted == 0 and d.deleted == []


def test_cleanup_intake_still_requires_archive_intact(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI04",
                                 archive_sha="deadbeef")
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert d.deleted == []


def test_cleanup_intake_still_requires_a_valid_artifact(cfg, tmp_path, monkeypatch):
    from app.verify import ArtifactInvalid
    def bad(*a, **k):
        raise ArtifactInvalid("truncated")
    monkeypatch.setattr(M, "verify_artifact", bad)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI05")
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert d.deleted == []


def test_cleanup_intake_record_without_recorded_sha_is_kept(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0CLEANI06")
    ctx.ledger.record(b.asin, OK, artifact_sha256=None)
    res = M.CycleResult()
    fn(ctx, {b.asin: b}, res)
    assert d.deleted == []


def test_cleanup_upload_records_still_need_bookorbit_verify(cfg, tmp_path, monkeypatch):
    # Records without `handoff` keep today's rule exactly, even in intake mode.
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    cfg = _intake_cfg(cfg, tmp_path, cleanup_enabled=True)
    art = tmp_path / "a.epub"; art.write_bytes(b"x")
    arc = os.path.join(cfg.data_dir, "archive", "B0CLEANU01.kfx-zip")
    os.makedirs(os.path.dirname(arc), exist_ok=True); open(arc, "wb").write(b"y")
    led = Ledger(cfg.ledger_path)
    led.record("B0CLEANU01", OK, bookorbit_id=1, artifact=str(art), kind="epub",
               archive_sha256=sha256_file(arc))
    api = FakeApi(); api.verify_ok = False
    b = DeviceBook("B0CLEANU01", "T_B0CLEANU01", 100, 2)
    d = FakeDevice({b.asin: b})
    M._cleanup(_ctx(cfg, d, api, led), {b.asin: b}, M.CycleResult())
    assert d.deleted == []


# --- one-time migration of upload-limit decisions ----------------------------

def _limit_rec(led, asin, kind="epub"):
    led.record(asin, NEEDS_DECISION, attempts=3, title="T", kind=kind,
               detail=f"{kind} is 600MB, over BookOrbit's 500MB upload limit; "
                      "not uploaded", notified=True)


def test_migration_requeues_upload_limit_decisions(cfg, tmp_path):
    cfg = _intake_cfg(cfg, tmp_path)
    led = Ledger(cfg.ledger_path)
    _limit_rec(led, "B0LIMIT001")
    led.record("B0OTHER001", NEEDS_DECISION, detail="already in library as #4")
    ctx = _ctx(cfg, FakeDevice(), FakeApi(), led)
    assert M.migrate_upload_limit_decisions(ctx) == 1
    rec = led.get("B0LIMIT001")
    assert rec["outcome"] == RETRYABLE and rec["attempts"] == 0
    assert not rec.get("notified")
    assert led.get("B0OTHER001")["outcome"] == NEEDS_DECISION
    assert M.migrate_upload_limit_decisions(ctx) == 0          # idempotent


def test_migration_leaves_comics_alone(cfg, tmp_path):
    # CBZ stays on the upload path, so re-queueing one only repeats the decision.
    cfg = _intake_cfg(cfg, tmp_path)
    led = Ledger(cfg.ledger_path)
    _limit_rec(led, "B0LIMITC01", kind="cbz")
    assert M.migrate_upload_limit_decisions(_ctx(cfg, FakeDevice(), FakeApi(), led)) == 0
    assert led.get("B0LIMITC01")["outcome"] == NEEDS_DECISION


def test_migration_is_a_noop_in_upload_mode(cfg):
    led = Ledger(cfg.ledger_path)
    _limit_rec(led, "B0LIMIT002")
    assert M.migrate_upload_limit_decisions(_ctx(cfg, FakeDevice(), FakeApi(), led)) == 0
    assert led.get("B0LIMIT002")["outcome"] == NEEDS_DECISION


def test_main_runs_the_migration_at_startup(monkeypatch):
    import app.main as m
    calls = []
    monkeypatch.setattr(m, "await_device", lambda dev, **kw: True)
    monkeypatch.setattr(m, "migrate_upload_limit_decisions",
                        lambda ctx: calls.append(ctx) or 0)
    monkeypatch.setattr(m.metrics, "rebuild_from_ledger", lambda *a: None)
    monkeypatch.setattr(m.metrics, "serve", lambda *a, **k: None)
    ctx = types.SimpleNamespace(device=object(), ledger=object(), stop={"now": True})
    cfg = types.SimpleNamespace(metrics_port=0, poll_interval=1, pull_timeout=10,
                                convert_timeout=10, handoff_mode="intake")
    monkeypatch.setattr(m.Ctx, "build", staticmethod(lambda c: ctx))
    monkeypatch.setattr(m.Config, "from_env", staticmethod(lambda: cfg))
    assert m.main() == 0
    assert calls == [ctx]


def test_intake_markers_do_not_survive_a_reprocess(cfg, monkeypatch, tmp_path):
    # A handed-off book re-downloaded after a (forbidden, but possible) switch
    # back to upload mode must not keep `handoff`, or cleanup would skip the
    # BookOrbit check for a record that is really an upload.
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0REPROC01", "Some Book_B0REPROC01", 200, 2)
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, OK, handoff="intake", intake_path="/intake/x.epub",
               artifact_sha256="a" * 64, device_kfx_size=100, announced=True)
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led))
    rec = led.get(b.asin)
    assert rec["outcome"] == OK and rec["bookorbit_id"] == 99
    for k in ("handoff", "intake_path", "artifact_sha256"):
        assert k not in rec, k
