"""Tests for app/runner.py: `claude -p` argv, env allowlist, and the
subprocess/transcript machinery. `popen`/`killpg` are injected fakes here --
no test in this file spawns a real process or sends a real signal. The real
lockdown (does a genuine `claude` binary actually stay confined to
mcp__librarian__* tools) is re-verified separately by
tests/probe_lockdown.py, which is NOT collected by pytest.
"""
import json
import os
import signal
import subprocess
import threading

import pytest

import app.runner as runner_mod
from app.config import Settings
from app.runner import RunResult, child_env, claude_argv, granted_tools, run_claude

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


def test_claude_argv_rejects_oversized_prompt():
    settings = _settings()
    with pytest.raises(ValueError):
        claude_argv(settings, "x" * 100_001, {"mcpServers": {}}, "opus")


def test_claude_argv_accepts_prompt_at_the_limit():
    settings = _settings()
    argv = claude_argv(settings, "x" * 100_000, {"mcpServers": {}}, "opus")
    assert argv[2] == "x" * 100_000


# --- child_env ---------------------------------------------------------------


def test_child_env_excludes_bookorbit_includes_oauth(tmp_path):
    runs_root = tmp_path / "runs"
    run_dir = str(runs_root / "run-1")
    settings = _settings(RUNS_ROOT=str(runs_root))
    base_env = {
        "PATH": "/usr/bin",
        "CLAUDE_CODE_OAUTH_TOKEN": "sk-secret-token",
        "BOOKORBIT_PASS": "hunter2",
        "BOOKORBIT_URL": "http://b",
        "TZ": "America/Los_Angeles",
    }
    env = child_env(settings, base_env, run_dir)
    assert not any(k.startswith("BOOKORBIT") for k in env)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-secret-token"
    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == run_dir
    assert env["CLAUDE_CONFIG_DIR"] == os.path.join(run_dir, "claude-config")
    assert env["TZ"] == "America/Los_Angeles"


def test_child_env_ignores_base_env_home_and_config_dir(tmp_path):
    """Fix round 1, I1: HOME/CLAUDE_CONFIG_DIR are computed from run_dir,
    never copied from base_env even if present there -- a caller passing
    the host's real HOME must not have it leak through."""
    runs_root = tmp_path / "runs"
    run_dir = str(runs_root / "run-1")
    settings = _settings(RUNS_ROOT=str(runs_root))
    base_env = {
        "HOME": "/root",
        "CLAUDE_CONFIG_DIR": "/root/.claude",
    }
    env = child_env(settings, base_env, run_dir)
    assert env["HOME"] == run_dir
    assert env["HOME"] != "/root"
    assert env["CLAUDE_CONFIG_DIR"] == os.path.join(run_dir, "claude-config")
    assert env["CLAUDE_CONFIG_DIR"] != "/root/.claude"


def test_child_env_rejects_run_dir_outside_runs_root(tmp_path):
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    outside = str(tmp_path / "elsewhere" / "run-1")
    with pytest.raises(ValueError):
        child_env(settings, {}, outside)


def test_child_env_rejects_dotdot_escape(tmp_path):
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    escape = str(runs_root / ".." / "evil")
    with pytest.raises(ValueError):
        child_env(settings, {}, escape)


def test_child_env_rejects_run_dir_equal_to_runs_root(tmp_path):
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    with pytest.raises(ValueError):
        child_env(settings, {}, str(runs_root))


def test_child_env_sets_lockdown_flags_unconditionally(tmp_path):
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    env = child_env(settings, {}, str(runs_root / "run-1"))
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert env["DISABLE_AUTOUPDATER"] == "1"


def test_child_env_is_allowlist_not_copy(tmp_path):
    """A caller passing os.environ-shaped noise through base_env must not
    leak arbitrary keys -- only the fixed allowlist ever appears."""
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    base_env = {"RANDOM_HOST_SECRET": "leak-me", "PATH": "/bin"}
    env = child_env(settings, base_env, str(runs_root / "run-1"))
    assert "RANDOM_HOST_SECRET" not in env
    assert env["PATH"] == "/bin"


def test_child_env_omits_tz_when_absent(tmp_path):
    runs_root = tmp_path / "runs"
    settings = _settings(RUNS_ROOT=str(runs_root))
    env = child_env(settings, {"PATH": "/bin"}, str(runs_root / "run-1"))
    assert "TZ" not in env


