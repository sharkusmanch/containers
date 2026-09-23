import json
from app.readalong.storyteller import StorytellerClient, status_of, parse_action_id, init_admin


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses); self.calls = []

    def __call__(self, method, url, body, headers, stream_to=None):
        self.calls.append({"method": method, "url": url, "body": body, "headers": headers})
        status, payload = self.responses.pop(0)
        if stream_to is not None:
            with open(stream_to, "wb") as fh:
                fh.write(payload)
            return status, len(payload)
        return status, payload


def test_login_posts_form_and_keeps_bearer():
    t = FakeTransport([(200, json.dumps({"access_token": "abc", "token_type": "bearer"}).encode())])
    c = StorytellerClient("http://st:8001", transport=t)
    assert c.login("admin", "pw") == "abc"
    call = t.calls[0]
    assert call["url"] == "http://st:8001/api/v2/token"
    assert call["headers"]["Content-Type"] == "application/x-www-form-urlencoded"
    assert b"usernameOrEmail=admin" in call["body"] and b"password=pw" in call["body"]


def test_relogin_reuses_credentials_from_first_login():
    t = FakeTransport([
        (200, json.dumps({"access_token": "first"}).encode()),
        (200, json.dumps({"access_token": "second"}).encode()),
    ])
    c = StorytellerClient("http://st:8001", transport=t)
    c.login("admin", "s3cret")
    assert c.token == "first"
    c.relogin()
    assert c.token == "second"
    # relogin() must replay the SAME credentials without the caller re-supplying them
    assert b"usernameOrEmail=admin" in t.calls[1]["body"] and b"password=s3cret" in t.calls[1]["body"]


def test_relogin_before_any_login_raises():
    c = StorytellerClient("http://st:8001", transport=FakeTransport([]))
    try:
        c.relogin()
    except RuntimeError as e:
        assert "before any successful login" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_create_book_sends_copy_mode_and_explicit_epub2_strategy():
    t = FakeTransport([(200, json.dumps({"uuid": "u1", "title": "T"}).encode())])
    c = StorytellerClient("http://st:8001", token="abc", transport=t)
    assert c.create_book("/pilot/T/T.epub", "/pilot/T/T.m4b") == "u1"
    body = json.loads(t.calls[0]["body"])
    assert body == {"paths": ["/pilot/T/T.epub", "/pilot/T/T.m4b"], "importMode": "copy", "epub2Strategy": "replace"}
    assert t.calls[0]["headers"]["Authorization"] == "Bearer abc"


def test_create_book_rejects_epub2_probe_response():
    t = FakeTransport([(200, json.dumps({"epub2Detected": True, "paths": ["/pilot/T/T.epub"]}).encode())])
    c = StorytellerClient("http://st:8001", token="abc", transport=t)
    try:
        c.create_book("/pilot/T/T.epub", "/pilot/T/T.m4b")
    except RuntimeError as e:
        assert "epub2Detected" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_process_uses_restart_query_and_optional_config():
    t = FakeTransport([(200, b"{}"), (200, b"{}")])
    c = StorytellerClient("http://st:8001", token="abc", transport=t)
    c.process("u1")
    c.process("u1", restart="sync", config={"aligner": "whisper"})
    assert t.calls[0]["url"] == "http://st:8001/api/v2/books/u1/process"
    assert t.calls[1]["url"] == "http://st:8001/api/v2/books/u1/process?restart=sync"
    assert json.loads(t.calls[1]["body"]) == {"config": {"aligner": "whisper"}}


def test_status_of_handles_v2_and_v3_shapes():
    s = status_of({"readaloud": {"status": "PROCESSING", "currentStage": "SYNC_CHAPTERS", "stageProgress": 0.5}})
    assert (s.status, s.stage, s.progress) == ("PROCESSING", "SYNC_CHAPTERS", 0.5)
    s = status_of({"processingStatus": {"status": "ALIGNED", "currentTask": "DONE", "progress": 1}})
    assert (s.status, s.stage, s.progress) == ("ALIGNED", "DONE", 1.0)
    s = status_of({"readaloud": None})
    assert s.status == "UNKNOWN"


def test_alignment_report_404_is_none_and_download_streams(tmp_path):
    t = FakeTransport([(404, b'{"message":"No alignment report"}'), (200, b"PK\x03\x04zip")])
    c = StorytellerClient("http://st:8001", token="abc", transport=t)
    assert c.alignment_report("u1") is None
    out = tmp_path / "r.epub"
    assert c.download_readaloud("u1", str(out)) == 7
    assert t.calls[1]["url"] == "http://st:8001/api/v2/books/u1/files?format=readaloud"


def test_parse_action_id_finds_next_server_action_field():
    # Verbatim (minus surrounding page content) from a real /init response —
    # RSC flight payload with the action id JSON, quotes backslash-escaped
    # because it's embedded inside a JS string in the served HTML.
    html = 'InitForm\\"]\\n9:C\\n16:{\\"id\\":\\"40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332\\",\\"bound\\":null}'
    assert parse_action_id(html) == "40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332"


