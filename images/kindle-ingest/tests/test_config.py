import pytest
from app.config import Config

BASE = {"BOOKORBIT_URL": "https://x/", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"}


def test_requires_bookorbit_credentials(monkeypatch):
    monkeypatch.delenv("BOOKORBIT_URL", raising=False)
    with pytest.raises(KeyError):
        Config.from_env()


def test_defaults_and_url_normalisation(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    c = Config.from_env()
    assert c.bookorbit_url == "https://x"       # trailing slash stripped
    assert c.kindle_host == "100.64.0.12"
    assert c.poll_interval == 600
    assert c.cleanup_enabled is False           # cleanup off unless asked


def test_cleanup_flag_is_explicit(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("CLEANUP_ENABLED", "true")
    assert Config.from_env().cleanup_enabled is True
    monkeypatch.setenv("CLEANUP_ENABLED", "TRUE")
    assert Config.from_env().cleanup_enabled is True
    monkeypatch.setenv("CLEANUP_ENABLED", "0")
    assert Config.from_env().cleanup_enabled is False