# --- granted_tools -------------------------------------------------------


def test_granted_tools_reads_init_line(tmp_path):
    path = tmp_path / "transcript.jsonl"
    path.write_text(
        json.dumps({"type": "system", "subtype": "init", "tools": ["mcp__librarian__list_arrivals"]}) + "\n"
        + json.dumps({"type": "assistant"}) + "\n"
    )
    assert granted_tools(str(path)) == ["mcp__librarian__list_arrivals"]


def test_granted_tools_empty_when_no_init_line(tmp_path):
    path = tmp_path / "transcript.jsonl"
    path.write_text(json.dumps({"type": "assistant"}) + "\n")
    assert granted_tools(str(path)) == []


def test_granted_tools_empty_transcript(tmp_path):
    path = tmp_path / "transcript.jsonl"
    path.write_text("")
    assert granted_tools(str(path)) == []


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


class _BlockingStdout:
    """Blocks in `__next__` until `close()` is called, then ends
    iteration -- lets a test exercise "reader thread still busy, must be
    force-closed during cleanup" WITHOUT a real OS pipe. A real pipe's
    read()/close() race across threads is undefined/racy on close from
    another thread while a blocking read is in flight (observed to hang
    a test outright rather than reliably unblock it), so this uses a
    plain `threading.Event` instead -- deterministic and doesn't spin
    the CPU while "wedged"."""

    def __init__(self):
        self._closed = threading.Event()

    def close(self):
        self._closed.set()

    def __iter__(self):
        return self

    def __next__(self):
        self._closed.wait()
        raise StopIteration


class _NeverExitsProc:
    """stdout never produces a line until forcibly closed during cleanup,
    and `wait()` never reports completion -- simulates a fully wedged
    process. `wait()` raises TimeoutExpired immediately rather than
    actually blocking, so tests don't burn real wall-clock time waiting on
    a process that (being fake) will never really exit."""

    def __init__(self, pid=9999):
        self.stdout = _BlockingStdout()
        self.pid = pid

    def wait(self, timeout=None):
        raise subprocess.TimeoutExpired(cmd="fake", timeout=timeout or 0)


class _StdoutClosesButNeverExitsProc:
    """stdout hits EOF immediately (as if the process finished emitting
    output) but `wait()` always times out -- e.g. a zombie/hung process
    that closed its pipes without actually exiting."""

    def __init__(self, pid=555):
        self.stdout = iter(())
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
    killpg_calls = []

    def fake_popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return _FakeProc(lines)

    def fake_killpg(pid, sig):
        killpg_calls.append((pid, sig))

    transcript_path = str(tmp_path / "runs" / "run-1" / "transcript.jsonl")
    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={"PATH": "/bin"},
        timeout=5,
        transcript_path=transcript_path,
        popen=fake_popen,
        killpg=fake_killpg,
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
    assert result.error_reason is None

    assert os.path.exists(transcript_path)
    with open(transcript_path) as f:
        written = f.read().splitlines()
    assert written == lines

    assert os.path.exists(transcript_path + ".stderr")

    # stdin must be DEVNULL and the process group must be started fresh.
    _, kwargs = calls[0]
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["start_new_session"] is True

    # Fix round 1, I2: killpg is called on EVERY exit path, including a
    # clean one (a real killpg on an already-dead group just raises
    # ProcessLookupError, which run_claude ignores).
    assert killpg_calls == [(4242, signal.SIGKILL)]


def test_run_claude_timeout_kills_process_group(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_mod, "_READER_JOIN_TIMEOUT", 0.05)
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
    assert result.error_reason == "result_missing"
    assert killpg_calls == [(13131, signal.SIGKILL)]
    # timeout (0.1s) is far shorter than the 30s tick interval.
    assert ticks == []


def test_run_claude_stdout_eof_but_process_never_exits_times_out(tmp_path):
    """Fix round 1, I2: reaching EOF on stdout is not enough -- if the
    process itself never actually exits within the remaining budget,
    that's still a timeout and still triggers the kill."""
    killpg_calls = []

    def fake_popen(argv, **kwargs):
        return _StdoutClosesButNeverExitsProc(pid=555)

    def fake_killpg(pid, sig):
        killpg_calls.append((pid, sig))

    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=0.1,
        transcript_path=str(tmp_path / "t.jsonl"),
        popen=fake_popen,
        killpg=fake_killpg,
    )
    assert result.timed_out is True
    assert killpg_calls == [(555, signal.SIGKILL)]


