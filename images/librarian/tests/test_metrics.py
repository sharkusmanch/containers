"""app/metrics.py: /healthz must answer while another scrape is hung."""
import socket
import urllib.request

from app import metrics


def test_hung_scrape_does_not_block_healthz():
    srv = metrics.serve(0)
    port = srv.server_address[1]
    hung = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        hung.sendall(b"GET /metrics HTTP/1.1\r\n")          # headers never finished
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3) as r:
            assert r.status == 200
    finally:
        hung.close()
        srv.shutdown()
        srv.server_close()


# --- final review I4: alerting metrics -------------------------------------------------------

from prometheus_client import REGISTRY  # noqa: E402

from app import states  # noqa: E402
from tests.test_live import (  # noqa: E402,F401 (live_factory is a fixture)
    Clock, FakeExecutor, FakeModel, add_libation, approve_all, attach_script, drive, failed,
    live_factory,
)


def sample(name, **labels):
    return REGISTRY.get_sample_value(name, labels)


def test_outcome_counters_exist_at_zero_for_every_source():
    for source in ("manual", "libation", "kindle"):
        assert sample("librarian_filed_total", source=source) is not None
        assert sample("librarian_exec_failed_total", source=source) is not None


def test_filed_and_failed_counters_by_source(tmp_path, live_factory):
    before_f = sample("librarian_filed_total", source="libation")
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), FakeExecutor(), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    assert sample("librarian_filed_total", source="libation") == before_f + 1


def test_exec_failed_counter(tmp_path, live_factory):
    before = sample("librarian_exec_failed_total", source="libation")
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor([failed()]), clock)
    add_libation(tmp_path)
    drive(svc, clock)
    assert sample("librarian_exec_failed_total", source="libation") == before + 1


def test_escalation_gauges_count_live_needs_decision_and_oldest_age(tmp_path, live_factory):
    svc = live_factory(FakeModel(), FakeExecutor(), live_sources=frozenset({"manual"}))
    for key, source in (("manual:a:1", "manual"), ("manual:b:1", "manual"), ("kindle:c:1", "kindle")):
        svc.arrivals.record(key, states.NEEDS_DECISION, source=source)
        svc.intents.record_escalation("r1", key, "q?", reason="x")
    old = svc.intents.latest_escalation("manual:a:1")["ts"]
    metrics.rebuild_escalations(svc.arrivals, svc.intents,
                                lambda rec: rec.get("source") == "manual", now=old + 1000)
    assert sample("librarian_escalations_open") == 2          # the kindle one is not asked
    assert 999 <= sample("librarian_escalation_oldest_age_seconds") <= 1000

    svc.arrivals.record("manual:a:1", states.FILED)
    svc.arrivals.record("manual:b:1", states.FILED)
    metrics.rebuild_escalations(svc.arrivals, svc.intents, lambda rec: True, now=old + 2000)
    assert sample("librarian_escalations_open") == 1
    svc.arrivals.record("kindle:c:1", states.FILED)
    metrics.rebuild_escalations(svc.arrivals, svc.intents, lambda rec: True, now=old + 2000)
    assert sample("librarian_escalations_open") == 0
    assert sample("librarian_escalation_oldest_age_seconds") == 0


def test_tick_rebuilds_escalation_gauges(tmp_path, live_factory):
    svc = live_factory(FakeModel(), FakeExecutor())
    svc.arrivals.record("manual:a:1", states.NEEDS_DECISION, source="manual")
    svc.intents.record_escalation("r1", "manual:a:1", "q?", reason="x")
    svc.tick()
    assert sample("librarian_escalations_open") == 1
