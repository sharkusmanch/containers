#!/usr/bin/env python3
"""NextDNS Rewrites Sync.

Reconciles Tailscale device FQDNs + static ConfigMap entries into NextDNS
profile rewrites via the NextDNS REST API.

Environment variables (required):
  NEXTDNS_API_KEY              NextDNS account API key
  NEXTDNS_PROFILE_IDS          Comma-separated profile IDs (reconciles to all)
  TAILSCALE_CLIENT_ID          Tailscale OAuth client id
  TAILSCALE_CLIENT_SECRET      Tailscale OAuth client secret

Optional:
  STATIC_REWRITES_PATH         Path to YAML file with static entries (default /etc/static/rewrites.yaml)
  DENYLIST_DIRS                Colon-separated dirs of per-profile denylist YAML (default /etc/denylist)
  TAILNET                      Tailscale tailnet (default "-")
  CIRCUIT_BREAKER_THRESHOLD    Deletion ratio that aborts the run (default 0.20)
  RATE_LIMIT_DELAY             Seconds between API writes (default 0.2)
  DRY_RUN                      If set, compute but do not apply
  EXCLUDE_DEVICE_TAGS          Comma-separated Tailscale tags whose devices get NO
                               rewrite (e.g. tag:k8s-funnel -- a Funnel node must
                               keep its public ts.net record)
"""

from __future__ import annotations

import logging
import os
import sys
import time
from dataclasses import dataclass

import requests
import yaml

log = logging.getLogger("nextdns-sync")


# ---------- Pure helpers (unit-tested) ----------


def compute_desired_rewrites(
    tailscale_devices: list[dict],
    static_rewrites: list[dict],
    excluded_tags: set[str] | None = None,
) -> list[dict]:
    """Merge Tailscale device FQDNs (one rewrite per address) and static entries.

    Devices carrying any tag in `excluded_tags` are skipped. That matters for
    Tailscale Funnel nodes: a funnel node's `<name>.<tailnet>.ts.net` has a
    PUBLIC record pointing at Tailscale's ingress, and rewriting it to the
    device's CGNAT address makes the funnel unreachable from every NextDNS
    client -- including off-LAN ones, since the profiles roam, which is exactly
    where a funnel is supposed to help.
    """
    excluded = excluded_tags or set()
    result: list[dict] = []
    for device in tailscale_devices:
        name = device.get("name") or ""
        addresses = device.get("addresses") or []
        if not name or not addresses:
            continue
        if excluded and excluded.intersection(device.get("tags") or []):
            log.info("skipping %s (excluded tag)", name)
            continue
        for addr in addresses:
            result.append({"name": name, "content": addr})
    for entry in static_rewrites:
        name = entry.get("name")
        content = entry.get("content")
        if name and content:
            result.append({"name": name, "content": content})
    return result


def diff_rewrites(
    current: list[dict],
    desired: list[dict],
) -> tuple[list[dict], list[str]]:
    """Diff current NextDNS state against desired. Returns (to_add, rewrite_ids_to_delete)."""
    current_keys = {(c["name"], c["content"]): c["id"] for c in current}
    desired_keys = {(d["name"], d["content"]) for d in desired}

    to_add = [
        {"name": name, "content": content}
        for (name, content) in desired_keys
        if (name, content) not in current_keys
    ]
    to_delete_ids = [
        rewrite_id
        for key, rewrite_id in current_keys.items()
        if key not in desired_keys
    ]
    return to_add, to_delete_ids


def circuit_breaker_ok(
    current: list[dict],
    to_delete_ids: list[str],
    threshold: float,
) -> bool:
    """Abort if proposed deletion ratio exceeds threshold. Empty state always allowed."""
    if not current:
        return True
    return (len(to_delete_ids) / len(current)) <= threshold


def diff_denylist(
    current: list[dict],
    desired: list[str],
) -> tuple[list[str], list[str]]:
    """Diff a profile's denylist. Returns (hostnames_to_add, hostnames_to_delete).

    NextDNS denylist entries are keyed by the hostname itself (the API's "id"),
    unlike rewrites which carry a generated id.
    """
    current_ids = {c["id"] for c in current}
    desired_ids = set(desired)
    return sorted(desired_ids - current_ids), sorted(current_ids - desired_ids)


