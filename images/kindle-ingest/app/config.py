"""Runtime configuration, entirely from the environment."""
import os
from dataclasses import dataclass, field


class ConfigError(Exception):
    pass


def _s(name: str, default: str | None = None) -> str:
    """Env string. A blank value is treated as absent, not as an empty string --
    `FOO=$UNSET` and compose env_files both produce blanks, and an empty URL or
    host accepted silently fails much later and much more confusingly."""
    v = os.environ.get(name, "")
    if v.strip():
        return v.strip()
    if default is None:
        raise ConfigError(f"{name} is required but unset or blank")
    return default


def _i(name: str, default: int) -> int:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        raise ConfigError(f"{name}={v!r} is not an integer") from None


def _b(name: str, default: str = "false") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Config:
    kindle_host: str
    kindle_port: int
    ssh_key_path: str
    socks_proxy: str
    bookorbit_url: str
    bookorbit_user: str
    bookorbit_pass: str = field(repr=False)
    library_id: int
    folder_id: int
    apprise_url: str
    poll_interval: int
    data_dir: str
    work_dir: str
    state_dir: str
    cleanup_enabled: bool
    max_deletes_per_cycle: int
    metrics_port: int
    # timeouts (seconds)
    ssh_connect_timeout: int
    rclone_timeout: int
    convert_timeout: int
    cycle_deadline: int
    ledger_path: str

    @staticmethod
    def from_env() -> "Config":
        data_dir = _s("DATA_DIR", "/data")
        state_dir = _s("STATE_DIR", "/state")
        poll = _i("POLL_INTERVAL", 600)
        # A cycle must not outlive its interval, or two cycles overlap and two
        # writers race on the ledger.
        deadline = _i("CYCLE_DEADLINE", max(60, poll - 60))
        if deadline >= poll:
            raise ConfigError(
                f"CYCLE_DEADLINE ({deadline}) must be less than POLL_INTERVAL ({poll})")
        return Config(
            kindle_host=_s("KINDLE_HOST", "100.64.0.12"),
            kindle_port=_i("KINDLE_PORT", 2222),
            ssh_key_path=_s("SSH_KEY_PATH", "/secrets/ssh/id_ed25519"),
            socks_proxy=_s("SOCKS_PROXY", "127.0.0.1:1055"),
            bookorbit_url=_s("BOOKORBIT_URL").rstrip("/"),
            bookorbit_user=_s("BOOKORBIT_USER"),
            bookorbit_pass=_s("BOOKORBIT_PASS"),
            library_id=_i("LIBRARY_ID", 1),
            folder_id=_i("FOLDER_ID", 1),
            apprise_url=_s("APPRISE_URL", ""),
            poll_interval=poll,
            data_dir=data_dir,
            # derived, so DATA_DIR alone moves everything onto the mounted volume
            work_dir=_s("WORK_DIR", os.path.join(data_dir, "work")),
            state_dir=state_dir,
            cleanup_enabled=_b("CLEANUP_ENABLED"),
            max_deletes_per_cycle=_i("MAX_DELETES_PER_CYCLE", 10),
            metrics_port=_i("METRICS_PORT", 9090),
            ssh_connect_timeout=_i("SSH_CONNECT_TIMEOUT", 15),
            rclone_timeout=_i("RCLONE_TIMEOUT", 300),
            convert_timeout=_i("CONVERT_TIMEOUT", 1800),
            cycle_deadline=deadline,
            ledger_path=_s("LEDGER_PATH", os.path.join(state_dir, "books.jsonl")),
        )
