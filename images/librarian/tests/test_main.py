"""app/main.py wiring (Plan 2 Task 4): the executor and its writable
BookOrbit client exist only when DRY_RUN=false."""
import pytest

from app import main as main_mod


class FakeClient:
    made = []

    def __init__(self, url, user, password, cookie_path=None, writable=False, **kw):
        self.cookie_path = cookie_path
        self.writable = writable
        FakeClient.made.append(self)

    def authenticate(self):
        pass


class FakeService:
    last = None

    def __init__(self, settings, *, index, executor=None, **kw):
        self.settings = settings
        self.executor_arg = executor
        self.kw = kw
        self.api_port = 1
        self.arrivals = object()
        self.index = index
        FakeService.last = self

    def stopping(self):
        return False

    def serve_forever(self):
        pass

    def stop(self):
        pass

    def request_stop(self):
        return False


@pytest.fixture
def wired(monkeypatch, tmp_path):
    FakeClient.made = []
    FakeService.last = None
    monkeypatch.setattr(main_mod, "BookorbitClient", FakeClient)
    monkeypatch.setattr(main_mod, "LibraryIndex", lambda *a, **kw: object())
    monkeypatch.setattr(main_mod, "Service", FakeService)
    monkeypatch.setattr(main_mod.metrics, "serve", lambda *a, **kw: None)
    monkeypatch.setattr(main_mod.signal, "signal", lambda *a, **kw: None)
    for k, v in {"BOOKORBIT_URL": "http://b/api/v1", "BOOKORBIT_USER": "u",
                 "BOOKORBIT_PASS": "p", "STATE_DIR": str(tmp_path / "state")}.items():
        monkeypatch.setenv(k, v)
    return monkeypatch


def test_dry_run_constructs_no_writable_client_and_no_executor(wired):
    wired.delenv("DRY_RUN", raising=False)
    assert main_mod.main() == 0
    assert [c.writable for c in FakeClient.made] == [False]
    assert FakeService.last.executor_arg is None


def test_live_constructs_a_separate_writer_and_an_executor_factory(wired, tmp_path):
    wired.setenv("DRY_RUN", "false")
    assert main_mod.main() == 0
    assert [c.writable for c in FakeClient.made] == [False, True]
    writer_client = FakeClient.made[1]
    assert writer_client.cookie_path.endswith("bookorbit-writer-cookies.txt")
    factory = FakeService.last.executor_arg
    ex = factory(FakeService.last)
    assert type(ex).__name__ == "Executor"
    assert ex.writer._client is writer_client
    assert ex.arrivals is FakeService.last.arrivals


# --- Plan 2 Task 6: Vikunja wiring ------------------------------------------------

VK_ENV = {"VIKUNJA_ENABLED": "true", "VIKUNJA_TOKEN": "tk", "VIKUNJA_PROJECT_ID": "7",
          "VIKUNJA_PUBLIC_URL": "https://v.example", "BOOKORBIT_PUBLIC_URL": "https://bo.example"}


class FakeVikunja:
    made = []

    def __init__(self, base_url, token, project_id, public_url, store, session=None):
        self.args = (base_url, token, project_id, public_url)
        self.store = store
        self.verified = 0
        FakeVikunja.made.append(self)

    def verify(self):
        self.verified += 1
        return False          # a failed verify still wires it (retried by use; logged once)


@pytest.fixture
def vk(wired):
    FakeVikunja.made = []
    wired.setattr(main_mod, "Vikunja", FakeVikunja)
    return wired


def _vikunja_arg():
    return FakeService.last.kw.get("vikunja")


def test_vikunja_disabled_by_default(vk):
    assert main_mod.main() == 0
    assert FakeVikunja.made == [] and _vikunja_arg() is None


def test_vikunja_built_when_enabled_and_all_set(vk, tmp_path):
    for k, v in VK_ENV.items():
        vk.setenv(k, v)
    assert main_mod.main() == 0
    [v] = FakeVikunja.made
    assert v.args == ("http://vikunja.tools.svc.cluster.local:3456/api/v1", "tk", 7, "https://v.example")
    assert v.store.path == str(tmp_path / "state" / "vikunja.jsonl")
    assert v.verified == 1
    assert _vikunja_arg() is v


@pytest.mark.parametrize("missing", ["VIKUNJA_TOKEN", "VIKUNJA_PROJECT_ID", "VIKUNJA_PUBLIC_URL",
                                     "BOOKORBIT_PUBLIC_URL"])
def test_vikunja_not_built_when_a_setting_is_missing(vk, missing, caplog):
    for k, v in VK_ENV.items():
        if k != missing:
            vk.setenv(k, v)
    vk.delenv(missing, raising=False)
    assert main_mod.main() == 0
    assert FakeVikunja.made == [] and _vikunja_arg() is None
    assert missing in caplog.text
