"""Runtime configuration, entirely from the environment.

DRY_RUN is hard-wired for this plan (see global constraints): the service
refuses to start with DRY_RUN=false. No code in this plan may move, write,
rename or delete anything under /media, or call a BookOrbit/Storyteller/
Vikunja/Apprise write. Live mode ships in a later plan.
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
    only: str | None = None
    # Every claude -p run's HOME/CLAUDE_CONFIG_DIR must live strictly under
    # this directory (app/runner.py's child_env enforces it) -- the fence
    # against a run_dir that somehow escapes to the host's real ~/.claude.
    runs_root: str = "/tmp/runs"

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        # DRY_RUN is checked first and raises before touching anything else --
        # a missing BOOKORBIT_URL should not mask a live-mode attempt, and
        # vice versa the live-mode guard must fire even if other env is fine.
        dry_run = _b(env, "DRY_RUN", True)
        if not dry_run:
            raise SystemExit("live mode ships in plan P2")

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
            only=only,
            runs_root=_s(env, "RUNS_ROOT", "/tmp/runs"),
        )
