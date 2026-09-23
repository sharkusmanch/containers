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


def test_handoff_same_file_keeps_a_matching_sidecar(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"epub-bytes")
    sha = sha256_file(str(intake / "B0ABC12345.epub"))
    (intake / "B0ABC12345.json").write_text(json.dumps({"keep": True, "sha256": sha}))
    H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    assert json.loads((intake / "B0ABC12345.json").read_text()) == {"keep": True,
                                                                    "sha256": sha}


@pytest.mark.parametrize("body", ['{"sha256": "%s"}' % ("0" * 64), '{"asin": "x"}',
                                  "not json"])
def test_handoff_rewrites_a_sidecar_that_does_not_match(tmp_path, body):
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"epub-bytes")
    (intake / "B0ABC12345.json").write_text(body)
    r = H.to_intake(str(intake), "B0ABC12345", _src(tmp_path), "T", [])
    side = json.loads((intake / "B0ABC12345.json").read_text())
    assert side["sha256"] == r.sha256 and side["asin"] == "B0ABC12345"
    assert sorted(os.listdir(intake)) == ["B0ABC12345.epub", "B0ABC12345.json"]


def test_handoff_pending_sha_adopts_our_own_earlier_output(tmp_path):
    # calibre output is not byte-reproducible: the file a crashed attempt
    # placed differs from this attempt's conversion, but it is ours.
    intake = tmp_path / "intake"
    intake.mkdir()
    (intake / "B0ABC12345.epub").write_bytes(b"first conversion")
    first = sha256_file(str(intake / "B0ABC12345.epub"))
    r = H.to_intake(str(intake), "B0ABC12345", _src(tmp_path, b"second"), "T", [],
                    pending_sha=first)
    assert r.sha256 == first
    assert (intake / "B0ABC12345.epub").read_bytes() == b"first conversion"
    assert json.loads((intake / "B0ABC12345.json").read_text())["sha256"] == first


def test_handoff_pending_sha_is_recorded_before_the_replace(tmp_path, monkeypatch):
    intake = tmp_path / "intake"
    intake.mkdir()
    order = []
    real = os.replace
    monkeypatch.setattr(H.os, "replace",
                        lambda a, b: (order.append(("replace", os.path.basename(b))),
                                      real(a, b))[1])
    src = _src(tmp_path)
    H.to_intake(str(intake), "B0ABC12345", src, "T", [],
                on_pending=lambda sha: order.append(("pending", sha)))
    assert order[0] == ("pending", sha256_file(src))
    assert order[1] == ("replace", "B0ABC12345.epub")


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
    monkeypatch.setattr(m.handoff, "sweep_stale_temps", lambda d: 0)
    cfg = types.SimpleNamespace(metrics_port=0, poll_interval=1, pull_timeout=10,
                                convert_timeout=10, handoff_mode="intake",
                                intake_dir="/intake")
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



# --- write-ahead: crash between the replace and the ok record ---------------

class Crash(BaseException):
    """Stands in for SIGKILL/OOM: no handler in _process catches it."""


def _varying_conversion(monkeypatch):
    n = {"i": 0}
    def conv(a, o, t):
        n["i"] += 1
        open(o, "wb").write(f"conversion {n['i']}".encode())
        return ""
    monkeypatch.setattr(M, "to_epub", conv)


def test_crash_after_replace_resumes_with_the_first_file(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    _varying_conversion(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0CRASHI01", "Some Book_B0CRASHI01", 100, 2)
    led = Ledger(cfg.ledger_path)
    real = H._write_sidecar
    monkeypatch.setattr(H, "_write_sidecar", lambda *a, **k: (_ for _ in ()).throw(Crash()))
    with pytest.raises(Crash):
        M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led))
    dst = os.path.join(cfg.intake_dir, "B0CRASHI01.epub")
    first = sha256_file(dst)
    assert led.get(b.asin)["outcome"] == RETRYABLE
    assert led.get(b.asin)["intake_pending_sha"] == first

    monkeypatch.setattr(H, "_write_sidecar", real)
    led2 = Ledger(cfg.ledger_path)                       # a fresh process
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led2))
    rec = led2.get(b.asin)
    assert rec["outcome"] == OK, rec
    assert rec["artifact_sha256"] == first
    assert sha256_file(dst) == first
    assert json.load(open(os.path.join(cfg.intake_dir, "B0CRASHI01.json")))["sha256"] == first
    assert not rec.get("intake_pending_sha")


def test_sidecar_failure_is_repaired_on_the_next_attempt(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    _varying_conversion(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0SIDECA01", "Some Book_B0SIDECA01", 100, 2)
    led = Ledger(cfg.ledger_path)
    real = H._write_sidecar
    def fail(*a, **k):
        raise H.HandoffFailed("writing sidecar: EIO")
    monkeypatch.setattr(H, "_write_sidecar", fail)
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led))
    assert led.get(b.asin)["outcome"] == RETRYABLE
    first = sha256_file(os.path.join(cfg.intake_dir, "B0SIDECA01.epub"))
    assert not os.path.exists(os.path.join(cfg.intake_dir, "B0SIDECA01.json"))

    monkeypatch.setattr(H, "_write_sidecar", real)
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led))
    rec = led.get(b.asin)
    assert rec["outcome"] == OK and rec["artifact_sha256"] == first
    assert json.load(open(os.path.join(cfg.intake_dir, "B0SIDECA01.json")))["sha256"] == first


