"""Classification-matrix + idempotency tests for the puller.

These run with fakes for S3/SQS/SMTP/GPG (no AWS, no network). The goal is to
pin every row of the design's classification matrix and the [R4-n] fixes so a
regression is loud. Real-corpus + live-pipeline coverage happens in Phase 1.
"""

import json
import os
import time

import pytest

os.environ.setdefault("SQS_QUEUE_URL", "https://sqs.test/q")
os.environ.setdefault("S3_BUCKET", "test-bucket")
os.environ.setdefault("DOMAIN_MAILBOX_MAP", json.dumps({"mx.sharkus.xyz": "user@mail.local",
                                                        "mx.msanchez.io": "user@mail.local"}))
os.environ.setdefault("PGP_PRIVATE_KEY_FILE", "/dev/null")
os.environ.setdefault("ADDY_SIGNING_KEY_FILE", "/dev/null")
os.environ.setdefault("ADDY_SIGNING_FINGERPRINT", "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555")
os.environ.setdefault("PGP_PRIVATE_KEY_FILE", "/dev/null")

import puller as P  # noqa: E402


class FakeS3:
    def __init__(self):
        self.objects = {}   # key -> bytes
        self.tags = {}      # key -> dict
        self.deleted = []

    def put(self, key, body):
        self.objects[key] = body

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise P.ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        import io
        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise P.ClientError({"Error": {"Code": "NoSuchKey"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def get_object_tagging(self, Bucket, Key):
        if Key not in self.objects and Key not in self.tags:
            raise P.ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObjectTagging")
        return {"TagSet": [{"Key": k, "Value": v} for k, v in self.tags.get(Key, {}).items()]}

    def put_object_tagging(self, Bucket, Key, Tagging):
        self.tags[Key] = {t["Key"]: t["Value"] for t in Tagging["TagSet"]}

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body

    def copy_object(self, Bucket, Key, CopySource):
        self.objects[Key] = self.objects[CopySource["Key"]]

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        self.objects.pop(Key, None)


class FakeSQS:
    def __init__(self):
        self.sent = []
    def send_message(self, QueueUrl, MessageBody):
        self.sent.append(json.loads(MessageBody))
    def delete_message(self, **k): pass
    def change_message_visibility(self, **k): pass
    def get_queue_attributes(self, **k):
        return {"Attributes": {"ApproximateNumberOfMessages": "0"}}


class FakeSMTP:
    injected = []
    # test hook: {rcpt: code} to refuse; codes >=500 = permanent
    refuse = {}
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def ehlo(self, *a): pass
    def sendmail(self, sender, rcpts, raw):
        import smtplib
        if FakeSMTP.refuse:
            raise smtplib.SMTPRecipientsRefused(
                {r: (FakeSMTP.refuse.get(r, 250), b"") for r in rcpts})
        FakeSMTP.injected.append((sender, rcpts, raw))
        return {}


class FakeGpg:
    """Configurable decrypt result."""
    def __init__(self, plaintext=None, sig_ok=False):
        self._plaintext, self._sig_ok = plaintext, sig_ok
    def setup(self): pass
    def decrypt(self, ciphertext):
        return self._plaintext, self._sig_ok


ENCRYPTED_RAW = (
    b"Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\";\r\n"
    b" boundary=\"b\"\r\n"
    b"Subject: ...\r\n"
    b"X-AnonAddy-Original-To: gate3@mx.sharkus.xyz\r\n\r\n"
    b"--b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n"
    b"--b\r\nContent-Type: application/octet-stream\r\n\r\nCIPHERTEXT\r\n--b--\r\n"
)
INNER_PLAINTEXT = (
    b"Subject: Real Subject\r\nFrom: shop@store.com\r\nTo: gate3@mx.sharkus.xyz\r\n"
    b"Message-ID: <orig@store.com>\r\n\r\nbody\r\n"
)


def make_puller(s3, sqs, gpg):
    cfg = P.Config()
    p = P.Puller(cfg, s3=s3, sqs=sqs, smtp_factory=lambda: FakeSMTP())
    p.gpg = gpg
    return p


def meta(key, source="alias@addy.io", recipients=("gate3@mx.sharkus.xyz",),
         verdicts=True, synthetic=False):
    return P.Meta(object_key=key, source=source, recipients=list(recipients),
                  verdicts_pass=verdicts, synthetic=synthetic)


@pytest.fixture(autouse=True)
def reset():
    FakeSMTP.injected = []
    FakeSMTP.refuse = {}


# --- classification matrix -------------------------------------------------

def test_verified_encrypted_forward_injects_with_rewritten_msgid():
    s3 = FakeS3(); s3.put("inbound/k1", ENCRYPTED_RAW)
    p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=True))
    p.process(meta("inbound/k1"))
    assert len(FakeSMTP.injected) == 1
    sender, rcpts, raw = FakeSMTP.injected[0]
    assert rcpts == ["user@mail.local"]
    assert b"Message-ID: <k1@" in raw            # [G3-1] rewritten
    assert b"X-Original-Message-ID: <orig@store.com>" in raw
    assert b"Subject: Real Subject" in raw       # inner protected header restored
    assert "inbound/k1" in s3.deleted


def test_encrypted_unsigned_is_quarantined_not_injected():
    # [R4-1] THE FATAL: decrypts fine, no valid Addy signature.
    s3 = FakeS3(); s3.put("inbound/k2", ENCRYPTED_RAW)
    p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=False))
    p.process(meta("inbound/k2"))
    assert FakeSMTP.injected == []
    assert any("quarantine/bad-signature/" in k for k in s3.objects)