def test_run_claude_on_tick_exception_still_cleans_up_and_propagates(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_mod, "_TICK_INTERVAL", 0.01)
    monkeypatch.setattr(runner_mod, "_READER_JOIN_TIMEOUT", 0.05)
    killpg_calls = []

    def fake_popen(argv, **kwargs):
        return _NeverExitsProc(pid=777)

    def fake_killpg(pid, sig):
        killpg_calls.append((pid, sig))

    def boom():
        raise RuntimeError("boom-tick")

    with pytest.raises(RuntimeError, match="boom-tick"):
        run_claude(
            ["claude", "-p", "x"],
            cwd=str(tmp_path),
            env={},
            timeout=5,
            transcript_path=str(tmp_path / "t.jsonl"),
            popen=fake_popen,
            killpg=fake_killpg,
            on_tick=boom,
        )

    assert killpg_calls == [(777, signal.SIGKILL)]


def test_run_claude_killpg_other_error_falls_back_to_proc_kill(tmp_path):
    kill_calls = []

    class _KillableProc(_FakeProc):
        def kill(self):
            kill_calls.append(self.pid)

    def fake_popen(argv, **kwargs):
        return _KillableProc([RESULT_LINE], pid=888)

    def fake_killpg(pid, sig):
        raise PermissionError("nope")

    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=5,
        transcript_path=str(tmp_path / "t.jsonl"),
        popen=fake_popen,
        killpg=fake_killpg,
    )
    assert result.ok is True
    assert kill_calls == [888]


def test_run_claude_on_tick_fires(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_mod, "_TICK_INTERVAL", 0.01)
    monkeypatch.setattr(runner_mod, "_READER_JOIN_TIMEOUT", 0.05)
    ticks = []

    def fake_popen(argv, **kwargs):
        return _NeverExitsProc(pid=321)

    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=0.2,
        transcript_path=str(tmp_path / "t.jsonl"),
        popen=fake_popen,
        killpg=lambda *a, **k: None,
        on_tick=lambda: ticks.append(1),
    )
    assert result.timed_out is True
    assert len(ticks) >= 1


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


def test_run_claude_overwrites_stale_transcript(tmp_path):
    """Minor 8: a reused transcript_path must be overwritten, not mixed
    with stale content from a previous run."""
    transcript_path = str(tmp_path / "t.jsonl")
    with open(transcript_path, "w") as f:
        f.write("stale garbage from a previous run\n")

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
    with open(transcript_path) as f:
        content = f.read()
    assert "stale garbage" not in content
    assert RESULT_LINE in content


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
    assert result.error_reason is None  # a result line DID arrive


def test_run_claude_no_result_line_marks_result_missing(tmp_path):
    def fake_popen(argv, **kwargs):
        return _FakeProc([json.dumps({"type": "system", "subtype": "init"})])

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
    assert result.error_reason == "result_missing"
    assert result.result_text == ""
    assert result.usage == {}
    assert result.num_turns is None
    assert result.cost_usd is None


def test_run_claude_null_usage_and_result_default_to_empty(tmp_path):
    line = json.dumps({
        "type": "result",
        "result": None,
        "total_cost_usd": 0.02,
        "usage": None,
        "num_turns": 2,
        "is_error": False,
    })

    def fake_popen(argv, **kwargs):
        return _FakeProc([line])

    result = run_claude(
        ["claude", "-p", "x"],
        cwd=str(tmp_path),
        env={},
        timeout=5,
        transcript_path=str(tmp_path / "t.jsonl"),
        popen=fake_popen,
        killpg=lambda *a, **k: None,
    )
    assert result.result_text == ""
    assert result.usage == {}
    assert result.ok is True  # exit 0, not is_error, not timed out, got a result


def test_run_claude_rejects_oversized_argv_element(tmp_path):
    with pytest.raises(ValueError):
        run_claude(
            ["claude", "-p", "x" * 100_001],
            cwd=str(tmp_path),
            env={},
            timeout=5,
            transcript_path=str(tmp_path / "t.jsonl"),
            popen=lambda *a, **k: pytest.fail("must not spawn an oversized argv"),
            killpg=lambda *a, **k: None,
        )
