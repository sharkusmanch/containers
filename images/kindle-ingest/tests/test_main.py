import dataclasses
import os
import zipfile
import pytest

from app import main as M
from app.device import DeviceBook
from app.ledger import Ledger, OK, RETRYABLE, FAILED, NEEDS_DECISION, UPLOADING


class FakeDevice:
    def __init__(self, books=None, reachable=True):
        self._books = books or {}
        self._reachable = reachable
        self.deleted = []
        self.keys_emitted = 0

    def reachable(self): return self._reachable
    def list_books(self): return dict(self._books)
    def emit_keys(self): self.keys_emitted += 1
    def fetch_keyfile(self, dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, "w").write("v$secret_key:00\n"); return dest
    def fetch_book(self, book, dest):
        os.makedirs(dest, exist_ok=True)
        open(os.path.join(dest, "a.kfx"), "wb").write(b"x"); return dest
    def build_archive(self, src, dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with zipfile.ZipFile(dest, "w") as z: z.writestr("a.kfx", b"x")
        return dest
    def delete_book(self, book):
        t = [book.kfx_path, book.assets_path]; self.deleted.extend(t); return t


class FakeApi:
    def __init__(self, existing=None, upload_result=None):
        self.existing = existing or {}
        self.upload_calls = 0
        self.upload_result = upload_result or {"bookId": 99}
        self.verify_ok = True
        self._token = None
    def find_by_asin(self, asin): return self.existing.get(asin)
    def upload(self, path, **kw):
        self.upload_calls += 1
        return self.upload_result
    def verify(self, book_id, path): return self.verify_ok


class FakeNotifier:
    def __init__(self):
        self.success, self.failures, self.decisions = [], [], []
    def batch_success(self, titles):
        if titles: self.success.append(list(titles))
        return bool(titles)
    def failure(self, a, t, r): self.failures.append(a); return True
    def needs_decision(self, a, t, r): self.decisions.append(a); return True


def _ctx(cfg, device, api=None, ledger=None):
    return M.Ctx(cfg, device, api or FakeApi(), ledger or Ledger(cfg.ledger_path),
                 FakeNotifier())


def _book(asin="B0TEST1234", assets=2, size=100):
    return DeviceBook(asin, f"Title_{asin}", size, assets)


# --- device unreachable is the normal state ---------------------------------

def test_unreachable_device_is_not_an_error(cfg):
    ctx = _ctx(cfg, FakeDevice(reachable=False))
    r = M.run_cycle(ctx)
    assert r.failed == 0 and r.errors == []


def test_heartbeat_updates_even_when_unreachable(cfg):
    from app import metrics
    ctx = _ctx(cfg, FakeDevice(reachable=False))
    metrics.HEARTBEAT.set(0)
    M.run_cycle(ctx)
    assert metrics.HEARTBEAT._value.get() > 0


def test_unreachable_does_not_emit_keys(cfg):
    d = FakeDevice(reachable=False)
    M.run_cycle(_ctx(cfg, d))
    assert d.keys_emitted == 0


# --- incomplete downloads ----------------------------------------------------

def test_zero_asset_book_is_retryable_not_failed(cfg):
    b = _book("B0INCOMP12", assets=0)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}))
    r = M.run_cycle(ctx)
    assert ctx.ledger.get(b.asin)["outcome"] == RETRYABLE
    assert r.skipped == 1 and r.failed == 0


def test_incomplete_book_is_never_uploaded(cfg):
    b = _book("B0INCOMP12", assets=0)
    api = FakeApi()
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), api))
    assert api.upload_calls == 0


# --- duplicates --------------------------------------------------------------

def test_existing_book_becomes_needs_decision_and_is_not_uploaded(cfg, monkeypatch):
    b = _book("B0DUP12345")
    api = FakeApi(existing={b.asin: {"id": 42}})
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    def _fake_decrypt(enc, key, out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "wb").write(b"decrypted")
        return 1
    monkeypatch.setattr(M, "decrypt_archive", _fake_decrypt)
    monkeypatch.setattr(M, "to_epub", lambda s, o, t: (open(o, "w").write("x"), "")[1])
    monkeypatch.setattr(M, "classify", lambda p: type("C", (), {"is_comic": False, "confidence": "clear", "reasons": []})())
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    M.run_cycle(ctx)
    assert ctx.ledger.get(b.asin)["outcome"] == NEEDS_DECISION
    assert api.upload_calls == 0


# --- startup reconciliation --------------------------------------------------

def test_leftover_intent_that_landed_is_reconciled_without_reuploading(cfg):
    led = Ledger(cfg.ledger_path)
    led.record("B0CRASH123", UPLOADING, title="T")
    api = FakeApi(existing={"B0CRASH123": {"id": 7}})
    ctx = _ctx(cfg, FakeDevice(), api, led)
    M.reconcile_startup(ctx)
    assert ctx.ledger.get("B0CRASH123")["outcome"] == OK
    assert ctx.ledger.get("B0CRASH123")["bookorbit_id"] == 7
    assert api.upload_calls == 0


