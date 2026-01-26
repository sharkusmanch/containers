#!/usr/bin/env python3
"""
Tailscale Hosts Sync

Syncs Tailscale device hostnames to a hosts file for DNS servers like Blocky or Pi-hole.
Uses OAuth client credentials (never expire) instead of API keys.

Environment Variables:
    TAILSCALE_CLIENT_ID: OAuth client ID (required)
    TAILSCALE_CLIENT_SECRET: OAuth client secret (required)
    OUTPUT_FILE: Path to write hosts file (default: /output/hosts)
    TAILNET: Tailnet name (default: "-" for default tailnet)
    DOMAIN_SUFFIX: Domain suffix for hostnames (default: "ts.net")
    STRIP_SUFFIX: Strip numeric suffixes like -1, -2 (default: "true")
"""

import os
import re
import sys
from datetime import datetime, timezone

import requests


def strip_numeric_suffix(hostname: str) -> str:
    """
    Strip numeric suffixes like -1, -2 from hostnames.

    Tailscale adds these when device names conflict (e.g., during pod upgrades).
    This allows consistent DNS resolution regardless of suffix.

    Examples:
        blocky-1 -> blocky
        nginx-proxy-2 -> nginx-proxy
        myserver -> myserver (unchanged)
    """
    return re.sub(r'-\d+$', '', hostname)


def get_oauth_token(client_id: str, client_secret: str) -> str:
    """Get OAuth access token using client credentials grant."""
    response = requests.post(
        "https://api.tailscale.com/api/v2/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def get_devices(token: str, tailnet: str) -> list[dict]:
    """Fetch all devices from the tailnet."""
    response = requests.get(
        f"https://api.tailscale.com/api/v2/tailnet/{tailnet}/devices",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("devices", [])


def generate_hosts_content(devices: list[dict], domain_suffix: str, strip_suffix: bool) -> str:
    """Generate hosts file content from device list."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        f"# Tailscale hosts - Generated {timestamp}",
        "# Source: Tailscale API (OAuth)",
        f"# Strip numeric suffixes: {strip_suffix}",
        f"# Devices: {len(devices)}",
        "",
    ]

    # Track hostnames to handle duplicates after stripping
    seen_entries: set[tuple[str, str]] = set()

    for device in devices:
        hostname = device.get("hostname", "")
        addresses = device.get("addresses", [])

        if not hostname or not addresses:
            continue

        # Optionally strip numeric suffix (e.g., blocky-1 -> blocky)
        if strip_suffix:
            hostname = strip_numeric_suffix(hostname)

        # Add entry for each IP address (IPv4 and IPv6)
        for addr in addresses:
            entry = (addr, hostname)
            # Skip duplicates (can happen after stripping suffixes)
            if entry in seen_entries:
                continue
            seen_entries.add(entry)
            lines.append(f"{addr} {hostname}.{domain_suffix}")

    return "\n".join(lines) + "\n"


def main():
    # Required environment variables
    client_id = os.environ.get("TAILSCALE_CLIENT_ID")
    client_secret = os.environ.get("TAILSCALE_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("ERROR: TAILSCALE_CLIENT_ID and TAILSCALE_CLIENT_SECRET are required")
        sys.exit(1)

    # Optional environment variables
    output_file = os.environ.get("OUTPUT_FILE", "/output/hosts")
    tailnet = os.environ.get("TAILNET", "-")
    domain_suffix = os.environ.get("DOMAIN_SUFFIX", "ts.net")
    strip_suffix = os.environ.get("STRIP_SUFFIX", "true").lower() in ("true", "1", "yes")

    print("Tailscale Hosts Sync")
    print("=" * 40)

    # Step 1: Get OAuth token
    print("1. Authenticating with Tailscale API...")
    try:
        token = get_oauth_token(client_id, client_secret)
        print("   OK - Got access token")
    except requests.RequestException as e:
        print(f"   FAILED - {e}")
        sys.exit(1)

    # Step 2: Fetch devices
    print("2. Fetching devices from tailnet...")
    try:
        devices = get_devices(token, tailnet)
        print(f"   OK - Found {len(devices)} devices")
    except requests.RequestException as e:
        print(f"   FAILED - {e}")
        sys.exit(1)

    # Step 3: Generate hosts file
    print(f"3. Generating hosts file (strip_suffix={strip_suffix})...")
    content = generate_hosts_content(devices, domain_suffix, strip_suffix)

    # Step 4: Write to file
    print(f"4. Writing to {output_file}...")
    try:
        os.makedirs(os.path.dirname(output_file), exist_ok=True)
        with open(output_file, "w") as f:
            f.write(content)
        print("   OK - Hosts file written")
    except OSError as e:
        print(f"   FAILED - {e}")
        sys.exit(1)

    # Show summary
    print()
    print("Generated hosts:")
    print("-" * 40)
    print(content)
    print("=" * 40)
    print("Sync complete")


if __name__ == "__main__":
    main()
