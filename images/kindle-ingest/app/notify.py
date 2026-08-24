"""Apprise notifications.

Success is batched per cycle: a backfill would otherwise emit one push per book
(97 during the manual run). Failures notify once and only once -- re-notifying
every 10 minutes is how an alert channel gets muted, taking the real alerts with
it. "Once" is durable state on the ledger record, not process memory.
"""
import logging

import requests

log = logging.getLogger(__name__)

REMEDIATION = ("Delete every device path matching the ASIN (including any "
               "tmp_*.sdr and empty renamed-title stubs), then re-download. "
               "Opening the book or retrying the decrypt does not help.")


class Notifier:
    def __init__(self, url: str, session=None):
        self.url = url
        self.s = session or requests.Session()

    def _send(self, title: str, body: str) -> bool:
        if not self.url:
            log.info("notify (disabled): %s | %s", title, body)
            return False
        try:
            r = self.s.post(self.url, json={"title": title, "body": body,
                                            "type": "info"}, timeout=30)
            return r.status_code < 400
        except requests.RequestException as e:
            log.warning("notify failed: %s", e)
            return False

    def batch_success(self, titles: list[str]) -> bool:
        if not titles:
            return False                     # silence is the common case
        n = len(titles)
        shown = ", ".join(titles[:8]) + (f" (+{n - 8} more)" if n > 8 else "")
        return self._send(f"{n} book{'s' if n != 1 else ''} added", shown)

    def failure(self, asin: str, title: str, reason: str) -> bool:
        return self._send(f"Ingest failed: {title[:60]}",
                          f"ASIN {asin}\n{reason}\n\n{REMEDIATION}")

    def needs_decision(self, asin: str, title: str, reason: str) -> bool:
        return self._send(f"Needs a decision: {title[:60]}", f"ASIN {asin}\n{reason}")
