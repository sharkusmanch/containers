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
def test_pagination_stops_when_a_server_overstates_total(cfg):
    # total(500) is a lie: the server has 2 books and then returns empty pages.
    # Trusting total alone would spin forever. The earlier version of this test
    # registered a single page whose total was already satisfied, so it passed
    # against the un-paginated implementation and proved nothing.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 500, "page": 0, "size": 2,
                                "items": [_list_item(1, "A"), _list_item(2, "B")]})
    responses.post(QUERY, json={"total": 500, "page": 1, "size": 2, "items": []})
    assert BookOrbit(cfg).find_by_asin("B0MISSING1") is None
    calls = len([c for c in responses.calls if c.request.url == QUERY])
    assert calls == 2, f"stopped on the empty page, not on total; made {calls}"


# --- readable titles, and an ASIN tag that survives them ---------------------
# Uploading <ASIN>.<ext> made BookOrbit title every book with its ASIN. Setting
# a real title breaks title-equality reconciliation, so the ASIN moves to a tag
# -- which the LIST response carries, so matching stays one request per page
# and survives BookOrbit rewriting the title during metadata enrichment.

def _tagged_item(book_id, title, tags):
    return {"id": book_id, "title": title, "tags": tags,
            "files": [{"id": book_id, "format": "cbz", "role": "primary",
                       "sizeBytes": 10}]}


@responses.activate
def test_set_metadata_sends_title_and_asin_tag(cfg):
    import json
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.patch(f"{BASE}/api/v1/books/42/metadata", json={"id": 42})
    BookOrbit(cfg).set_metadata(42, title="Real Title", asin="B06XRCBRX8")
    body = json.loads(responses.calls[-1].request.body)
    assert body["title"] == "Real Title"
    assert "asin:B06XRCBRX8" in body["tags"]


@responses.activate
def test_find_by_asin_matches_the_tag_despite_a_renamed_title(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 2, "items": [
        _tagged_item(5, "Some Other Book", []),
        _tagged_item(7, "Halo: Rise of Atriox #1", ["asin:B06XRCBRX8"]),
    ]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8")["id"] == 7


@responses.activate
def test_find_by_asin_still_matches_books_uploaded_before_tagging(cfg):
    # Backwards compatibility: earlier uploads are titled with the bare ASIN.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 1, "items": [
        _tagged_item(9, "B06XRCBRX8", []),
    ]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8")["id"] == 9


@responses.activate
def test_an_unrelated_tag_is_not_a_match(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(QUERY, json={"total": 1, "items": [
        _tagged_item(5, "Book", ["asin:B0OTHER1234", "comic"]),
    ]})
    assert BookOrbit(cfg).find_by_asin("B06XRCBRX8") is None
