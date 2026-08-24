import pytest
from app.config import Config, ConfigError

BASE = {"BOOKORBIT_URL": "https://x/", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"}


def test_requires_bookorbit_credentials(monkeypatch):
    monkeypatch.delenv("BOOKORBIT_URL", raising=False)
    with pytest.raises(ConfigError):
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


def test_blank_env_is_treated_as_missing(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("BOOKORBIT_URL", "   ")
    with pytest.raises(ConfigError):
        Config.from_env()


def test_blank_optional_falls_back_to_default(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("KINDLE_HOST", "")
    assert Config.from_env().kindle_host == "100.64.0.12"


def test_bad_integer_names_the_variable(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("POLL_INTERVAL", "10m")
    with pytest.raises(ConfigError) as e:
        Config.from_env()
    assert "POLL_INTERVAL" in str(e.value)


def test_password_is_not_in_repr(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("BOOKORBIT_PASS", "hunter2")
    assert "hunter2" not in repr(Config.from_env())


def test_cycle_deadline_must_be_shorter_than_the_interval(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("POLL_INTERVAL", "600")
    monkeypatch.setenv("CYCLE_DEADLINE", "3600")
    with pytest.raises(ConfigError):
        Config.from_env()


def test_work_dir_follows_data_dir(monkeypatch):
    for k, v in BASE.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("DATA_DIR", "/mnt/books")
    assert Config.from_env().work_dir == "/mnt/books/work"
