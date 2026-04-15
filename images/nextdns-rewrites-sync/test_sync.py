"""Tests for NextDNS rewrites reconciler."""
import logging
from unittest.mock import MagicMock

import pytest

from sync import (
    NextDNSClient,
    apply_staged,
    circuit_breaker_ok,
    compute_desired_rewrites,
    diff_rewrites,
    safe_log_response,
)


def test_compute_desired_merges_tailscale_and_static():
    tailscale_devices = [
        {"name": "nas.tailnet.ts.net", "addresses": ["100.64.0.5"]},
        {"name": "prom.tailnet.ts.net", "addresses": ["100.64.0.7", "fd7a::7"]},
    ]
    static = [
        {"name": "bedrockconnect.example.com", "content": "192.168.11.210"},
    ]
    result = compute_desired_rewrites(tailscale_devices, static)
    assert {"name": "nas.tailnet.ts.net", "content": "100.64.0.5"} in result
    assert {"name": "prom.tailnet.ts.net", "content": "100.64.0.7"} in result
    assert {"name": "prom.tailnet.ts.net", "content": "fd7a::7"} in result
    assert {"name": "bedrockconnect.example.com", "content": "192.168.11.210"} in result


def test_compute_desired_skips_devices_without_name_or_addresses():
    devices = [
        {"name": "", "addresses": ["100.64.0.1"]},
        {"name": "foo.tailnet.ts.net", "addresses": []},
        {"name": "bar.tailnet.ts.net", "addresses": ["100.64.0.2"]},
    ]
    result = compute_desired_rewrites(devices, [])
    assert len(result) == 1
    assert result[0]["name"] == "bar.tailnet.ts.net"


def test_compute_desired_tolerates_missing_static_fields():
    static = [
        {"name": "good.example.com", "content": "10.0.0.1"},
        {"name": "no-content.example.com"},  # missing content
        {"content": "10.0.0.2"},  # missing name
    ]
    result = compute_desired_rewrites([], static)
    assert result == [{"name": "good.example.com", "content": "10.0.0.1"}]


def test_diff_computes_additions_and_deletions():
    current = [
        {"id": "a1", "name": "keep.example.com", "content": "10.0.0.1"},
        {"id": "a2", "name": "stale.example.com", "content": "10.0.0.2"},
        {"id": "a3", "name": "change.example.com", "content": "10.0.0.3"},
    ]
    desired = [
        {"name": "keep.example.com", "content": "10.0.0.1"},
        {"name": "new.example.com", "content": "10.0.0.4"},
        {"name": "change.example.com", "content": "10.0.0.99"},
    ]
    to_add, to_delete_ids = diff_rewrites(current, desired)

    assert {"name": "new.example.com", "content": "10.0.0.4"} in to_add
    assert {"name": "change.example.com", "content": "10.0.0.99"} in to_add
    assert "a2" in to_delete_ids
    assert "a3" in to_delete_ids
    assert "a1" not in to_delete_ids


def test_diff_no_changes_when_identical():
    current = [{"id": "a1", "name": "x.ex.com", "content": "1.1.1.1"}]
    desired = [{"name": "x.ex.com", "content": "1.1.1.1"}]
    to_add, to_delete_ids = diff_rewrites(current, desired)
    assert to_add == []
    assert to_delete_ids == []


def test_circuit_breaker_allows_small_deletions():
    current = [{"id": f"x{i}", "name": f"h{i}", "content": "1.1.1.1"} for i in range(100)]
    to_delete_ids = [f"x{i}" for i in range(15)]  # 15%
    assert circuit_breaker_ok(current, to_delete_ids, threshold=0.20) is True


def test_circuit_breaker_blocks_mass_deletion():
    current = [{"id": f"x{i}", "name": f"h{i}", "content": "1.1.1.1"} for i in range(100)]
    to_delete_ids = [f"x{i}" for i in range(25)]  # 25%
    assert circuit_breaker_ok(current, to_delete_ids, threshold=0.20) is False


def test_circuit_breaker_allows_when_current_is_empty():
    """First run has no current state; don't block initial population."""
    assert circuit_breaker_ok([], [], threshold=0.20) is True


def test_circuit_breaker_at_exact_threshold():
    """Boundary: exactly threshold ratio is allowed."""
    current = [{"id": f"x{i}", "name": f"h{i}", "content": "1.1.1.1"} for i in range(10)]
    to_delete_ids = [f"x{i}" for i in range(2)]  # exactly 20%
    assert circuit_breaker_ok(current, to_delete_ids, threshold=0.20) is True


