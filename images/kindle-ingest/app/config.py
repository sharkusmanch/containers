"""Runtime configuration, entirely from the environment."""
import os
from dataclasses import dataclass


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
    bookorbit_pass: str
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

    @staticmethod
    def from_env() -> "Config":
        return Config(
            kindle_host=os.environ.get("KINDLE_HOST", "100.64.0.12"),
            kindle_port=int(os.environ.get("KINDLE_PORT", "2222")),
            ssh_key_path=os.environ.get("SSH_KEY_PATH", "/secrets/ssh/id_ed25519"),
            socks_proxy=os.environ.get("SOCKS_PROXY", "127.0.0.1:1055"),
            bookorbit_url=os.environ["BOOKORBIT_URL"].rstrip("/"),
            bookorbit_user=os.environ["BOOKORBIT_USER"],
            bookorbit_pass=os.environ["BOOKORBIT_PASS"],
            library_id=int(os.environ.get("LIBRARY_ID", "1")),
            folder_id=int(os.environ.get("FOLDER_ID", "1")),
            apprise_url=os.environ.get("APPRISE_URL", ""),
            poll_interval=int(os.environ.get("POLL_INTERVAL", "600")),
            data_dir=os.environ.get("DATA_DIR", "/data"),
            work_dir=os.environ.get("WORK_DIR", "/data/work"),
            state_dir=os.environ.get("STATE_DIR", "/state"),
            cleanup_enabled=_b("CLEANUP_ENABLED"),
            max_deletes_per_cycle=int(os.environ.get("MAX_DELETES_PER_CYCLE", "10")),
            metrics_port=int(os.environ.get("METRICS_PORT", "9090")),
            ssh_connect_timeout=int(os.environ.get("SSH_CONNECT_TIMEOUT", "15")),
            rclone_timeout=int(os.environ.get("RCLONE_TIMEOUT", "300")),
            convert_timeout=int(os.environ.get("CONVERT_TIMEOUT", "1800")),
            cycle_deadline=int(os.environ.get("CYCLE_DEADLINE", "3600")),
        )
