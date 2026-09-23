"""Sandboxed `claude -p` launcher: argv, subprocess management, transcripts.

This module is the only place in the librarian image that builds an
argv for `claude -p` or spawns it. The lockdown is exact (plan global
constraints) -- `--tools "" --strict-mcp-config --mcp-config <json>
--allowedTools "mcp__librarian__*" --setting-sources "" --permission-mode
dontAsk --no-session-persistence --output-format stream-json --verbose`,
`stdin=/dev/null`. `--tools ""` disables every built-in tool (Bash, Read,
Write, WebFetch, Agent, ...); `--allowedTools "mcp__librarian__*"`
re-enables *only* tools from the one MCP server named "librarian" in
`--mcp-config` (app/mcp_shim.py, Task 10). Never add `--bare` (it refuses
OAuth token auth) and never widen `--allowedTools` to include `Agent` --
Claude Code sub-agents get their own tool policy and can escape `--tools`
entirely (verified against Claude Code 2.1.280 on 2026-09-22; see Task 11
Step 5's real-process probe, tests/probe_lockdown.py, which re-verifies
this exact argv against a real `claude` binary before every deploy of this
module).

`child_env` builds the child's environment as an ALLOWLIST from a caller-
supplied `base_env` -- never a copy of `os.environ`, and never a copy of
the *service's* full environment either, which is where BookOrbit
credentials (`BOOKORBIT_*`) live. The sandboxed model has no legitimate
reason to see those, and this function is the last line of defense against
them leaking into the subprocess even if a caller passes a `base_env` that
still carries them by mistake. The caller (app/service.py, Task 12)
populates `base_env["HOME"]`/`base_env["CLAUDE_CONFIG_DIR"]` with a fresh
per-run directory under `/tmp/runs/<run_id>` before calling this.

`run_claude` reads the child's stdout on a background thread specifically
so the timeout still fires when the process is wedged and never writes a
line at all -- waiting on `proc.wait(timeout=...)` alone would not notice
that case since it only ever measures process exit, not line arrival.
`on_tick()` (the service passes `metrics.beat`) runs roughly every 30s
while the main thread is waiting, so a legitimately long run (up to
`Settings.run_timeout`, default 2700s) does not look stalled to whatever
liveness check is watching `on_tick`'s side effect. On timeout the whole
process GROUP is killed (`start_new_session=True` at spawn +
`killpg(pid, SIGKILL)`) -- `claude -p` can itself fork the MCP shim
subprocess (app/mcp_shim.py runs as a *child* of the `claude` process, per
`build_mcp_config`), and killing only the parent would orphan it.
`popen`/`killpg` are injected (default `subprocess.Popen`/`os.killpg`) so
tests never send a real signal to a real process group.
"""
import json
import os
import signal
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass

_TICK_INTERVAL = 30  # seconds between on_tick() calls while waiting

# child_env allowlist: keys copied from base_env verbatim if present. TZ is
# handled separately below (copied only if the caller set one -- there is no
# sane default to substitute).
_ALLOWED_COPY_KEYS = ("PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN")


