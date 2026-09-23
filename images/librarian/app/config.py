"""Runtime configuration, entirely from the environment.

DRY_RUN is a real switch since Plan 2 Task 4 but still defaults to true;
rollback is setting it back to true. With DRY_RUN=false only arrivals whose
source is in LIVE_SOURCES (default `manual,libation`) execute for real --
every other arrival is finalized exactly as in dry-run. The executor
(app/executor.py) is the only code that writes; app/main.py constructs it,
and its writable BookOrbit client, only when DRY_RUN=false.
"""
from collections.abc import Mapping
from dataclasses import dataclass, field


def _get(env: Mapping[str, str], name: str) -> str:
    v = env.get(name, "")
    return v.strip() if isinstance(v, str) else ""


def _s(env: Mapping[str, str], name: str, default: str | None = None) -> str:
    """Env string. A blank value is treated as absent, not as an empty string
    -- an unset var and an explicitly-blank one both produce "", and an empty
    URL or host accepted silently fails much later and much more confusingly.
    """
    v = _get(env, name)
    if v:
        return v
    if default is None:
        raise ValueError(f"{name} is required but unset or blank")
    return default


def _i(env: Mapping[str, str], name: str, default: int) -> int:
    v = _get(env, name)
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        raise ValueError(f"{name}={v!r} is not an integer") from None


def _b(env: Mapping[str, str], name: str, default: bool) -> bool:
    v = _get(env, name).lower()
    if not v:
        return default
    if v in ("1", "true", "yes"):
        return True
    if v in ("0", "false", "no"):
        return False
    raise ValueError(f"{name}={v!r} is not a boolean (expected true/false/1/0)")


SOURCES = frozenset({"manual", "libation", "kindle"})
DEFAULT_LIVE_SOURCES = frozenset({"manual", "libation"})


def _sources(env: Mapping[str, str], name: str, default: frozenset) -> frozenset:
    """Comma list of arrival sources; blank = default, `none` = no source."""
    v = _get(env, name)
    if not v:
        return default
    if v.lower() == "none":
        return frozenset()
    out = frozenset(p.strip().lower() for p in v.split(",") if p.strip())
    if not out:
        raise ValueError(f"{name}={v!r} names no source (use 'none' to make no source live)")
    unknown = out - SOURCES
    if unknown:
        raise ValueError(f"{name}: unknown source(s) {sorted(unknown)}; expected any of {sorted(SOURCES)}")
    return out


@dataclass(frozen=True, kw_only=True)
class Settings:
    # required -- no sane default exists for the BookOrbit credentials.
    bookorbit_url: str
    bookorbit_user: str
    bookorbit_pass: str = field(repr=False)   # never in a repr/log line

    intake_root: str = "/media/library_intake"
    local_books_root: str = "/media/books"
    bookorbit_path_prefix: str = "/books"
    state_dir: str = "/state"
    lists_dir: str = "/etc/librarian/lists"
    prompts_dir: str = "/etc/librarian/prompts"
    poll_interval: int = 120
    quiet_period: int = 600
    debounce: int = 300
    max_arrivals_per_run: int = 20
    run_timeout: int = 2700
    model: str = "opus"
    reviewer_model: str = "opus"
    metrics_port: int = 9090
    api_port: int = 8081
    claude_bin: str = "claude"
    retry_after: int = 3600
    dry_run: bool = True
    # Plan 2 Task 4: sources that execute live when dry_run is False
    live_sources: frozenset = DEFAULT_LIVE_SOURCES
    max_attempts: int = 5          # service-level executions before failed + escalation
    max_exec_per_tick: int = 5     # MAX_EXEC_PER_TICK (Global "Liveness")
    only: str | None = None
    # Every claude -p run's HOME/CLAUDE_CONFIG_DIR must live strictly under
    # this directory (app/runner.py's child_env enforces it) -- the fence
    # against a run_dir that somehow escapes to the host's real ~/.claude.
    runs_root: str = "/tmp/runs"

    def __post_init__(self):
        for name in ("max_attempts", "max_exec_per_tick"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be >= 1, got {getattr(self, name)}")

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        dry_run = _b(env, "DRY_RUN", True)
        only = _get(env, "ONLY") or None

        return Settings(
            bookorbit_url=_s(env, "BOOKORBIT_URL"),
            bookorbit_user=_s(env, "BOOKORBIT_USER"),
            bookorbit_pass=_s(env, "BOOKORBIT_PASS"),
            intake_root=_s(env, "INTAKE_ROOT", "/media/library_intake"),
            local_books_root=_s(env, "LOCAL_BOOKS_ROOT", "/media/books"),
            bookorbit_path_prefix=_s(env, "BOOKORBIT_PATH_PREFIX", "/books"),
            state_dir=_s(env, "STATE_DIR", "/state"),
            lists_dir=_s(env, "LISTS_DIR", "/etc/librarian/lists"),
            prompts_dir=_s(env, "PROMPTS_DIR", "/etc/librarian/prompts"),
            poll_interval=_i(env, "POLL_INTERVAL", 120),
            quiet_period=_i(env, "QUIET_PERIOD", 600),
            debounce=_i(env, "DEBOUNCE", 300),
            max_arrivals_per_run=_i(env, "MAX_ARRIVALS_PER_RUN", 20),
            run_timeout=_i(env, "RUN_TIMEOUT", 2700),
            model=_s(env, "MODEL", "opus"),
            reviewer_model=_s(env, "REVIEWER_MODEL", "opus"),
            metrics_port=_i(env, "METRICS_PORT", 9090),
            api_port=_i(env, "API_PORT", 8081),
            claude_bin=_s(env, "CLAUDE_BIN", "claude"),
            retry_after=_i(env, "RETRY_AFTER", 3600),
            dry_run=dry_run,
            live_sources=_sources(env, "LIVE_SOURCES", DEFAULT_LIVE_SOURCES),
            max_attempts=_i(env, "MAX_ATTEMPTS", 5),
            max_exec_per_tick=_i(env, "MAX_EXEC_PER_TICK", 5),
            only=only,
            runs_root=_s(env, "RUNS_ROOT", "/tmp/runs"),
        )