def merge_denylists(sources: list[tuple[str, object]]) -> dict[str, list[str]]:
    """Merge parsed denylist documents into {profile_name: [hostname, ...]}.

    Each document is a mapping of NextDNS profile NAME to a list of hostnames.
    Keyed by name, not profile id, because a profile id doubles as that
    profile's DoH endpoint path (https://dns.nextdns.io/<id>) — anyone holding
    one can use the profile as a resolver — so ids must not be committed to a
    git repository. Names are not secret.

    Multiple sources are unioned per profile so that a second, private config
    can contribute entries without its hostnames appearing alongside the first.
    """
    merged: dict[str, set[str]] = {}
    for origin, data in sources:
        if data is None:
            continue
        if not isinstance(data, dict):
            raise ValueError(f"{origin}: expected a mapping of profile name -> [hostname]")
        for profile_name, hosts in data.items():
            if hosts is None:
                hosts = []
            if not isinstance(hosts, list):
                raise ValueError(f"{origin}: '{profile_name}' must be a list of hostnames")
            cleaned = {str(h).strip().lower() for h in hosts if str(h).strip()}
            merged.setdefault(str(profile_name), set()).update(cleaned)
    return {name: sorted(hosts) for name, hosts in merged.items()}


_SENSITIVE_HEADERS = {"x-api-key", "authorization"}


def safe_log_response(headers: dict, status: int, body: str) -> None:
    """Log an API error without exposing auth headers."""
    redacted = {
        k: "[REDACTED]" if k.lower() in _SENSITIVE_HEADERS else v
        for k, v in headers.items()
    }
    log.warning("API error status=%s headers=%s body=%s", status, redacted, body[:200])


# ---------- API client ----------


@dataclass
class NextDNSClient:
    api_key: str
    session: requests.Session
    rate_limit_delay: float = 0.5
    max_retries: int = 5
    base: str = "https://api.nextdns.io"

    @classmethod
    def new(cls, api_key: str, rate_limit_delay: float, max_retries: int = 5) -> "NextDNSClient":
        s = requests.Session()
        s.headers.update({"X-Api-Key": api_key, "Content-Type": "application/json"})
        return cls(
            api_key=api_key,
            session=s,
            rate_limit_delay=rate_limit_delay,
            max_retries=max_retries,
        )

    def _request_with_retry(self, method: str, url: str, **kwargs) -> requests.Response:
        """Issue a request; on HTTP 429, back off exponentially and retry."""
        attempt = 0
        while True:
            r = self.session.request(method, url, timeout=30, **kwargs)
            if r.status_code == 429 and attempt < self.max_retries:
                # Respect Retry-After if the server sets it; otherwise exponential backoff
                retry_after_hdr = r.headers.get("Retry-After")
                try:
                    wait = float(retry_after_hdr) if retry_after_hdr else 0.0
                except ValueError:
                    wait = 0.0
                if wait <= 0:
                    wait = min(60.0, 2 ** attempt)
                log.warning("429 rate-limited on %s %s; sleeping %.1fs (attempt %d)",
                            method, url, wait, attempt + 1)
                time.sleep(wait)
                attempt += 1
                continue
            return r

    def list_rewrites(self, profile_id: str) -> list[dict]:
        r = self._request_with_retry("GET", f"{self.base}/profiles/{profile_id}/rewrites")
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        return r.json().get("data", [])

    def post_rewrite(self, profile_id: str, name: str, content: str) -> str:
        r = self._request_with_retry(
            "POST",
            f"{self.base}/profiles/{profile_id}/rewrites",
            json={"name": name, "content": content},
        )
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        time.sleep(self.rate_limit_delay)
        return r.json().get("data", {}).get("id", "")

    def get_profile_name(self, profile_id: str) -> str:
        r = self._request_with_retry("GET", f"{self.base}/profiles/{profile_id}")
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        return r.json().get("data", {}).get("name", "")

    def list_denylist(self, profile_id: str) -> list[dict]:
        r = self._request_with_retry("GET", f"{self.base}/profiles/{profile_id}/denylist")
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        return r.json().get("data", [])

    def post_denylist(self, profile_id: str, hostname: str) -> None:
        r = self._request_with_retry(
            "POST",
            f"{self.base}/profiles/{profile_id}/denylist",
            json={"id": hostname, "active": True},
        )
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        time.sleep(self.rate_limit_delay)

    def delete_denylist(self, profile_id: str, hostname: str) -> None:
        r = self._request_with_retry(
            "DELETE",
            f"{self.base}/profiles/{profile_id}/denylist/{hostname}",
        )
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        time.sleep(self.rate_limit_delay)

    def delete_rewrite(self, profile_id: str, rewrite_id: str) -> None:
        r = self._request_with_retry(
            "DELETE",
            f"{self.base}/profiles/{profile_id}/rewrites/{rewrite_id}",
        )
        if not r.ok:
            safe_log_response(dict(r.request.headers), r.status_code, r.text)
            r.raise_for_status()
        time.sleep(self.rate_limit_delay)