def test_undecryptable_is_quarantined_and_loop_continues():
    s3 = FakeS3(); s3.put("inbound/k3", ENCRYPTED_RAW)
    p = make_puller(s3, FakeSQS(), FakeGpg(None, sig_ok=False))
    p.process(meta("inbound/k3"))
    assert FakeSMTP.injected == []
    assert any("quarantine/undecryptable/" in k for k in s3.objects)


def test_spoofed_plaintext_quarantined():
    # [R3-7] plaintext, verdicts fail.
    raw = b"Subject: hi\r\nX-AnonAddy-Original-To: x@mx.sharkus.xyz\r\n\r\nbody\r\n"
    s3 = FakeS3(); s3.put("inbound/k4", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/k4", source="attacker@evil.com", verdicts=False))
    assert FakeSMTP.injected == []
    assert any("quarantine/spoof/" in k for k in s3.objects)


def test_verdicts_pass_but_source_not_addy_is_spoof():
    # [R4-2] SPF/DKIM pass for the attacker's OWN domain must not qualify.
    raw = b"Subject: hi\r\nX-AnonAddy-Original-To: x@mx.sharkus.xyz\r\n\r\nbody\r\n"
    s3 = FakeS3(); s3.put("inbound/k5", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/k5", source="attacker@evil.com", verdicts=True))
    assert FakeSMTP.injected == []
    assert any("quarantine/spoof/" in k for k in s3.objects)


def test_pgp_drift_injects_with_warning():
    # [R2-3] plaintext forward from Addy that should have been encrypted.
    raw = b"Subject: hi\r\nMessage-ID: <d@x>\r\nX-AnonAddy-Original-To: x@mx.sharkus.xyz\r\n\r\nbody\r\n"
    s3 = FakeS3(); s3.put("inbound/k6", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    before = P.PGP_DRIFT._value.get()
    p.process(meta("inbound/k6"))
    assert len(FakeSMTP.injected) == 1
    assert b"X-Puller-Warning: pgp-drift" in FakeSMTP.injected[0][2]
    assert b"Message-ID: <k6@" in FakeSMTP.injected[0][2]
    assert P.PGP_DRIFT._value.get() == before + 1


def test_legit_addy_plaintext_passthrough_byte_exact():
    raw = b"Subject: Verify Your Email\r\nMessage-ID: <v@addy>\r\n\r\nreply to verify\r\n"
    s3 = FakeS3(); s3.put("inbound/k7", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/k7", recipients=("inbox@mx.sharkus.xyz",)))
    assert FakeSMTP.injected[0][2] == raw   # untouched bytes [R4-minor]


def test_unknown_recipient_quarantined_never_default():
    raw = b"Subject: hi\r\n\r\nbody\r\n"
    s3 = FakeS3(); s3.put("inbound/k8", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/k8", recipients=("someone@unmapped.example",)))
    assert FakeSMTP.injected == []
    assert any("quarantine/unknown-rcpt/" in k for k in s3.objects)


def test_sweep_synthetic_plaintext_is_held_not_injected():
    # [R4-2] sweep path has no verdicts -> fail closed for plaintext.
    raw = b"Subject: hi\r\n\r\nbody\r\n"
    s3 = FakeS3(); s3.put("inbound/k9", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(P.Meta(object_key="inbound/k9", synthetic=True,
                     recipients=["inbox@mx.sharkus.xyz"]))
    assert FakeSMTP.injected == []
    assert any("quarantine/held-for-review/" in k for k in s3.objects)


# --- idempotency -----------------------------------------------------------

def test_already_tagged_skips_injection():
    s3 = FakeS3(); s3.put("inbound/k10", ENCRYPTED_RAW); s3.tags["inbound/k10"] = {"injected": "true"}
    p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=True))
    p.process(meta("inbound/k10"))
    assert FakeSMTP.injected == []
    assert "inbound/k10" in s3.deleted


def test_nosuchkey_is_done_not_error():
    # [R4-5] redelivery after delete: must not raise (would poison-loop to DLQ).
    s3 = FakeS3()  # empty
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/gone"))   # should return quietly
    assert FakeSMTP.injected == []


def test_msgid_deterministic_across_redelivery_unique_across_aliases():
    # [G3-1] same object -> same id; different object -> different id.
    import email, email.policy
    def rid(obj_key):
        m = email.message_from_bytes(INNER_PLAINTEXT, policy=email.policy.SMTP)
        P.rewrite_message_id(m, obj_key, "puller.test")
        return m["Message-ID"]
    assert rid("inbound/aaa") == rid("inbound/aaa")
    assert rid("inbound/aaa") != rid("inbound/bbb")


def test_multi_domain_map_routes_both_domains():
    for dom in ("mx.sharkus.xyz", "mx.msanchez.io"):
        s3 = FakeS3(); s3.put("inbound/m", ENCRYPTED_RAW)
        p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=True))
        p.process(meta("inbound/m", recipients=(f"x@{dom}",)))
        assert FakeSMTP.injected[-1][1] == ["user@mail.local"]


def test_oversize_quarantined_without_reading_body():
    s3 = FakeS3()
    big = b"x" * (42 * 1024 * 1024)
    s3.put("inbound/big", big)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/big"))
    assert FakeSMTP.injected == []
    assert any("quarantine/oversize/" in k for k in s3.objects)


def test_notification_parse_prefers_receipt_verdicts():
    body = json.dumps({
        "mail": {"source": "alias@addy.io"},
        "receipt": {"action": {"type": "S3", "objectKey": "inbound/x"},
                    "recipients": ["a@mx.sharkus.xyz"],
                    "spfVerdict": {"status": "PASS"},
                    "dkimVerdict": {"status": "PASS"},
                    "dmarcVerdict": {"status": "PASS"}},
    })
    m = P.parse_notification(body)
    assert m.object_key == "inbound/x"
    assert m.verdicts_pass is True
    assert m.source == "alias@addy.io"
    assert m.recipients == ["a@mx.sharkus.xyz"]


def test_permanent_smtp_refusal_quarantines_not_loops():
    # [R5-2] 5xx (unknown mailbox) -> quarantine/undeliverable, no poison loop.
    s3 = FakeS3(); s3.put("inbound/k11", ENCRYPTED_RAW)
    FakeSMTP.refuse = {"user@mail.local": 550}
    p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=True))
    p.process(meta("inbound/k11"))
    assert FakeSMTP.injected == []
    assert any("quarantine/undeliverable/" in k for k in s3.objects)


