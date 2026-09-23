import pytest
from app.config import Settings

BASE = {"BOOKORBIT_URL": "http://b", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"}


def test_defaults():
    s = Settings.from_env(BASE)
    assert s.dry_run is True and s.quiet_period == 600 and s.intake_root == "/media/library_intake"


def test_live_mode_refused():
    with pytest.raises(SystemExit):
        Settings.from_env({**BASE, "DRY_RUN": "false"})


def test_int_parsing():
    assert Settings.from_env({**BASE, "QUIET_PERIOD": "30"}).quiet_period == 30


def test_all_defaults_match_spec():
    s = Settings.from_env(BASE)
    assert s.local_books_root == "/media/books"
    assert s.bookorbit_path_prefix == "/books"
    assert s.state_dir == "/state"
    assert s.lists_dir == "/etc/librarian/lists"
    assert s.prompts_dir == "/etc/librarian/prompts"
    assert s.poll_interval == 120
    assert s.debounce == 300
    assert s.max_arrivals_per_run == 20
    assert s.run_timeout == 2700
    assert s.model == "opus"
    assert s.reviewer_model == "opus"
    assert s.metrics_port == 9090
    assert s.api_port == 8081
    assert s.claude_bin == "claude"
    assert s.retry_after == 3600
    assert s.only is None


def test_dry_run_accepts_1_and_0():
    assert Settings.from_env({**BASE, "DRY_RUN": "1"}).dry_run is True
    with pytest.raises(SystemExit):
        Settings.from_env({**BASE, "DRY_RUN": "0"})


def test_only_set_from_env():
    assert Settings.from_env({**BASE, "ONLY": "some-key"}).only == "some-key"


def test_settings_is_frozen():
    s = Settings.from_env(BASE)
    with pytest.raises(Exception):
        s.dry_run = False


def test_missing_required_field_raises():
    with pytest.raises(Exception):
        Settings.from_env({"BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"})


def test_runs_root_default_and_override():
    assert Settings.from_env(BASE).runs_root == "/tmp/runs"
    assert Settings.from_env({**BASE, "RUNS_ROOT": "/var/run/librarian"}).runs_root == "/var/run/librarian"