def claude_argv(settings, prompt_text: str, mcp_config: dict, model: str) -> list[str]:
    """The exact `claude -p` argv for this run (plan global constraints).
    `settings.claude_bin` is normally "claude" (app/config.py default) but
    is configurable for testing/vendoring a specific binary path."""
    return [
        settings.claude_bin,
        "-p",
        prompt_text,
        "--model",
        model,
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


def child_env(settings, base_env: Mapping[str, str]) -> dict[str, str]:
    """Allowlist, not a copy (see module docstring). `settings` is accepted
    for signature parity with the rest of this module's factories and for
    any future settings-driven allowlist entries; it is not currently
    consulted -- the per-run HOME/CLAUDE_CONFIG_DIR/OAuth token values all
    come from `base_env`, which the caller builds per run."""
    del settings
    env = {key: base_env[key] for key in _ALLOWED_COPY_KEYS if key in base_env}
    # Unconditional lockdown flags -- always set regardless of base_env.
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    env["DISABLE_AUTOUPDATER"] = "1"
    if "TZ" in base_env:
        env["TZ"] = base_env["TZ"]
    return env


@dataclass
class RunResult:
    ok: bool
    exit_code: int | None
    timed_out: bool
    result_text: str
    cost_usd: float | None
    usage: dict
    num_turns: int | None
    transcript_path: str


def _decode(raw) -> str:
    if isinstance(raw, bytes):
        return raw.decode("utf-8", "replace")
    return raw


def _parse_result_line(lines: list[str]) -> dict:
    """Scan the transcript's stream-json lines for the terminal
    `{"type": "result", ...}` line and pull out the fields the caller
    needs. Any non-JSON or non-result line is ignored -- `--verbose`
    stream-json emits several other event types first (system/init,
    assistant, tool_use, tool_result, ...)."""
    parsed = {"result_text": "", "cost_usd": None, "usage": {}, "num_turns": None, "is_error": False}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "result":
            parsed["result_text"] = obj.get("result", "")
            parsed["cost_usd"] = obj.get("total_cost_usd")
            parsed["usage"] = obj.get("usage", {})
            parsed["num_turns"] = obj.get("num_turns")
            parsed["is_error"] = bool(obj.get("is_error", False))
    return parsed


def run_claude(
    argv,
    *,
    cwd,
    env,
    timeout,
    transcript_path,
    popen=subprocess.Popen,
    killpg=os.killpg,
    on_tick=None,
) -> RunResult:
    """Spawn `argv`, stream stdout line-by-line to `transcript_path`
    (creating its directory if missing), stderr to `transcript_path +
    ".stderr"`, and parse the terminal stream-json result line. Kills the
    whole process group on timeout. See the module docstring for why
    reading happens on a background thread and why `on_tick` exists."""
    transcript_dir = os.path.dirname(os.path.abspath(transcript_path))
    os.makedirs(transcript_dir, exist_ok=True)
    stderr_path = transcript_path + ".stderr"

    lines: list[str] = []
    reader_done = threading.Event()

    stderr_f = open(stderr_path, "wb")
    try:
        proc = popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=stderr_f,
            start_new_session=True,
        )
    except BaseException:
        stderr_f.close()
        raise

    def _read():
        try:
            with open(transcript_path, "a", encoding="utf-8") as tf:
                for raw in proc.stdout:
                    line = _decode(raw)
                    tf.write(line if line.endswith("\n") else line + "\n")
                    tf.flush()
                    lines.append(line)
        finally:
            reader_done.set()

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()

    start = time.monotonic()
    deadline = start + timeout
    next_tick = start + _TICK_INTERVAL
    timed_out = False
    while True:
        now = time.monotonic()
        if now >= deadline:
            timed_out = True
            break
        wait_for = min(deadline, next_tick) - now
        if wait_for < 0:
            wait_for = 0
        if reader_done.wait(timeout=wait_for):
            break
        now = time.monotonic()
        if now >= next_tick:
            if on_tick is not None:
                on_tick()
            next_tick = now + _TICK_INTERVAL

    exit_code = None
    if timed_out:
        try:
            killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass
        reader.join(timeout=5)
        try:
            exit_code = proc.wait(timeout=5)
        except Exception:
            exit_code = None
    else:
        reader.join(timeout=5)
        exit_code = proc.wait()

    stderr_f.close()

    parsed = _parse_result_line(lines)
    ok = exit_code == 0 and not parsed["is_error"] and not timed_out

    return RunResult(
        ok=ok,
        exit_code=exit_code,
        timed_out=timed_out,
        result_text=parsed["result_text"],
        cost_usd=parsed["cost_usd"],
        usage=parsed["usage"],
        num_turns=parsed["num_turns"],
        transcript_path=transcript_path,
    )
