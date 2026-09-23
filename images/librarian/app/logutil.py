"""Log hygiene shared by every module that logs intake-derived text."""


def log_safe(text) -> str:
    """Escape control characters (C0, DEL, and every other non-printable
    code point) in attacker-influenced text before it is logged -- arrival
    keys (manual keys carry file names), title hints, sidecar-derived error
    text -- so it cannot forge log lines or emit terminal escapes."""
    return "".join(ch if ch.isprintable() else repr(ch)[1:-1] for ch in str(text))
