import dataclasses
import os
import types
import zipfile
import pytest

from app import main as M
from app.bookorbit import Transport
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
    def stale_archives(self, books): return []
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
    def upload_limit_bytes(self): return 500 * 1024 * 1024


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


# --- startup: wait for the device before cycle one -------------------------
# The userspace tailscaled sidecar opens its SOCKS listener immediately but
# registers with Headscale seconds later, so probing the proxy port proves
# nothing. await_device probes end to end instead.

class _FakeClock:
    """Deterministic monotonic + sleep, so the deadline is actually pinned."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


class _FakeDevice:
    """Unreachable for the first `succeed_after` probes, then reachable."""

    def __init__(self, succeed_after):
        self.succeed_after = succeed_after
        self.probes = 0

    def reachable(self):
        self.probes += 1
        return self.probes > self.succeed_after


@pytest.fixture
def clock(monkeypatch):
    c = _FakeClock()
    monkeypatch.setattr("app.main.time.monotonic", c.monotonic)
    monkeypatch.setattr("app.main.time.sleep", c.sleep)
    return c


def test_await_device_returns_immediately_when_already_up(clock):
    from app.main import await_device
    dev = _FakeDevice(succeed_after=0)
    assert await_device(dev, timeout=60.0) is True
    assert dev.probes == 1
    assert clock.sleeps == []          # no reason to wait


def test_await_device_keeps_probing_until_the_sidecar_registers(clock):
    # The bug this exists for: the sidecar comes up a few seconds in. A single
    # probe would return False here and cost a full poll_interval.
    from app.main import await_device
    dev = _FakeDevice(succeed_after=3)
    assert await_device(dev, timeout=60.0) is True
    assert dev.probes == 4
    assert clock.sleeps == [5.0, 5.0, 5.0]


def test_await_device_gives_up_at_the_deadline_after_many_probes(clock):
    # A sleeping Kindle is normal, so giving up must not be fatal -- but it must
    # actually have retried, and must not run past the deadline.
    from app.main import await_device
    dev = _FakeDevice(succeed_after=10**6)
    assert await_device(dev, timeout=60.0) is False
    assert dev.probes == 13            # 12 gaps * 5s = 60s, then one last probe
    assert clock.now == 1060.0


def test_await_device_probes_once_when_the_budget_is_zero(clock):
    from app.main import await_device
    dev = _FakeDevice(succeed_after=10**6)
    assert await_device(dev, timeout=0.0) is False
    assert dev.probes == 1
    assert clock.sleeps == []


def test_main_waits_for_the_device_before_the_first_cycle(monkeypatch):
    # Guards against the call being dropped from main(): without it the fix is
    # inert and nothing else in the suite would notice.
    import app.main as m
    calls = []
    monkeypatch.setattr(m, "await_device", lambda dev, **kw: calls.append(dev) or True)
    monkeypatch.setattr(m.metrics, "rebuild_from_ledger", lambda *a: None)
    monkeypatch.setattr(m.metrics, "serve", lambda *a, **k: None)

    ctx = types.SimpleNamespace(device=object(), ledger=object(),
                                stop={"now": True})   # exit after one check
    cfg = types.SimpleNamespace(metrics_port=0, poll_interval=1,
                                pull_timeout=10, convert_timeout=10)
    monkeypatch.setattr(m.Ctx, "build", staticmethod(lambda c: ctx))
    monkeypatch.setattr(m.Config, "from_env", staticmethod(lambda: cfg))

    assert m.main() == 0
    assert calls == [ctx.device]


# --- an unexpected exception must not wedge the whole cycle -----------------
# The vendored DeDRM code raises whatever it likes (observed in the cluster:
# ValueError("Incorrect AES key length (0 bytes)") when the keyfile carried no
# record for a book). Without a catch-all that escaped _process, aborted the
# cycle mid-loop, and -- because no ledger record was written -- attempts never
# incremented, so the same book crashed every cycle forever and no other book
# could be processed.

def test_unexpected_exception_does_not_abort_the_cycle(cfg, monkeypatch):
    bad, good = _book("B0POISON01"), _book("B0FINE0001")

    def boom(enc, keyfile, out):
        raise ValueError("Incorrect AES key length (0 bytes)")
    monkeypatch.setattr(M, "decrypt_archive", boom)

    ctx = _ctx(cfg, FakeDevice({bad.asin: bad, good.asin: good}))
    r = M.run_cycle(ctx)                    # must not raise
    assert ctx.ledger.get(bad.asin) is not None
    assert ctx.ledger.get(good.asin) is not None   # the cycle kept going


def test_unexpected_exception_increments_attempts_so_it_can_give_up(cfg, monkeypatch):
    b = _book("B0POISON01")
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda *a: (_ for _ in ()).throw(ValueError("boom")))
    ctx = _ctx(cfg, FakeDevice({b.asin: b}))

    for _ in range(M.MAX_ATTEMPTS + 1):
        M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin)
    assert rec["attempts"] >= M.MAX_ATTEMPTS
    assert rec["outcome"] == FAILED         # bounded, not an infinite retry


def test_unexpected_exception_never_uploads(cfg, monkeypatch):
    b = _book("B0POISON01")
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda *a: (_ for _ in ()).throw(ValueError("boom")))
    api = FakeApi()
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), api))
    assert api.upload_calls == 0


def test_stopping_is_not_misread_as_a_book_failure(cfg, monkeypatch):
    # The catch-all must not swallow SIGTERM: run_cycle abandons the book and
    # breaks cleanly, and the book must NOT be blamed for the shutdown.
    b = _book("B0STOP0001")
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda *a: (_ for _ in ()).throw(M.Stopping()))
    ctx = _ctx(cfg, FakeDevice({b.asin: b}))
    M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin) or {}
    assert rec.get("outcome") != FAILED
    assert "Stopping" not in str(rec.get("error", ""))


def test_a_book_missing_its_key_is_retryable_not_failed(cfg, monkeypatch):
    # The device emits keys each cycle; a key absent this time will be there
    # next time. Marking it FAILED would strand the book permanently.
    from app.decrypt import KeyUnavailable
    b = _book("B0NOKEY001")
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda *a: (_ for _ in ()).throw(KeyUnavailable("no key")))
    ctx = _ctx(cfg, FakeDevice({b.asin: b}))
    M.run_cycle(ctx)
    assert ctx.ledger.get(b.asin)["outcome"] == RETRYABLE


def test_health_stall_window_outlives_one_slow_book(cfg, monkeypatch):
    # liveness hits /healthz every 60s with failureThreshold 5, so a stale
    # heartbeat kills the pod after ~5 min. One book may legitimately take
    # pull_timeout + convert_timeout (3600 + 1800 = 5400s), which blew straight
    # past the old fixed 1800s window -- a restart loop on exactly the large
    # comics PULL_TIMEOUT exists to allow.
    import app.main as m
    seen = {}
    monkeypatch.setattr(m.metrics, "rebuild_from_ledger", lambda *a: None)
    monkeypatch.setattr(m.metrics, "serve",
                        lambda port, **kw: seen.update(kw) or None)
    monkeypatch.setattr(m, "await_device", lambda *a, **k: True)
    ctx = types.SimpleNamespace(device=object(), ledger=object(), stop={"now": True})
    monkeypatch.setattr(m.Ctx, "build", staticmethod(lambda c: ctx))
    monkeypatch.setattr(m.Config, "from_env", staticmethod(lambda: cfg))
    m.main()
    assert seen.get("stale_after", 0) > cfg.pull_timeout + cfg.convert_timeout


# --- key emission is best-effort -------------------------------------------
# emit_keys walks every book on the device under cycle_deadline (540s at the
# default poll interval). An unguarded timeout there propagated out of
# run_cycle and killed the whole cycle, throwing away the partial keyfile that
# would have let the already-keyed books through. Books whose key is missing
# are already handled: KeyUnavailable -> RETRYABLE.

class _EmitFailsDevice(FakeDevice):
    def __init__(self, exc, **kw):
        super().__init__(**kw)
        self._exc = exc

    def emit_keys(self):
        self.keys_emitted += 1
        raise self._exc


def test_a_timed_out_key_emission_does_not_kill_the_cycle(cfg):
    import subprocess
    b = _book("B0KEYS00001")
    dev = _EmitFailsDevice(subprocess.TimeoutExpired("ssh", 540),
                           books={b.asin: b})
    ctx = _ctx(cfg, dev)
    r = M.run_cycle(ctx)                     # must not raise
    assert dev.keys_emitted == 1
    assert ctx.ledger.get(b.asin) is not None    # the book was still attempted


def test_the_partial_keyfile_is_still_used_after_a_failed_emission(cfg, monkeypatch):
    import subprocess
    b = _book("B0KEYS00002")
    dev = _EmitFailsDevice(subprocess.TimeoutExpired("ssh", 540),
                           books={b.asin: b})
    api = FakeApi()
    # this book's key WAS already in the keyfile, so decryption succeeds
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda enc, kf, out: open(out, "wb").write(b"d") and 1)
    monkeypatch.setattr(M, "to_epub", lambda a, o, t: open(o, "wb").write(b"e") and "")
    monkeypatch.setattr(M, "classify", lambda p: type(
        "C", (), {"is_comic": False, "confidence": "confident", "reasons": []})())
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)
    M.run_cycle(_ctx(cfg, dev, api))
    assert api.upload_calls == 1


# --- a hard crash must still cost an attempt --------------------------------
# The pod was OOMKilled mid-decrypt on a 400MB+ comic. No except clause can
# catch that. _process only wrote a ledger record AFTER decryption succeeded,
# so attempts stayed unchanged and the same book would OOM the pod every cycle
# forever -- blocking every other book behind it.

def test_the_attempt_is_recorded_before_the_expensive_work(cfg, monkeypatch):
    b = _book("B0OOMKILL01")
    seen = {}

    def spy_decrypt(enc, keyfile, out):
        # stand-in for the moment the process dies: what is durable right now?
        rec = ctx.ledger.get(b.asin) or {}
        seen["attempts_at_decrypt"] = rec.get("attempts")
        raise M.DecryptFailed("boom")

    monkeypatch.setattr(M, "decrypt_archive", spy_decrypt)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}))
    M.run_cycle(ctx)
    assert seen["attempts_at_decrypt"] == 1, "attempt was not durable before decrypt"


def test_a_book_that_always_hard_crashes_is_eventually_given_up_on(cfg, monkeypatch):
    # Simulates the OOM loop: the process dies before any outcome is written.
    b = _book("B0OOMKILL02")
    led = Ledger(cfg.ledger_path)

    class Crash(BaseException):        # not an Exception: no handler catches it
        pass

    def hard_crash(*a):
        raise Crash()

    monkeypatch.setattr(M, "decrypt_archive", hard_crash)
    for _ in range(M.MAX_ATTEMPTS + 1):
        ctx = _ctx(cfg, FakeDevice({b.asin: b}), ledger=led)
        try:
            M.run_cycle(ctx)
        except Crash:
            pass                        # the "process" died; next cycle restarts
    rec = led.get(b.asin) or {}
    assert rec.get("attempts", 0) >= M.MAX_ATTEMPTS


# --- uploaded books get a readable title ------------------------------------

class _MetaApi(FakeApi):
    def __init__(self, fail=False, limit=None, **kw):
        super().__init__(**kw)
        self.meta = []
        self._fail = fail
        self._limit = limit
    def upload_limit_bytes(self):
        return self._limit if self._limit is not None else 500 * 1024 * 1024
    def set_metadata(self, book_id, title=None, asin=None):
        if self._fail:
            raise Transport("metadata service down")
        self.meta.append((book_id, title, asin))


def _stub_pipeline(monkeypatch):
    monkeypatch.setattr(M, "decrypt_archive",
                        lambda enc, kf, out: open(out, "wb").write(b"d") and 1)
    monkeypatch.setattr(M, "to_epub", lambda a, o, t: open(o, "wb").write(b"e") and "")
    monkeypatch.setattr(M, "classify", lambda p: type(
        "C", (), {"is_comic": False, "confidence": "confident", "reasons": []})())
    monkeypatch.setattr(M, "verify_artifact", lambda *a, **k: None)


def test_an_uploaded_book_is_given_its_real_title(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0TITLE001", "Halo_ Rise of Atriox #1_B0TITLE001", 100, 2)
    api = _MetaApi()
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), api))
    assert api.meta == [(99, "Halo: Rise of Atriox #1", "B0TITLE001")]


def test_a_failed_title_update_does_not_fail_the_upload(cfg, monkeypatch):
    # The book IS uploaded and verified; a cosmetic metadata call must not
    # undo that or send it back through the whole pipeline next cycle.
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0TITLE002", "Some Book_B0TITLE002", 100, 2)
    api = _MetaApi(fail=True)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    r = M.run_cycle(ctx)
    assert r.uploaded == 1
    assert ctx.ledger.get(b.asin)["outcome"] == OK


def test_an_uploaded_book_is_enriched(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0ENRICH01", "Some Comic_B0ENRICH01", 100, 2)

    class Api(_MetaApi):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.enriched = []
        def enrich(self, book_id):
            self.enriched.append(book_id)

    api = Api()
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), api))
    assert api.enriched == [99]


def test_enrichment_failure_does_not_fail_the_upload(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0ENRICH02", "Some Comic_B0ENRICH02", 100, 2)

    class Api(_MetaApi):
        def enrich(self, book_id):
            raise Transport("enrichment down")

    api = Api()
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    r = M.run_cycle(ctx)
    assert r.uploaded == 1
    assert ctx.ledger.get(b.asin)["outcome"] == OK


# --- a book too large for the server is a decision, not a defect ------------
# BookOrbit hardcodes MAX_UPLOAD_BYTES = 500MB and 413s anything larger. The
# Invincible compendiums convert to 699MB and 646MB CBZs, so they pulled,
# decrypted and converted fine and then failed at the last step -- recorded
# FAILED, which reads as "this book is broken" when nothing is broken.

def test_an_oversized_artifact_is_not_uploaded(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    big = cfg.max_upload_bytes + 1
    monkeypatch.setattr(M, "to_epub",
                        lambda a, o, t: open(o, "wb").write(b"x" * big) and "")
    b = DeviceBook("B0HUGE0001", "Huge Compendium_B0HUGE0001", 100, 2)
    api = _MetaApi()
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), api)
    M.run_cycle(ctx)
    assert api.upload_calls == 0, "must not attempt a doomed upload"


def test_an_oversized_artifact_needs_a_decision(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    big = cfg.max_upload_bytes + 1
    monkeypatch.setattr(M, "to_epub",
                        lambda a, o, t: open(o, "wb").write(b"x" * big) and "")
    b = DeviceBook("B0HUGE0002", "Huge Compendium_B0HUGE0002", 100, 2)
    ctx = _ctx(cfg, FakeDevice({b.asin: b}), _MetaApi())
    r = M.run_cycle(ctx)
    rec = ctx.ledger.get(b.asin)
    assert rec["outcome"] == NEEDS_DECISION
    assert "500" in str(rec.get("detail")) or "limit" in str(rec.get("detail")).lower()
    assert r.needs_decision == 1


def test_an_artifact_within_the_limit_uploads_normally(cfg, monkeypatch):
    _stub_pipeline(monkeypatch)
    b = DeviceBook("B0FINE0003", "Normal Book_B0FINE0003", 100, 2)
    api = _MetaApi()
    M.run_cycle(_ctx(cfg, FakeDevice({b.asin: b}), api))
    assert api.upload_calls == 1
