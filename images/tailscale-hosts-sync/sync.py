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
    DOMAIN_SUFFIX: Domain suffix for hostnames (default: auto-detect from API)
                   Set explicitly to override (e.g., "tailnet-name.ts.net")
    STRIP_SUFFIX: Strip numeric suffixes like -1, -2 (default: "true")
    USE_FQDN: Use full MagicDNS name from API instead of hostname (default: "true")
"""

import os
import re
import sys
from datetime import datetime, timezone

import requests


def strip_numeric_suffix(name: str) -> str:
    """
    Strip numeric suffixes like -1, -2 from names.

    Tailscale adds these when device names conflict (e.g., during pod upgrades).
    This allows consistent DNS resolution regardless of suffix.

    Examples:
        blocky-1 -> blocky
        nginx-proxy-2 -> nginx-proxy
        myserver -> myserver (unchanged)
    """
    return re.sub(r'-\d+$', '', name)


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


def extract_domain_suffix(devices: list[dict]) -> str:
    """
    Extract the tailnet domain suffix from device names.

    Device names from API are like "hostname.tailnet-name.ts.net"
    Returns "tailnet-name.ts.net" or "ts.net" as fallback.
    """
    for device in devices:
        name = device.get("name", "")
        if name and ".ts.net" in name:
            # name format: "hostname.tailnet-name.ts.net"
            parts = name.split(".", 1)
            if len(parts) > 1:
                return parts[1]  # "tailnet-name.ts.net"
    return "ts.net"  # fallback


def generate_hosts_content(
    devices: list[dict],
    domain_suffix: str,
    strip_suffix: bool,
    use_fqdn: bool,
) -> str:
    """Generate hosts file content from device list."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        f"# Tailscale hosts - Generated {timestamp}",
        "# Source: Tailscale API (OAuth)",
        f"# Domain suffix: {domain_suffix}",
        f"# Strip numeric suffixes: {strip_suffix}",
        f"# Use FQDN from API: {use_fqdn}",
        f"# Devices: {len(devices)}",
        "",
    ]

    # Track names to handle duplicates after stripping
    seen_entries: set[tuple[str, str]] = set()

    for device in devices:
        addresses = device.get("addresses", [])
        if not addresses:
            continue

        if use_fqdn:
            # Use the full MagicDNS name from API (e.g., "hostname.tailnet-name.ts.net")
            fqdn = device.get("name", "")
            if not fqdn:
                continue

            # Extract just the hostname part for suffix stripping
            if strip_suffix and "." in fqdn:
                hostname_part = fqdn.split(".", 1)[0]
                hostname_part = strip_numeric_suffix(hostname_part)
                # Reconstruct FQDN with stripped hostname
                fqdn = f"{hostname_part}.{domain_suffix}"
        else:
            # Legacy mode: use hostname field + domain_suffix
            hostname = device.get("hostname", "")
            if not hostname:
                continue
            if strip_suffix:
                hostname = strip_numeric_suffix(hostname)
            fqdn = f"{hostname}.{domain_suffix}"

        # Add entry for each IP address (IPv4 and IPv6)
        for addr in addresses:
            entry = (addr, fqdn)
            # Skip duplicates (can happen after stripping suffixes)
            if entry in seen_entries:
                continue
            seen_entries.add(entry)
            lines.append(f"{addr} {fqdn}")

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
    domain_suffix_env = os.environ.get("DOMAIN_SUFFIX", "")  # Empty = auto-detect
    strip_suffix = os.environ.get("STRIP_SUFFIX", "true").lower() in ("true", "1", "yes")
    use_fqdn = os.environ.get("USE_FQDN", "true").lower() in ("true", "1", "yes")

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

    # Step 3: Determine domain suffix
    if domain_suffix_env:
        domain_suffix = domain_suffix_env
        print(f"3. Using configured domain suffix: {domain_suffix}")
    else:
        domain_suffix = extract_domain_suffix(devices)
        print(f"3. Auto-detected domain suffix: {domain_suffix}")

    # Step 4: Generate hosts file
    print(f"4. Generating hosts file (use_fqdn={use_fqdn}, strip_suffix={strip_suffix})...")
    content = generate_hosts_content(devices, domain_suffix, strip_suffix, use_fqdn)

    # Step 5: Write to file
    print(f"5. Writing to {output_file}...")
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
