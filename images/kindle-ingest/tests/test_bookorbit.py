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
    responses.patch(f"{BASE}/api/v1/books/42/metadata-and-locks", json={"id": 42})
    BookOrbit(cfg).set_metadata(42, title="Real Title", asin="B06XRCBRX8")
    body = json.loads(responses.calls[-1].request.body)
    assert body["metadata"]["title"] == "Real Title"
    assert "asin:B06XRCBRX8" in body["metadata"]["tags"]


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


# --- enrichment needs a nudge after upload ----------------------------------
# Provider lookup keys off the title, so books uploaded as <ASIN>.<ext> matched
# nothing. With a real title set, a refresh populates author/series/description,
# but the cover still has to be extracted from the file explicitly.

@responses.activate
def test_enrich_refreshes_metadata_and_extracts_the_cover(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(f"{BASE}/api/v1/books/42/refresh-metadata", json={"id": 42})
    responses.post(f"{BASE}/api/v1/books/42/re-extract-cover",
                   json={"processed": 1, "updated": 1})
    BookOrbit(cfg).enrich(42)
    hit = [c.request.url for c in responses.calls]
    assert any(u.endswith("/refresh-metadata") for u in hit)
    assert any(u.endswith("/re-extract-cover") for u in hit)


@responses.activate
def test_enrich_still_extracts_the_cover_when_the_refresh_fails(cfg):
    # A provider being down must not also cost us the cover, which comes from
    # the file we just uploaded and needs no external service.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.post(f"{BASE}/api/v1/books/42/refresh-metadata", status=502, json={})
    responses.post(f"{BASE}/api/v1/books/42/re-extract-cover",
                   json={"processed": 1, "updated": 1})
    BookOrbit(cfg).enrich(42)
    assert any(c.request.url.endswith("/re-extract-cover") for c in responses.calls)


# --- the server owns the upload limit ---------------------------------------
# max_upload_size_mb is an app setting in Postgres, editable in the UI, so a
# value compiled into this pipeline drifts the moment it is changed there.

SETTINGS = f"{BASE}/api/v1/app-settings"


@responses.activate
def test_upload_limit_comes_from_the_server(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(SETTINGS, json=[{"key": "max_upload_size_mb", "value": "2048"}])
    assert BookOrbit(cfg).upload_limit_bytes() == 2048 * 1024 * 1024


@responses.activate
def test_upload_limit_is_cached_not_refetched_per_book(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(SETTINGS, json=[{"key": "max_upload_size_mb", "value": "2048"}])
    api = BookOrbit(cfg)
    api.upload_limit_bytes(); api.upload_limit_bytes(); api.upload_limit_bytes()
    assert len([c for c in responses.calls if c.request.url == SETTINGS]) == 1


@responses.activate
def test_upload_limit_falls_back_when_the_setting_is_unreadable(cfg):
    # Never block an upload because a cosmetic lookup failed.
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(SETTINGS, status=500, json={})
    assert BookOrbit(cfg).upload_limit_bytes() == cfg.max_upload_bytes


@responses.activate
def test_upload_limit_ignores_a_nonsense_value(cfg):
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.get(SETTINGS, json=[{"key": "max_upload_size_mb", "value": "banana"}])
    assert BookOrbit(cfg).upload_limit_bytes() == cfg.max_upload_bytes


# --- the asin tag must survive BookOrbit's own metadata import ---------------
# EPUB uploads trigger an async import from the file (dc:title, dc:creator,
# dc:subject -> tags) that lands AFTER our PATCH and overwrote tags, so the two
# EPUBs in the run came out with correct titles and no reconciliation key.
# CBZs have no such import, which is why only the EPUBs lost it. Locking the
# field is what makes it durable; the title stays unlocked so enrichment may
# still improve it.

@responses.activate
def test_set_metadata_locks_the_tag_field(cfg):
    import json
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.patch(f"{BASE}/api/v1/books/42/metadata-and-locks", json={"id": 42})
    BookOrbit(cfg).set_metadata(42, title="Real Title", asin="B06XRCBRX8")
    body = json.loads(responses.calls[-1].request.body)
    assert body["metadata"]["title"] == "Real Title"
    assert "asin:B06XRCBRX8" in body["metadata"]["tags"]
    assert body["lockedFields"] == ["tags"]


@responses.activate
def test_the_title_is_left_unlocked(cfg):
    import json
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.patch(f"{BASE}/api/v1/books/42/metadata-and-locks", json={"id": 42})
    BookOrbit(cfg).set_metadata(42, title="Provisional", asin="B06XRCBRX8")
    body = json.loads(responses.calls[-1].request.body)
    assert "title" not in body["lockedFields"]


@responses.activate
def test_set_metadata_without_an_asin_locks_nothing(cfg):
    import json
    responses.post(LOGIN, json={"accessToken": "T"})
    responses.patch(f"{BASE}/api/v1/books/42/metadata-and-locks", json={"id": 42})
    BookOrbit(cfg).set_metadata(42, title="Just A Title")
    body = json.loads(responses.calls[-1].request.body)
    assert body.get("lockedFields") == []