def test_transient_smtp_refusal_raises_for_redelivery():
    # 4xx -> raise (SQS redelivers), object untouched.
    s3 = FakeS3(); s3.put("inbound/k12", ENCRYPTED_RAW)
    FakeSMTP.refuse = {"user@mail.local": 451}
    p = make_puller(s3, FakeSQS(), FakeGpg(INNER_PLAINTEXT, sig_ok=True))
    with pytest.raises(Exception):
        p.process(meta("inbound/k12"))
    assert "inbound/k12" not in s3.deleted
    assert not any("quarantine/" in k for k in s3.objects)


def test_malformed_encrypted_payload_quarantines_not_crashes():
    # multipart/encrypted whose body is a string, not parts [R5].
    raw = (b"Content-Type: multipart/encrypted; boundary=b\r\n\r\nnot-a-real-mime-body\r\n")
    s3 = FakeS3(); s3.put("inbound/k13", raw)
    p = make_puller(s3, FakeSQS(), FakeGpg())
    p.process(meta("inbound/k13"))
    assert FakeSMTP.injected == []
    assert any("quarantine/" in k for k in s3.objects)


def test_reconstruct_drops_authentication_results():
    # [R5] forgeable outer Authentication-Results must not be copied onto the
    # delivered message.
    import email, email.policy
    outer = email.message_from_bytes(
        b"Authentication-Results: spoofed; dmarc=pass\r\n"
        b"X-AnonAddy-Original-To: a@mx.sharkus.xyz\r\n"
        b"Content-Type: multipart/encrypted; boundary=b\r\n\r\nx\r\n",
        policy=email.policy.SMTP)
    out = P.reconstruct(outer, INNER_PLAINTEXT, "inbound/x", "puller.test")
    assert b"Authentication-Results" not in out
    assert b"X-AnonAddy-Original-To" in out   # Sieve still needs this


def test_source_is_addy_matches_subdomains_only():
    assert P.source_is_addy("x@addy.io")
    assert P.source_is_addy("x@mail.addy.io")
    assert not P.source_is_addy("x@addy.io.evil.com")
    assert not P.source_is_addy("x@notaddy.io")
    assert not P.source_is_addy(None)
