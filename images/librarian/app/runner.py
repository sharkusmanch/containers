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
entirely (verified against Claude Code 2.1.280 on 2026-09-22).

**A `claude_argv`/`claude -p` exit-code-0 result "used only mcp__librarian__*
tools" claim is not proof by itself** -- it only proves the model didn't
*claim* otherwise. `granted_tools()` below reads back what Claude Code
itself actually granted for the run (the `system`/`init` line's `tools`
list), which is what Task 11 Step 5's real-process probe
(tests/probe_lockdown.py) asserts against, and which app/service.py
(Task 12) is expected to reuse to refuse to trust any run whose granted
tools aren't all `mcp__librarian__*`.

`child_env` builds the child's environment as an ALLOWLIST from a caller-
supplied `base_env` -- never a copy of `os.environ`, and never a copy of
the *service's* full environment either, which is where BookOrbit
credentials (`BOOKORBIT_*`) live. `HOME`/`CLAUDE_CONFIG_DIR` are NOT taken
from `base_env` at all (fix round 1, I1) -- a caller that forgets to set
them, or a bug that lets them leak in from somewhere else, previously
failed open to the host's real `~/.claude`. `child_env` now computes both
itself from `run_dir`, and refuses (`ValueError`) unless
`os.path.realpath(run_dir)` is strictly under
`os.path.realpath(settings.runs_root)` -- `run_dir` (like
`transcript_path`) must always be built from a service-generated
`run_id` (see app/states.py's `Run.run_id`), NEVER from anything that
originated in an arrival, a dossier, or model text; those are untrusted
strings and a run_dir derived from one could otherwise be walked outside
`runs_root` with a `../` (the realpath check catches that too, but the
discipline is: don't feed it untrusted input in the first place).

`run_claude` parses each stdout line AS IT ARRIVES on a background thread
(never buffering the full transcript in memory -- a run can last up to
`Settings.run_timeout`, default 2700s, and stream a lot of stdout) so the
timeout still fires even when the process is wedged and never writes a
line at all. `on_tick()` (the service passes `metrics.beat`) runs roughly
every `_TICK_INTERVAL` seconds while the main thread is waiting, so a
legitimately long run does not look stalled to whatever liveness check is
watching `on_tick`'s side effect -- if `on_tick` itself raises, cleanup
(kill the process group, drain/close pipes) still happens in `finally`
before the exception propagates.

The whole process GROUP is killed on EVERY exit path (fix round 1, I2) --
including a clean exit -- because `claude -p` can itself fork the MCP shim
subprocess (app/mcp_shim.py runs as a *child* of the `claude` process, per
`build_mcp_config`) which inherits the same process group
(`start_new_session=True` at spawn); killing only the parent risks
orphaning it. A `killpg` on an already-exited group normally raises
`ProcessLookupError`, which is expected and ignored; any OTHER exception
from `killpg` is logged and `proc.kill()` is tried as a fallback.
`popen`/`killpg` are injected (default `subprocess.Popen`/`os.killpg`) so
tests never send a real signal to a real process group.
"""
import json
import logging
import os
import signal
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_TICK_INTERVAL = 30  # seconds between on_tick() calls while waiting; tests monkeypatch this
_READER_JOIN_TIMEOUT = 5  # seconds to wait for the reader thread to drain after kill; tests monkeypatch this

_MAX_PROMPT_BYTES = 100_000

# child_env allowlist: keys copied from base_env verbatim if present. HOME
# and CLAUDE_CONFIG_DIR are deliberately NOT here -- child_env always
# derives them from run_dir instead (fix round 1, I1). TZ is handled
# separately below (copied only if the caller set one).
_ALLOWED_COPY_KEYS = ("PATH", "CLAUDE_CODE_OAUTH_TOKEN")


def claude_argv(settings, prompt_text: str, mcp_config: dict, model: str) -> list[str]:
    """The exact `claude -p` argv for this run (plan global constraints).
    `settings.claude_bin` is normally "claude" (app/config.py default) but
    is configurable for testing/vendoring a specific binary path.

    Raises `ValueError` if `prompt_text` exceeds `_MAX_PROMPT_BYTES` --
    a runaway prompt (e.g. a dossier-construction bug pulling in far more
    text than intended) should fail loudly here rather than blow past
    `exec`'s real argv-size limit or burn an unbounded amount of cost."""
    prompt_bytes = len(prompt_text.encode("utf-8"))
    if prompt_bytes > _MAX_PROMPT_BYTES:
        raise ValueError(f"prompt_text is {prompt_bytes} bytes, exceeds the {_MAX_PROMPT_BYTES}-byte limit")
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


def _is_strictly_under(child_real: str, parent_real: str) -> bool:
    if child_real == parent_real:
        return False
    parent_with_sep = parent_real.rstrip(os.sep) + os.sep
    return child_real.startswith(parent_with_sep)


def child_env(settings, base_env: Mapping[str, str], run_dir: str) -> dict[str, str]:
    """Allowlist, not a copy (see module docstring). `HOME` and
    `CLAUDE_CONFIG_DIR` are always computed from `run_dir` -- any values
    for those two keys in `base_env` are ignored, never copied through.
    `run_dir` must resolve strictly inside `settings.runs_root`
    (`ValueError` otherwise); this uses `os.path.realpath` on both sides
    so a `run_dir` built with a `../` component cannot escape."""
    runs_root_real = os.path.realpath(settings.runs_root)
    run_dir_real = os.path.realpath(run_dir)
    if not _is_strictly_under(run_dir_real, runs_root_real):
        raise ValueError(f"run_dir {run_dir!r} must be strictly under runs_root {settings.runs_root!r}")

    env = {key: base_env[key] for key in _ALLOWED_COPY_KEYS if key in base_env}
    env["HOME"] = run_dir
    env["CLAUDE_CONFIG_DIR"] = os.path.join(run_dir, "claude-config")
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
    # None on a normal result; "result_missing" if the process ended
    # (whether cleanly or not) without ever emitting a terminal
    # `{"type": "result"}` line (fix round 1, minor 4).
    error_reason: str | None = None


def _decode(raw) -> str:
    if isinstance(raw, bytes):
        return raw.decode("utf-8", "replace")
    return raw


def granted_tools(transcript_path: str) -> list[str]:
    """Returns the `tools` list from the transcript's
    `{"type": "system", "subtype": "init"}` line -- the tool names Claude
    Code actually granted this run, independent of anything the model
    claims to have used or not used. Returns `[]` if the transcript has
    no such line (e.g. the process never got far enough to start).

    This is what actually proves containment -- a transcript with no
    `tool_use` for Bash/Write/Agent/etc. only proves the model didn't
    *use* them; this proves Claude Code never handed them out in the
    first place. app/service.py (Task 12) is expected to call this and
    refuse to trust a run whose granted tools include anything besides
    `mcp__librarian__*`."""
    with open(transcript_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and obj.get("type") == "system" and obj.get("subtype") == "init":
                return list(obj.get("tools") or [])
    return []


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
    (creating its directory if missing, OVERWRITING any existing content
    at that path -- a reused path from a prior run must never mix with
    this one), stderr to `transcript_path + ".stderr"`, and parse the
    terminal stream-json result line as it arrives. `transcript_path`
    (like `child_env`'s `run_dir`) must always be built from a
    service-generated run_id, never from arrival/model text.

    Kills the whole process group on every exit path, not just timeout
    (see module docstring, fix round 1 I2). See the module docstring for
    why reading happens on a background thread and why `on_tick` exists.
    """
    prompt_argv_bytes = max((len(a.encode("utf-8")) for a in argv), default=0)
    if prompt_argv_bytes > _MAX_PROMPT_BYTES:
        raise ValueError(f"an argv element is {prompt_argv_bytes} bytes, exceeds the {_MAX_PROMPT_BYTES}-byte limit")

    transcript_dir = os.path.dirname(os.path.abspath(transcript_path))
    os.makedirs(transcript_dir, exist_ok=True)
    stderr_path = transcript_path + ".stderr"

    result_holder: dict = {}
    reader_done = threading.Event()

    stderr_f = open(stderr_path, "w")
    proc = None
    reader = None
    timed_out = False
    exit_code = None

    try:
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
                try:
                    with open(transcript_path, "w", encoding="utf-8") as tf:
                        for raw in proc.stdout:
                            line = _decode(raw)
                            tf.write(line if line.endswith("\n") else line + "\n")
                            tf.flush()
                            stripped = line.strip()
                            if not stripped:
                                continue
                            try:
                                obj = json.loads(stripped)
                            except json.JSONDecodeError:
                                continue
                            if isinstance(obj, dict) and obj.get("type") == "result":
                                # Keep only the LAST result object -- never
                                # accumulate the full transcript in memory.
                                result_holder.clear()
                                result_holder.update(obj)
                except (OSError, ValueError):
                    # stdout was forcibly closed during timeout cleanup
                    # below -- expected, not an error.
                    pass
            finally:
                reader_done.set()

        reader = threading.Thread(target=_read, daemon=True)
        reader.start()

        start = time.monotonic()
        deadline = start + timeout
        next_tick = start + _TICK_INTERVAL
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
                    on_tick()  # may raise -- the finally below still cleans up
                next_tick = now + _TICK_INTERVAL

        if not timed_out:
            remaining = max(deadline - time.monotonic(), 0)
            try:
                exit_code = proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        if proc is not None:
            try:
                killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # group already gone -- expected on most clean exits
            except Exception:
                logger.exception("killpg failed for pid %s; falling back to proc.kill()", proc.pid)
                try:
                    proc.kill()
                except Exception:
                    logger.exception("proc.kill() also failed for pid %s", proc.pid)

            if reader is not None:
                reader.join(timeout=_READER_JOIN_TIMEOUT)
                if reader.is_alive():
                    try:
                        proc.stdout.close()
                    except Exception:
                        pass
                    reader.join(timeout=_READER_JOIN_TIMEOUT)

            if exit_code is None:
                try:
                    exit_code = proc.wait(timeout=_READER_JOIN_TIMEOUT)
                except Exception:
                    pass

        stderr_f.close()

    got_result = bool(result_holder)
    is_error = bool(result_holder.get("is_error", False))
    result_text = result_holder.get("result") or ""  # null/absent -> "" (minor 5)
    cost_usd = result_holder.get("total_cost_usd")
    usage = result_holder.get("usage") or {}  # null/absent -> {} (minor 5)
    num_turns = result_holder.get("num_turns")

    error_reason = None if got_result else "result_missing"
    ok = exit_code == 0 and not timed_out and not is_error and got_result

    return RunResult(
        ok=ok,
        exit_code=exit_code,
        timed_out=timed_out,
        result_text=result_text,
        cost_usd=cost_usd,
        usage=usage,
        num_turns=num_turns,
        transcript_path=transcript_path,
        error_reason=error_reason,
    )