def test_leftover_intent_that_did_not_land_becomes_retryable(cfg):
    led = Ledger(cfg.ledger_path)
    led.record("B0CRASH123", UPLOADING, title="T")
    ctx = _ctx(cfg, FakeDevice(), FakeApi(), led)
    M.reconcile_startup(ctx)
    assert ctx.ledger.get("B0CRASH123")["outcome"] == RETRYABLE


# --- retry cap ---------------------------------------------------------------

def test_retries_are_capped(cfg):
    b = _book("B0RETRY123")
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, RETRYABLE, attempts=M.MAX_ATTEMPTS)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), FakeApi(), led)
    M.run_cycle(ctx)
    assert ctx.ledger.get(b.asin)["outcome"] == FAILED


# --- cleanup safety ----------------------------------------------------------

def test_cleanup_is_disabled_by_default(cfg):
    b = _book("B0CLEAN123")
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, OK, bookorbit_id=1, artifact="/nope", kind="epub")
    d = FakeDevice({b.asin: b})
    M.run_cycle(_ctx(cfg, d, FakeApi(), led))
    assert d.deleted == []


def test_cleanup_never_deletes_the_sdr(cfg, monkeypatch, tmp_path):
    art = tmp_path / "a.epub"; art.write_bytes(b"x" * 10)
    arc = os.path.join(cfg.data_dir, "archive", "B0CLEAN123.kfx-zip")
    os.makedirs(os.path.dirname(arc), exist_ok=True); open(arc, "wb").write(b"y")
    from app.verify import sha256_file
    b = _book("B0CLEAN123")
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, OK, bookorbit_id=1, artifact=str(art), kind="epub",
               archive_sha256=sha256_file(arc))
    cfg = dataclasses.replace(cfg, cleanup_enabled=True)
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    d = FakeDevice({b.asin: b})
    M.run_cycle(_ctx(cfg, d, FakeApi(), led))
    assert d.deleted, "expected cleanup to run"
    assert not any(p.endswith(".sdr") for p in d.deleted)
    assert any(p.endswith(".sdr/assets") for p in d.deleted)


def test_cleanup_refuses_when_archive_hash_does_not_match(cfg, monkeypatch, tmp_path):
    art = tmp_path / "a.epub"; art.write_bytes(b"x" * 10)
    b = _book("B0TAMPER12")
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, OK, bookorbit_id=1, artifact=str(art), kind="epub",
               archive_sha256="deadbeef")          # will not match
    cfg = dataclasses.replace(cfg, cleanup_enabled=True)
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    d = FakeDevice({b.asin: b})
    M.run_cycle(_ctx(cfg, d, FakeApi(), led))
    assert d.deleted == []          # conjunction condition 4 failed


def test_cleanup_refuses_when_server_verify_fails(cfg, monkeypatch, tmp_path):
    art = tmp_path / "a.epub"; art.write_bytes(b"x" * 10)
    arc = os.path.join(cfg.data_dir, "archive", "B0SRVBAD12.kfx-zip")
    os.makedirs(os.path.dirname(arc), exist_ok=True); open(arc, "wb").write(b"y")
    from app.verify import sha256_file
    b = _book("B0SRVBAD12")
    led = Ledger(cfg.ledger_path)
    led.record(b.asin, OK, bookorbit_id=1, artifact=str(art), kind="epub",
               archive_sha256=sha256_file(arc))
    cfg = dataclasses.replace(cfg, cleanup_enabled=True)
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    api = FakeApi(); api.verify_ok = False
    d = FakeDevice({b.asin: b})
    M.run_cycle(_ctx(cfg, d, api, led))
    assert d.deleted == []          # conjunction condition 2 failed


# --- notification dedup ------------------------------------------------------

def test_failures_notify_once_not_every_cycle(cfg):
    led = Ledger(cfg.ledger_path)
    led.record("B0FAIL1234", FAILED, title="T", error="boom")
    ctx = _ctx(cfg, FakeDevice(), FakeApi(), led)
    M._notify_once(ctx); M._notify_once(ctx); M._notify_once(ctx)
    assert ctx.notifier.failures == ["B0FAIL1234"]


# --- startup: wait for the Tailscale sidecar's SOCKS port -------------------
# The sidecar registers with Headscale a few seconds after the pod starts. A
# first cycle that runs before then reports "device unreachable" and then sleeps
# a full poll_interval, so every restart cost up to 10 idle minutes.

def test_await_proxy_returns_true_once_the_port_accepts():
    import socket
    from app.main import await_proxy

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    host, port = srv.getsockname()
    try:
        assert await_proxy(f"{host}:{port}", timeout=5.0) is True
    finally:
        srv.close()


def test_await_proxy_gives_up_and_returns_false(monkeypatch):
    # Nothing is listening: it must give up at the deadline rather than block
    # the loop forever -- an unreachable device is a normal state, not fatal.
    from app.main import await_proxy

    slept = []
    monkeypatch.setattr("app.main.time.sleep", lambda s: slept.append(s))
    assert await_proxy("127.0.0.1:9", timeout=0.0) is False


def test_await_proxy_tolerates_a_malformed_address():
    from app.main import await_proxy
    assert await_proxy("not-a-host-port", timeout=0.0) is False
