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