def test_apply_staged_posts_new_before_delete():
    """POST additions first, then DELETE stale — guards against partial-failure data loss."""
    client = MagicMock(spec=NextDNSClient)
    to_add = [{"name": "a.ex.com", "content": "1.1.1.1"}]
    to_delete_ids = ["stale1"]

    apply_staged(client, "profile-id", to_add, to_delete_ids)

    call_order = [c[0] for c in client.method_calls]
    post_idx = call_order.index("post_rewrite")
    delete_idx = call_order.index("delete_rewrite")
    assert post_idx < delete_idx

    client.post_rewrite.assert_called_once_with("profile-id", "a.ex.com", "1.1.1.1")
    client.delete_rewrite.assert_called_once_with("profile-id", "stale1")


def test_apply_staged_handles_empty_sets():
    client = MagicMock(spec=NextDNSClient)
    apply_staged(client, "p", [], [])
    client.post_rewrite.assert_not_called()
    client.delete_rewrite.assert_not_called()


def test_safe_log_response_redacts_auth_headers(caplog):
    caplog.set_level(logging.DEBUG, logger="nextdns-sync")
    safe_log_response({"X-Api-Key": "secret123", "Content-Type": "application/json"},
                      401, "unauthorized")
    assert "secret123" not in caplog.text
    assert "[REDACTED]" in caplog.text
    assert "application/json" in caplog.text  # non-sensitive headers pass through


def test_safe_log_response_redacts_authorization_header(caplog):
    caplog.set_level(logging.DEBUG, logger="nextdns-sync")
    safe_log_response({"Authorization": "Bearer xyz"}, 403, "forbidden")
    assert "xyz" not in caplog.text


def test_request_with_retry_backs_off_on_429(monkeypatch):
    """On HTTP 429, the client retries with exponential backoff up to max_retries."""
    from unittest.mock import MagicMock

    import requests as _requests

    client = NextDNSClient.new("fake-key", rate_limit_delay=0.0, max_retries=3)

    # First two calls return 429, third returns 200
    r429 = MagicMock()
    r429.status_code = 429
    r429.headers = {}

    r_ok = MagicMock()
    r_ok.status_code = 200
    r_ok.ok = True
    r_ok.headers = {}

    call_count = {"n": 0}

    def fake_request(*args, **kwargs):
        call_count["n"] += 1
        return r429 if call_count["n"] < 3 else r_ok

    monkeypatch.setattr(client.session, "request", fake_request)
    monkeypatch.setattr("sync.time.sleep", lambda _s: None)  # skip real sleeps

    resp = client._request_with_retry("GET", "https://api.nextdns.io/x")
    assert call_count["n"] == 3
    assert resp.status_code == 200


def test_request_with_retry_honors_retry_after_header(monkeypatch):
    """If the server sets Retry-After, the client should sleep for that duration."""
    from unittest.mock import MagicMock

    client = NextDNSClient.new("fake-key", rate_limit_delay=0.0, max_retries=2)

    sleeps: list[float] = []
    monkeypatch.setattr("sync.time.sleep", lambda s: sleeps.append(s))

    r429 = MagicMock()
    r429.status_code = 429
    r429.headers = {"Retry-After": "3"}

    r_ok = MagicMock()
    r_ok.status_code = 200
    r_ok.ok = True
    r_ok.headers = {}

    responses = [r429, r_ok]
    monkeypatch.setattr(client.session, "request", lambda *a, **k: responses.pop(0))

    client._request_with_retry("GET", "https://api.nextdns.io/x")
    assert 3.0 in sleeps


def test_request_with_retry_gives_up_after_max(monkeypatch):
    """After max_retries, client returns the final 429 response rather than looping forever."""
    from unittest.mock import MagicMock

    client = NextDNSClient.new("fake-key", rate_limit_delay=0.0, max_retries=2)

    r429 = MagicMock()
    r429.status_code = 429
    r429.ok = False
    r429.headers = {}

    monkeypatch.setattr(client.session, "request", lambda *a, **k: r429)
    monkeypatch.setattr("sync.time.sleep", lambda _s: None)

    resp = client._request_with_retry("GET", "https://api.nextdns.io/x")
    assert resp.status_code == 429