def test_a_foreign_file_is_still_a_conflict_with_a_pending_sha(cfg, monkeypatch, tmp_path):
    _stub_pipeline(monkeypatch)
    cfg = _intake_cfg(cfg, tmp_path)
    b = DeviceBook("B0FOREIG01", "Some Book_B0FOREIG01", 100, 2)
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, RETRYABLE, attempts=1, intake_pending_sha="f" * 64)
    open(os.path.join(cfg.intake_dir, "B0FOREIG01.epub"), "wb").write(b"not ours")
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), _SpyApi(), led))
    assert led.get(b.asin)["outcome"] == NEEDS_DECISION


def test_pending_sha_survives_retryable_records(cfg):
    led = Ledger(cfg.ledger_path)
    led.record("B0PEND0001", RETRYABLE, intake_pending_sha="a" * 64)
    led.record("B0PEND0001", RETRYABLE, attempts=2, detail="started", error="x")
    assert led.get("B0PEND0001")["intake_pending_sha"] == "a" * 64


# --- cleanup: an absent file counts as "moved" only if the mount is there ---

def test_cleanup_skips_when_the_intake_mount_is_missing(cfg, tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    fn, ctx, d, b = _cleanup_ctx(cfg, tmp_path, monkeypatch, "B0NOMOUNT1", place=False)
    ctx.ledger.record(b.asin, OK, intake_path="/nonexistent-mount/B0NOMOUNT1.epub")
    b2 = DeviceBook("B0NOMOUNT2", "T_B0NOMOUNT2", 100, 2)
    ctx.ledger.record(b2.asin, OK, **{k: v for k, v in ctx.ledger.get(b.asin).items()
                                      if k not in ("asin", "outcome", "ts")})
    res = M.CycleResult()
    with caplog.at_level("WARNING"):
        fn(ctx, {b.asin: b, b2.asin: b2}, res)
    assert res.deleted == 0 and d.deleted == []
    assert sum("intake" in r.getMessage() and "mount" in r.getMessage()
               for r in caplog.records) == 1


def test_intake_still_consistent_requires_the_directory(tmp_path):
    assert H.intake_still_consistent(str(tmp_path / "B0X.epub"), "a" * 64) is True
    assert H.intake_still_consistent(str(tmp_path / "gone" / "B0X.epub"), "a" * 64) is False


# --- startup: stale hidden temps are swept -----------------------------------

def test_stale_temp_files_are_swept(tmp_path):
    intake = tmp_path / "intake"
    intake.mkdir()
    old = __import__("time").time() - 7200
    names = {".B0STALE001.epub.tmp": old, ".B0STALE001.json.tmp": old,
             ".B0FRESH001.epub.tmp": None,           # < 1 h: may be in flight
             "B0KEEP0001.epub": old, ".other.tmp": old, ".B0X.epub.tmp": old}
    for n, t in names.items():
        (intake / n).write_bytes(b"x")
        if t:
            os.utime(intake / n, (t, t))
    assert H.sweep_stale_temps(str(intake)) == 2
    assert sorted(os.listdir(intake)) == sorted(
        [".B0FRESH001.epub.tmp", "B0KEEP0001.epub", ".other.tmp", ".B0X.epub.tmp"])


def test_sweep_tolerates_a_missing_intake(tmp_path):
    assert H.sweep_stale_temps(str(tmp_path / "missing")) == 0


def test_main_sweeps_temps_at_startup_in_intake_mode(monkeypatch):
    import app.main as m
    calls = []
    monkeypatch.setattr(m, "await_device", lambda dev, **kw: True)
    monkeypatch.setattr(m, "migrate_upload_limit_decisions", lambda ctx: 0)
    monkeypatch.setattr(m.handoff, "sweep_stale_temps", lambda d: calls.append(d) or 0)
    monkeypatch.setattr(m.metrics, "rebuild_from_ledger", lambda *a: None)
    monkeypatch.setattr(m.metrics, "serve", lambda *a, **k: None)
    ctx = types.SimpleNamespace(device=object(), ledger=object(), stop={"now": True})
    cfg = types.SimpleNamespace(metrics_port=0, poll_interval=1, pull_timeout=10,
                                convert_timeout=10, handoff_mode="intake",
                                intake_dir="/intake")
    monkeypatch.setattr(m.Ctx, "build", staticmethod(lambda c: ctx))
    monkeypatch.setattr(m.Config, "from_env", staticmethod(lambda: cfg))
    assert m.main() == 0
    assert calls == ["/intake"]
