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
