"""Settings for the read-along job, from the environment (see the librarian
HelmRelease's `readalong` controller)."""
from dataclasses import dataclass, field
from typing import Mapping

_REQUIRED = ("BOOKORBIT_URL", "BOOKORBIT_USER", "BOOKORBIT_PASS",
             "STORYTELLER_URL", "STORYTELLER_USER", "STORYTELLER_PASS", "APPRISE_URL")


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v == "":
        return default
    if v.strip().lower() in ("1", "true", "yes", "on"):
        return True
    if v.strip().lower() in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"not a boolean: {v!r}")


def _ints(v: str | None) -> tuple[int, ...]:
    return tuple(int(x) for x in (v or "").replace(" ", "").split(",") if x)


@dataclass(frozen=True)
class Settings:
    bookorbit_url: str
    bookorbit_user: str
    bookorbit_pass: str
    storyteller_url: str
    storyteller_user: str
    storyteller_pass: str
    apprise_url: str
    bookorbit_public_url: str = ""
    state_dir: str = "/state"
    media_books: str = "/media/books"          # this pod's view of BookOrbit's /books
    books_prefix: str = "/books"
    storyteller_library: str = "/library"      # Storyteller's view of /media/books
    staging_dir: str = "/media/library_intake/.readalong"
    libraries: tuple = (7, 8)
    start_hours: float = 3.5                   # no new book starts later than this into the run
    run_hours: float = 5.5                     # stop polling and exit (Storyteller keeps working)
    quiet_hours: float = 2.0                   # skip books updated more recently than this
    max_books: int = 3                         # new books started per night
    poll_seconds: int = 60
    dry_run: bool = False
    only: frozenset = field(default_factory=frozenset)

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        missing = [k for k in _REQUIRED if not env.get(k)]
        if missing:
            raise ValueError(f"missing required environment: {', '.join(missing)}")
        kw = {k.lower(): env[k] for k in _REQUIRED}
        opt = {"BOOKORBIT_PUBLIC_URL": "bookorbit_public_url", "STATE_DIR": "state_dir",
               "MEDIA_BOOKS": "media_books", "BOOKS_PREFIX": "books_prefix",
               "STORYTELLER_LIBRARY": "storyteller_library", "STAGING_DIR": "staging_dir"}
        for k, attr in opt.items():
            if env.get(k):
                kw[attr] = env[k]
        for k in ("START_HOURS", "RUN_HOURS"):
            if env.get(k):
                kw[k.lower()] = float(env[k])
        if env.get("LIBRARIES"):
            kw["libraries"] = _ints(env["LIBRARIES"])
        if env.get("QUIET_HOURS"):
            kw["quiet_hours"] = float(env["QUIET_HOURS"])
        if env.get("MAX_BOOKS"):
            kw["max_books"] = int(env["MAX_BOOKS"])
        if env.get("POLL_SECONDS"):
            kw["poll_seconds"] = int(env["POLL_SECONDS"])
        kw["dry_run"] = _bool(env.get("DRY_RUN"), False)
        kw["only"] = frozenset(_ints(env.get("ONLY")))
        s = Settings(**kw)
        if not 0 < s.start_hours <= s.run_hours:
            raise ValueError(f"need 0 < START_HOURS <= RUN_HOURS, got {s.start_hours}, {s.run_hours}")
        return s