def test_parse_action_id_skips_unbound_actions_before_initform():
    # Regression test: the flight payload can carry other unbound server
    # action references (nav, locale switcher, theme toggle, ...) BEFORE
    # InitForm's — a bare re.search for the first "id":"...","bound":null
    # anywhere would silently return the wrong one. This fixture puts a
    # decoy candidate ahead of InitForm and asserts the InitForm-adjacent
    # id wins.
    html = (
        'ThemeToggle\\"]\\n5:C\\n8:{\\"id\\":\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\",\\"bound\\":null}\\n'
        'InitForm\\"]\\n9:C\\n16:{\\"id\\":\\"40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332\\",\\"bound\\":null}'
    )
    assert parse_action_id(html) == "40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332"


def test_init_admin_posts_next_action_header_and_json_arg_array():
    html = 'InitForm\\"]\\n9:C\\n16:{\\"id\\":\\"40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332\\",\\"bound\\":null}'
    t = FakeTransport([(200, html.encode()), (200, b'0:["$@1",null]\n')])
    init_admin("http://st:8001", "admin", "pw", "admin@example.com", transport=t)
    get_call, post_call = t.calls
    assert get_call["method"] == "GET" and get_call["url"] == "http://st:8001/init"
    assert post_call["method"] == "POST" and post_call["url"] == "http://st:8001/init"
    assert post_call["headers"]["Next-Action"] == "40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332"
    assert post_call["headers"]["Content-Type"] == "text/plain;charset=UTF-8"
    assert post_call["headers"]["Accept"] == "text/x-component"
    assert post_call["headers"]["Origin"] == "http://st:8001"
    assert json.loads(post_call["body"]) == [
        {"email": "admin@example.com", "fullName": "Admin", "username": "admin", "password": "pw"}
    ]


def test_init_admin_ignores_unrelated_failed_substring_in_i18n_payload():
    # Regression test: a live success response's body includes the app's
    # full i18n bundle, which contains an unrelated key
    # `"failed":"Could not set cover colors"`. A naive `b"failed" in raw`
    # check flags every successful call as a failure — this fixture is that
    # exact shape and must NOT raise.
    init_html = 'InitForm\\"]\\n9:C\\n16:{\\"id\\":\\"40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332\\",\\"bound\\":null}'
    success_body = (
        b'26:{"id":"60016484","bound":null}\n'
        b'27:{"applied":["Cover colors set"],"failed":"Could not set cover colors"},"search":"Search..."\n'
    )
    t = FakeTransport([(200, init_html.encode()), (200, success_body)])
    init_admin("http://st:8001", "admin", "pw", "admin@example.com", transport=t)  # must not raise


def test_init_admin_raises_on_standalone_failed_row():
    init_html = 'InitForm\\"]\\n9:C\\n16:{\\"id\\":\\"40e938f0710bb0b8f4d13d2b5ca8c2b15941a5f332\\",\\"bound\\":null}'
    failure_body = b'0:["$@1",null]\n4:"failed"\n'
    t = FakeTransport([(200, init_html.encode()), (200, failure_body)])
    try:
        init_admin("http://st:8001", "admin", "pw", "admin@example.com", transport=t)
    except RuntimeError as e:
        assert "failure" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


# --- vendored + delete_book / flushed streaming (2026-09-23) -------------------

def test_delete_book_counts_404_as_already_gone_and_raises_otherwise():
    t = FakeTransport([(204, b""), (404, b"{}"), (500, b"boom")])
    c = StorytellerClient("http://st:8001", token="abc", transport=t)
    c.delete_book("u1")
    c.delete_book("u2")                       # already gone: fine
    try:
        c.delete_book("u3")
    except RuntimeError as e:
        assert "500" in str(e)
    else:
        raise AssertionError("expected RuntimeError")
    assert [(x["method"], x["url"]) for x in t.calls] == [
        ("DELETE", "http://st:8001/api/v2/books/u1"), ("DELETE", "http://st:8001/api/v2/books/u2"),
        ("DELETE", "http://st:8001/api/v2/books/u3")]


def test_stream_to_file_flushes_dirty_pages_as_it_writes(tmp_path, monkeypatch):
    """An NFS destination: dirty page cache counts against the pod's memory
    limit, so the stream is fsync'ed and dropped every `flush_every` bytes."""
    from app.readalong import storyteller as st
    synced = []
    monkeypatch.setattr(st.os, "fsync", lambda fd: synced.append(fd))
    chunks = [b"a" * 400, b"b" * 400, b"c" * 400, b""]
    n = st._stream_to_file(lambda size: chunks.pop(0), str(tmp_path / "out.epub"), flush_every=700)
    assert n == 1200
    assert (tmp_path / "out.epub").read_bytes() == b"a" * 400 + b"b" * 400 + b"c" * 400
    assert len(synced) == 2                   # once past 700 bytes, once at the end
