"""Tests for app/runner.py: `claude -p` argv, env allowlist, and the
subprocess/transcript machinery. `popen`/`killpg` are injected fakes here --
no test in this file spawns a real process or sends a real signal. The real
lockdown (does a genuine `claude` binary actually stay confined to
mcp__librarian__* tools) is re-verified separately by
tests/probe_lockdown.py, which is NOT collected by pytest.
"""
import json
import os
import subprocess

import pytest

from app.config import Settings
from app.runner import RunResult, child_env, claude_argv, run_claude

BASE_ENV_SETTINGS = {"BOOKORBIT_URL": "http://b", "BOOKORBIT_USER": "u", "BOOKORBIT_PASS": "p"}


def _settings(**overrides):
    return Settings.from_env({**BASE_ENV_SETTINGS, **overrides})


# --- claude_argv -------------------------------------------------------------


def test_claude_argv_exact():
    settings = _settings()
    mcp_config = {"mcpServers": {"librarian": {"command": "python3", "args": ["-m", "app.mcp_shim"], "env": {}}}}
    argv = claude_argv(settings, "do the thing", mcp_config, "opus")
    assert argv == [
        "claude",
        "-p",
        "do the thing",
        "--model",
        "opus",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        json.dumps(mcp_config),
        "--allowedTools",
        "mcp__librarian__*",
        "--setting-sources",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
    ]


def test_claude_argv_never_bare_or_agent():
    settings = _settings()
    argv = claude_argv(settings, "p", {"mcpServers": {}}, "opus")
    assert "--bare" not in argv
    assert "Agent" not in argv
    assert "--tools" in argv
    tools_idx = argv.index("--tools")
    assert argv[tools_idx + 1] == ""


def test_claude_argv_uses_settings_claude_bin():
    settings = _settings(CLAUDE_BIN="/usr/local/bin/claude")
    argv = claude_argv(settings, "p", {"mcpServers": {}}, "haiku")
    assert argv[0] == "/usr/local/bin/claude"


# --- child_env ---------------------------------------------------------------


def test_child_env_excludes_bookorbit_includes_oauth():
    base_env = {
        "PATH": "/usr/bin",
        "HOME": "/tmp/runs/abc/home",
        "CLAUDE_CONFIG_DIR": "/tmp/runs/abc/claude-config",
        "CLAUDE_CODE_OAUTH_TOKEN": "sk-secret-token",
        "BOOKORBIT_PASS": "hunter2",
        "BOOKORBIT_URL": "http://b",
        "TZ": "America/Los_Angeles",
    }
    env = child_env(_settings(), base_env)
    assert not any(k.startswith("BOOKORBIT") for k in env)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-secret-token"
    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == "/tmp/runs/abc/home"
    assert env["CLAUDE_CONFIG_DIR"] == "/tmp/runs/abc/claude-config"
    assert env["TZ"] == "America/Los_Angeles"


def test_child_env_sets_lockdown_flags_unconditionally():
    env = child_env(_settings(), {})
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert env["DISABLE_AUTOUPDATER"] == "1"


def test_child_env_is_allowlist_not_copy():
    """A caller passing os.environ-shaped noise through base_env must not
    leak arbitrary keys -- only the fixed allowlist ever appears."""
    base_env = {"RANDOM_HOST_SECRET": "leak-me", "PATH": "/bin"}
    env = child_env(_settings(), base_env)
    assert "RANDOM_HOST_SECRET" not in env
    assert env["PATH"] == "/bin"


def test_child_env_omits_tz_when_absent():
    env = child_env(_settings(), {"PATH": "/bin"})
    assert "TZ" not in env


# --- run_claude ---------------------------------------------------------------


class _FakeProc:
    """Emits `lines` (already-encoded stream-json strings) then EOF, and
    reports a clean exit -- simulates a normal, quick `claude -p` run."""

    def __init__(self, lines, exit_code=0, pid=4242):
        self.stdout = iter((line + "\n").encode("utf-8") for line in lines)
        self.pid = pid
        self._exit_code = exit_code

    def wait(self, timeout=None):
        return self._exit_code


