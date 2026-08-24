import os
import pytest
import responses
from app.bookorbit import (BookOrbit, AuthExpired, Duplicate, UploadRejected,
                           Transport, BookOrbitError)

BASE = "http://bookorbit.media.svc.cluster.local:3000"
LOGIN = f"{BASE}/api/v1/auth/login"
UPLOAD = f"{BASE}/api/v1/libraries/1/upload"
QUERY = f"{BASE}/api/v1/books/query"


def _epub(tmp_path):
    p = tmp_path / "b.epub"
    p.write_bytes(b"x" * 100)
    return str(p)


@responses.activate
def test_login_stores_token(cfg):
    responses.post(LOGIN, json={"accessToken": "T"}, status=200)
    assert BookOrbit(cfg).login() == "T"


@responses.activate
def test_login_5xx_is_transport_not_fatal(cfg):
    responses.post(LOGIN, status=502)
    with pytest.raises(Transport):
        BookOrbit(cfg).login()


@responses.activate
def test_409_is_duplicate_not_failure(cfg, tmp_path):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(UPLOAD, json={"message": "exists"}, status=409)
    with pytest.raises(Duplicate):
        BookOrbit(cfg).upload(_epub(tmp_path))


@responses.activate
def test_401_is_auth_expired_so_caller_can_relogin(cfg, tmp_path):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(UPLOAD, status=401)
    with pytest.raises(AuthExpired):
        BookOrbit(cfg).upload(_epub(tmp_path))


@responses.activate
def test_400_is_terminal(cfg, tmp_path):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(UPLOAD, status=400, body="bad epub")
    with pytest.raises(UploadRejected):
        BookOrbit(cfg).upload(_epub(tmp_path))


@responses.activate
def test_5xx_upload_is_retryable(cfg, tmp_path):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(UPLOAD, status=503)
    with pytest.raises(Transport):
        BookOrbit(cfg).upload(_epub(tmp_path))


@responses.activate
def test_query_uses_nested_pagination(cfg):
    """Flat page/size are silently replaced by zod defaults, capping every
    query at the first 50 books -- which silently breaks reconciliation."""
    import json
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"items": []})
    BookOrbit(cfg).query_books()
    body = json.loads(responses.calls[-1].request.body)
    assert body == {"pagination": {"page": 0, "size": 200}}


@responses.activate
def test_find_by_asin_matches_on_filename(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"items": [
        {"id": 5, "title": "Other", "files": [{"filename": "Thing_B0OTHER1234.epub"}]},
        {"id": 7, "title": "Retitled Edition", "files": [{"filename": "X_B06XRCBRX8.epub"}]},
    ]})
    b = BookOrbit(cfg).find_by_asin("B06XRCBRX8")
    assert b["id"] == 7            # matched despite a different title


@responses.activate
def test_find_by_asin_returns_none_when_absent(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"items": [{"id": 1, "files": [{"filename": "a_B0ZZZZZZZZZ.epub"}]}]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8") is None


@responses.activate
def test_verify_requires_matching_size(cfg, tmp_path):
    p = _epub(tmp_path)                     # 100 bytes
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(f"{BASE}/api/v1/books/7", json={"id": 7, "files": [{"id": 7, "sizeBytes": 99}]})
    assert BookOrbit(cfg).verify(7, p) is False


@responses.activate
def test_verify_true_on_match(cfg, tmp_path):
    p = _epub(tmp_path)
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(f"{BASE}/api/v1/books/7", json={"id": 7, "files": [{"id": 7, "sizeBytes": 100}]})
    assert BookOrbit(cfg).verify(7, p) is True


@responses.activate
def test_verify_false_when_book_has_no_files(cfg, tmp_path):
    p = _epub(tmp_path)
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(f"{BASE}/api/v1/books/7", json={"id": 7, "files": []})
    assert BookOrbit(cfg).verify(7, p) is False


@responses.activate
def test_upload_sends_multipart_with_basename(cfg, tmp_path):
    """Filenames with commas broke a curl-based implementation entirely;
    requests handles the encoding, so assert we pass the real basename."""
    p = tmp_path / "A Parade of Horribles, Book 8.epub"
    p.write_bytes(b"x" * 10)
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(UPLOAD, json={"bookId": 1}, status=201)
    assert BookOrbit(cfg).upload(str(p))["bookId"] == 1
    assert b"A Parade of Horribles, Book 8.epub" in responses.calls[-1].request.body


# --- reconciliation against the SHAPE the server actually returns ------------
# Verified against the live API: the list endpoint returns files as
# {id, format, role, sizeBytes} -- no filename -- and has no asin field at all.
# The old tests invented a filename key, so they passed while find_by_asin
# could never match anything in production.

def _list_item(book_id, title, size=10):
    """A list item exactly as /books/query returns one."""
    return {"id": book_id, "title": title,
            "files": [{"id": book_id, "format": "cbz", "role": "primary",
                       "sizeBytes": size}]}


@responses.activate
def test_find_by_asin_matches_our_own_upload_by_title(cfg):
    # We upload <ASIN>.<ext>, and BookOrbit derives the title from the
    # filename, so a book this pipeline uploaded is titled with the bare ASIN.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 2, "items": [
        _list_item(5, "A Clash of Kings"),
        _list_item(7, "B06XRCBRX8"),
    ]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8")["id"] == 7


@responses.activate
def test_find_by_asin_does_not_match_a_title_merely_containing_the_asin(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 1, "items": [
        _list_item(5, "Notes on B06XRCBRX8 and other codes"),
    ]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8") is None


@responses.activate
def test_find_by_asin_reads_past_the_first_page(cfg):
    # total(205) > size(200): the book we want sits on page 1. Scanning only
    # page 0 made every book past the 200th invisible to reconciliation.
    page0 = {"total": 205, "page": 0, "size": 200,
             "items": [_list_item(i, f"Book {i}") for i in range(200)]}
    page1 = {"total": 205, "page": 1, "size": 200,
             "items": [_list_item(900, "B06XRCBRX8")]}
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json=page0)
    responses.post(QUERY, json=page1)
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8")["id"] == 900


@responses.activate
def test_pagination_stops_and_does_not_loop_forever(cfg):
    # A server that keeps returning items must not spin the cycle indefinitely.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 1, "page": 0, "size": 200,
                                "items": [_list_item(1, "Only")]})
    assert BookOrbit(cfg).find_by_asin("B0MISSING1") is None
    assert len([c for c in responses.calls if c.request.url == QUERY]) == 1