def apply_staged(
    client: NextDNSClient,
    profile_id: str,
    to_add: list[dict],
    to_delete_ids: list[str],
) -> None:
    """POST new entries before DELETE stale ones (avoids gaps on partial failure)."""
    for entry in to_add:
        client.post_rewrite(profile_id, entry["name"], entry["content"])
    for rewrite_id in to_delete_ids:
        client.delete_rewrite(profile_id, rewrite_id)


# ---------- Tailscale helpers ----------


def tailscale_token(client_id: str, client_secret: str) -> str:
    r = requests.post(
        "https://api.tailscale.com/api/v2/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def tailscale_devices(token: str, tailnet: str) -> list[dict]:
    r = requests.get(
        f"https://api.tailscale.com/api/v2/tailnet/{tailnet}/devices",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("devices", [])


def load_denylists(dirs: str) -> dict[str, list[str]]:
    """Load and merge every *.yaml in each colon-separated directory in `dirs`.

    Colon-separated rather than one directory because each source is a separate
    ConfigMap mount, and two ConfigMaps cannot share a mount path. A missing
    directory is not an error: the private source is mounted optional, so its
    absence must be indistinguishable from it being empty.
    """
    sources: list[tuple[str, object]] = []
    for dir_path in [d for d in dirs.split(":") if d]:
        if not os.path.isdir(dir_path):
            log.info("no denylist directory at %s, skipping", dir_path)
            continue
        for fname in sorted(os.listdir(dir_path)):
            # ConfigMap volumes also expose ..data / ..2026_.. symlink dirs.
            if not fname.endswith((".yaml", ".yml")):
                continue
            full = os.path.join(dir_path, fname)
            with open(full) as f:
                sources.append((full, yaml.safe_load(f)))
    return merge_denylists(sources)


def load_static_rewrites(path: str) -> list[dict]:
    if not os.path.exists(path):
        log.info("no static rewrites file at %s, skipping", path)
        return []
    with open(path) as f:
        data = yaml.safe_load(f) or []
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a YAML list")
    return data


# ---------- Entry point ----------


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    api_key = os.environ["NEXTDNS_API_KEY"]
    profile_ids = [
        p.strip() for p in os.environ["NEXTDNS_PROFILE_IDS"].split(",") if p.strip()
    ]
    ts_id = os.environ["TAILSCALE_CLIENT_ID"]
    ts_secret = os.environ["TAILSCALE_CLIENT_SECRET"]
    static_path = os.environ.get("STATIC_REWRITES_PATH", "/etc/static/rewrites.yaml")
    denylist_dirs = os.environ.get("DENYLIST_DIRS", "/etc/denylist")
    tailnet = os.environ.get("TAILNET", "-")
    threshold = float(os.environ.get("CIRCUIT_BREAKER_THRESHOLD", "0.20"))
    rate_delay = float(os.environ.get("RATE_LIMIT_DELAY", "0.5"))
    max_retries = int(os.environ.get("API_MAX_RETRIES", "5"))
    dry_run = bool(os.environ.get("DRY_RUN"))
    # Devices with any of these tags get NO rewrite. Funnel nodes must keep
    # their public ts.net record (see compute_desired_rewrites).
    excluded_tags = {
        t.strip() for t in os.environ.get("EXCLUDE_DEVICE_TAGS", "").split(",") if t.strip()
    }

    if not profile_ids:
        log.error("NEXTDNS_PROFILE_IDS is empty")
        return 1

    log.info("fetching Tailscale devices")
    token = tailscale_token(ts_id, ts_secret)
    devices = tailscale_devices(token, tailnet)
    log.info("got %d devices", len(devices))

    static = load_static_rewrites(static_path)
    log.info("loaded %d static rewrites", len(static))

    denylists = load_denylists(denylist_dirs)
    if denylists:
        log.info("loaded denylists for %d profile(s): %s",
                 len(denylists), ", ".join(sorted(denylists)))
    else:
        log.info("no denylist config found; denylists will not be touched")

    if excluded_tags:
        log.info("excluding devices tagged: %s", ",".join(sorted(excluded_tags)))
    desired = compute_desired_rewrites(devices, static, excluded_tags=excluded_tags)
    log.info("desired %d rewrites", len(desired))

    client = NextDNSClient.new(api_key, rate_delay, max_retries=max_retries)
    failures: list[str] = []

    for profile_id in profile_ids:
        log.info("--- reconciling profile %s ---", profile_id)
        try:
            current = client.list_rewrites(profile_id)
            log.info("current %d rewrites", len(current))

            to_add, to_delete_ids = diff_rewrites(current, desired)
            log.info("plan: +%d -%d", len(to_add), len(to_delete_ids))

            if not circuit_breaker_ok(current, to_delete_ids, threshold):
                log.error(
                    "circuit breaker tripped for %s: would delete %d of %d (>%.0f%%)",
                    profile_id,
                    len(to_delete_ids),
                    len(current),
                    threshold * 100,
                )
                failures.append(profile_id)
                continue

            if dry_run:
                log.info("DRY_RUN set, skipping apply for %s", profile_id)
                continue

            apply_staged(client, profile_id, to_add, to_delete_ids)
            log.info("reconcile complete for %s", profile_id)

            # --- denylist ---
            # Only profiles NAMED in the config are managed. A profile with no
            # entry is skipped entirely rather than reconciled to empty: these
            # denylists are also edited by hand in the NextDNS UI, and treating
            # "absent from config" as "delete everything" would silently wipe
            # that on first run.
            if denylists:
                name = client.get_profile_name(profile_id)
                if name not in denylists:
                    log.info("profile %s (%s) has no denylist config, leaving it alone",
                             profile_id, name or "?")
                else:
                    want = denylists[name]
                    have = client.list_denylist(profile_id)
                    dl_add, dl_del = diff_denylist(have, want)
                    log.info("denylist %s (%s): current %d, plan +%d -%d",
                             profile_id, name, len(have), len(dl_add), len(dl_del))
                    if not circuit_breaker_ok(have, dl_del, threshold):
                        log.error(
                            "denylist circuit breaker tripped for %s (%s): would delete %d of %d (>%.0f%%)",
                            profile_id, name, len(dl_del), len(have), threshold * 100,
                        )
                        failures.append(profile_id)
                    elif dry_run:
                        log.info("DRY_RUN set, skipping denylist apply for %s", profile_id)
                    else:
                        for host in dl_add:
                            client.post_denylist(profile_id, host)
                        for host in dl_del:
                            client.delete_denylist(profile_id, host)
                        log.info("denylist reconcile complete for %s (%s)", profile_id, name)
        except Exception as e:  # noqa: BLE001 - surface all per-profile failures
            log.exception("profile %s failed: %s", profile_id, e)
            failures.append(profile_id)

    if failures:
        log.error("reconcile failed for profiles: %s", ",".join(failures))
        return 2
    log.info("all profiles reconciled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