class _NeverExitsProc:
    """A real pipe whose write end is never closed, so iterating `stdout`
    blocks forever on the reader thread (which is fine -- it's a daemon
    thread). `wait()` raises TimeoutExpired immediately rather than
    actually blocking, so this test doesn't burn real wall-clock time
    waiting on a process that (being fake) will never really exit."""

    def __init__(self, pid=9999):
        r, w = os.pipe()
        self.stdout = os.fdopen(r, "rb")
        self._w = w
        self.pid = pid

    def wait(self, timeout=None):
        raise subprocess.TimeoutExpired(cmd="fake", timeout=timeout or 0)


RESULT_LINE = json.dumps({
    "type": "result",
    "result": "done",
    "total_cost_usd": 0.0123,
    "usage": {"input_tokens": 10, "output_tokens": 20},
    "num_turns": 3,
    "is_error": False,
})


def test_run_claude_parses_result_and_writes_transcript(tmp_path):
    lines = [
        json.dumps({"type": "system", "subtype": "init"}),
        RESULT_LINE,
    ]
    calls = []

    def fake_popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return _FakeProc(lines)

    transcript_path = str(tmp_path / "runs" / "run-1" / "transcript.jsonl")
    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={"PATH": "/bin"},
        timeout=5,
        transcript_path=transcript_path,
        popen=fake_popen,
        killpg=lambda *a, **k: pytest.fail("killpg must not be called on a clean exit"),
    )

    assert isinstance(result, RunResult)
    assert result.ok is True
    assert result.exit_code == 0
    assert result.timed_out is False
    assert result.result_text == "done"
    assert result.cost_usd == 0.0123
    assert result.usage == {"input_tokens": 10, "output_tokens": 20}
    assert result.num_turns == 3
    assert result.transcript_path == transcript_path

    assert os.path.exists(transcript_path)
    with open(transcript_path) as f:
        written = f.read().splitlines()
    assert written == lines

    assert os.path.exists(transcript_path + ".stderr")

    # stdin must be DEVNULL and the process group must be started fresh.
    _, kwargs = calls[0]
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["start_new_session"] is True


def test_run_claude_timeout_kills_process_group(tmp_path):
    killpg_calls = []

    def fake_popen(argv, **kwargs):
        return _NeverExitsProc(pid=13131)

    def fake_killpg(pid, sig):
        killpg_calls.append((pid, sig))

    ticks = []
    transcript_path = str(tmp_path / "transcript.jsonl")
    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=0.1,
        transcript_path=transcript_path,
        popen=fake_popen,
        killpg=fake_killpg,
        on_tick=lambda: ticks.append(1),
    )

    assert result.timed_out is True
    assert result.ok is False
    assert killpg_calls == [(13131, __import__("signal").SIGKILL)]
    # timeout (0.1s) is far shorter than the 30s tick interval.
    assert ticks == []


def test_run_claude_creates_transcript_dir_if_missing(tmp_path):
    transcript_path = str(tmp_path / "does" / "not" / "exist" / "transcript.jsonl")

    def fake_popen(argv, **kwargs):
        return _FakeProc([RESULT_LINE])

    run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=5,
        transcript_path=transcript_path,
        popen=fake_popen,
        killpg=lambda *a, **k: None,
    )
    assert os.path.exists(transcript_path)


def test_run_claude_is_error_result_marks_not_ok(tmp_path):
    error_line = json.dumps({
        "type": "result",
        "result": "",
        "total_cost_usd": 0.01,
        "usage": {},
        "num_turns": 1,
        "is_error": True,
    })

    def fake_popen(argv, **kwargs):
        return _FakeProc([error_line])

    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=5,
        transcript_path=str(tmp_path / "t.jsonl"),
        popen=fake_popen,
        killpg=lambda *a, **k: None,
    )
    assert result.ok is False
    assert result.exit_code == 0
