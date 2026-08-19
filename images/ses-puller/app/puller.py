"""ses-puller: SES/S3 spool -> Stalwart injection daemon.

Design: Outline "emailctl v3 — Puller Design (v1.1)" (doc En1hODwyWH).
Every non-obvious behavior below traces to a red-team finding ([R4-n], [R3-n],
[R2-n]) or a Phase 0 gate ([G3-1]); see the design doc for rationale.

Trust model [R4-1, R4-2]:
  - The SES notification (SQS message body) is the trust root: verdicts,
    mail.source, receipt.recipients are attacker-unreachable.
  - The Addy PGP signature (VALIDSIG against a pinned fingerprint) is the only
    authentication for encrypted mail.
  - Message headers (Authentication-Results, X-AnonAddy-*) are routing metadata
    only; anyone can pre-supply them.
"""

from __future__ import annotations

import email
import email.policy
import http.server
import json
import logging
import os
import re
import smtplib
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from email.message import Message

import boto3
from botocore.exceptions import ClientError
from prometheus_client import Counter, Gauge, start_http_server

log = logging.getLogger("puller")

# ---------------------------------------------------------------------------
# Config

def _env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise SystemExit(f"missing required env var {name}")
    return val


@dataclass
class Config:
    queue_url: str = field(default_factory=lambda: _env("SQS_QUEUE_URL"))
    bucket: str = field(default_factory=lambda: _env("S3_BUCKET"))
    inbound_prefix: str = field(default_factory=lambda: _env("INBOUND_PREFIX", "inbound/"))
    quarantine_prefix: str = field(default_factory=lambda: _env("QUARANTINE_PREFIX", "quarantine/"))
    smtp_host: str = field(default_factory=lambda: _env("SMTP_HOST", "stalwart.mail.svc.cluster.local"))
    smtp_port: int = field(default_factory=lambda: int(_env("SMTP_PORT", "25")))
    # Multi-domain from day one [R4-8]: JSON map of recipient DOMAIN -> mailbox.
    # Unknown domains quarantine; there is deliberately no default mailbox.
    domain_mailbox_map: dict = field(
        default_factory=lambda: json.loads(_env("DOMAIN_MAILBOX_MAP"))
    )
    pgp_private_key_file: str = field(default_factory=lambda: _env("PGP_PRIVATE_KEY_FILE"))
    addy_signing_key_file: str = field(default_factory=lambda: _env("ADDY_SIGNING_KEY_FILE"))
    # Pinned independently of the key file so a swapped ConfigMap alone cannot
    # move the trust anchor [R4-1].
    addy_fingerprint: str = field(default_factory=lambda: _env("ADDY_SIGNING_FINGERPRINT").replace(" ", "").upper())
    msgid_domain: str = field(default_factory=lambda: _env("PULLER_MSGID_DOMAIN", "puller.invalid"))
    batch_size: int = field(default_factory=lambda: int(_env("SQS_BATCH_SIZE", "2")))  # [R4-7]
    visibility_seconds: int = field(default_factory=lambda: int(_env("SQS_VISIBILITY_SECONDS", "300")))
    sweep_interval: int = field(default_factory=lambda: int(_env("SWEEP_INTERVAL_SECONDS", "3600")))
    sweep_min_age: int = field(default_factory=lambda: int(_env("SWEEP_MIN_AGE_SECONDS", "900")))
    max_object_bytes: int = field(default_factory=lambda: int(_env("MAX_OBJECT_BYTES", str(41 * 1024 * 1024))))
    metrics_port: int = field(default_factory=lambda: int(_env("METRICS_PORT", "9095")))
    health_port: int = field(default_factory=lambda: int(_env("HEALTH_PORT", "8081")))
    gnupghome: str = field(default_factory=lambda: _env("GNUPGHOME", "/tmp/gnupg"))


# ---------------------------------------------------------------------------
# Metrics

PROCESSED = Counter("puller_processed_total", "Messages fully processed", ["outcome"])
QUARANTINED = Counter("puller_quarantined_total", "Messages quarantined", ["reason"])
PGP_DRIFT = Counter("puller_pgp_drift_total", "Forwards that arrived unencrypted [R2-3]")
SWEEP_ORPHANS = Counter("puller_sweep_orphans_total", "Objects found by sweep with no notification [R3-2]")
POLL_ERRORS = Counter("puller_poll_errors_total", "SQS/S3 API errors", ["op"])
QUEUE_DEPTH = Gauge("puller_sqs_queue_depth", "ApproximateNumberOfMessages (self-reported)")
LAST_SUCCESS = Gauge("puller_last_success_timestamp", "Unix time of last successful processing")
HEARTBEAT = Gauge("puller_heartbeat_timestamp", "Unix time of last main-loop iteration")


# ---------------------------------------------------------------------------
# GPG

class Gpg:
    """Thin wrapper over the gpg binary. Status-fd is parsed, never exit codes
    alone [R4-1]."""

    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _run(self, args: list[str], stdin: bytes | None = None) -> tuple[int, bytes, str]:
        proc = subprocess.run(
            ["gpg", "--batch", "--no-tty", "--no-options",
             "--homedir", self.cfg.gnupghome, "--status-fd", "2"] + args,
            input=stdin, capture_output=True, timeout=120,
        )
        return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")

    def setup(self) -> None:
        os.makedirs(self.cfg.gnupghome, mode=0o700, exist_ok=True)
        for path in (self.cfg.pgp_private_key_file, self.cfg.addy_signing_key_file):
            rc, _, status = self._run(["--import", path])
            if "IMPORT_OK" not in status and "IMPORTED" not in status:
                raise SystemExit(f"gpg import failed for {path}: {status[-300:]}")
        log.info("gpg keys imported; pinned addy fingerprint %s", self.cfg.addy_fingerprint)

    def decrypt(self, ciphertext: bytes) -> tuple[bytes | None, bool]:
        """Returns (plaintext or None, signature_valid_for_pinned_key)."""
        rc, out, status = self._run(["--decrypt"], stdin=ciphertext)
        if "DECRYPTION_OKAY" not in status:
            return None, False
        # VALIDSIG <sig-fpr> ... <primary-fpr>; field 12 (last) is the primary
        # key fingerprint. Match either against the pin.
        sig_ok = False
        for line in status.splitlines():
            if "VALIDSIG" in line:
                parts = line.split()
                fprs = {parts[2].upper(), parts[-1].upper()} if len(parts) > 2 else set()
                if self.cfg.addy_fingerprint in fprs:
                    sig_ok = True
        return out, sig_ok


# ---------------------------------------------------------------------------
# Classification / processing

# Outer headers copied onto the reconstructed (decrypted) message. These sit
# OUTSIDE Addy's signature and are only as trustworthy as the IP allowlist that
# gates the spool — so we copy exactly what Sieve leak-detection needs
# (X-AnonAddy-Original-*) plus SES verdicts as informational X-SES-*, and we do
# NOT copy Authentication-Results [R5]: it is forgeable here and would render a
# misleading auth result in the MUA. Stalwart re-evaluates anyway.
OUTER_HEADERS_TO_COPY = [
    "X-AnonAddy-Original-Sender",
    "X-AnonAddy-Original-To",
    "X-SES-Spam-Verdict",
    "X-SES-Virus-Verdict",
    "Received",
]


class PermanentInjectionError(Exception):
    """Stalwart refused the message with a 5xx — retrying will never succeed, so
    the message is quarantined rather than looped [R5-2]."""


class MalformedMessageError(Exception):
    """A message we can't structurally process (e.g. multipart/encrypted whose
    payload isn't a list) — quarantine as unparseable, never poison-loop [R5]."""

ADDY_SOURCE_DOMAINS = ("addy.io",)


@dataclass
class Meta:
    """Attacker-unreachable facts from the SES notification [R4-2].
    synthetic=True means a sweep re-enqueue: no verdicts exist -> fail closed."""
    object_key: str
    source: str | None = None
    recipients: list[str] = field(default_factory=list)
    verdicts_pass: bool | None = None  # None = unknown (synthetic)
    synthetic: bool = False


def parse_notification(body: str) -> Meta | None:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    if data.get("puller_sweep"):
        return Meta(object_key=data["objectKey"], synthetic=True)
    # Tolerate an SNS envelope in case raw delivery is ever toggled off.
    if "Message" in data and "receipt" not in data:
        try:
            data = json.loads(data["Message"])
        except (json.JSONDecodeError, TypeError):
            return None
    receipt = data.get("receipt") or {}
    action = receipt.get("action") or {}
    if action.get("type") != "S3" or "objectKey" not in action:
        return None
    verdicts = [
        (receipt.get(v) or {}).get("status", "").upper()
        for v in ("spfVerdict", "dkimVerdict", "dmarcVerdict")
    ]
    return Meta(
        object_key=action["objectKey"],
        source=(data.get("mail") or {}).get("source"),
        recipients=list(receipt.get("recipients") or []),
        verdicts_pass=all(v == "PASS" for v in verdicts),
    )


def source_is_addy(source: str | None) -> bool:
    if not source or "@" not in source:
        return False
    domain = source.rsplit("@", 1)[1].lower().rstrip(">").strip()
    return any(domain == d or domain.endswith("." + d) for d in ADDY_SOURCE_DOMAINS)


def rewrite_message_id(msg: Message, object_key: str, msgid_domain: str) -> None:
    """[G3-1] Deterministic per-delivery Message-ID: unique across alias copies
    (defeats Stalwart's ingest dedup blind spot), identical across redeliveries
    of the same object (dedup becomes an idempotency bonus for inbox mail)."""
    original = msg.get("Message-ID")
    if original:
        # ensure single-instance
        del msg["X-Original-Message-ID"]
        msg["X-Original-Message-ID"] = original
    del msg["Message-ID"]
    key_token = re.sub(r"[^A-Za-z0-9]", "-", object_key.rsplit("/", 1)[-1])
    msg["Message-ID"] = f"<{key_token}@{msgid_domain}>"


def reconstruct(outer: Message, plaintext: bytes, object_key: str, msgid_domain: str) -> bytes:
    """Gate-3-proven reconstruction: decrypted inner MIME (protected headers)
    plus the outer transport headers Sieve matches on."""
    inner = email.message_from_bytes(plaintext, policy=email.policy.SMTP)
    for header in OUTER_HEADERS_TO_COPY:
        values = outer.get_all(header) or []
        if header not in ("Received",) and inner.get(header):
            continue  # inner already carries it; don't duplicate
        for value in values:
            inner[header] = value
    rewrite_message_id(inner, object_key, msgid_domain)
    return inner.as_bytes()


def prepend_headers(raw: bytes, headers: list[tuple[str, str]]) -> bytes:
    """Prepend headers to raw RFC822 bytes without a parse/re-serialize round
    trip (CRLF fidelity on passthrough paths [R4-minor])."""
    block = b"".join(f"{k}: {v}\r\n".encode() for k, v in headers)
    return block + raw


def raw_rewrite_message_id(raw: bytes, object_key: str, msgid_domain: str) -> bytes:
    """Message-ID rewrite for paths that must not re-serialize the body: rename
    the original header in place (header block only) and prepend the new one."""
    header_end = raw.find(b"\r\n\r\n")
    if header_end == -1:
        header_end = len(raw)
    head, tail = raw[:header_end], raw[header_end:]
    head = re.sub(rb"(?im)^Message-ID:", b"X-Original-Message-ID:", head, count=1)
    key_token = re.sub(r"[^A-Za-z0-9]", "-", object_key.rsplit("/", 1)[-1])
    return (f"Message-ID: <{key_token}@{msgid_domain}>\r\n".encode() + head + tail)


class Puller:
    def __init__(self, cfg: Config, s3=None, sqs=None, smtp_factory=None):
        self.cfg = cfg
        self.s3 = s3 or boto3.client("s3")
        self.sqs = sqs or boto3.client("sqs")
        self.smtp_factory = smtp_factory or (lambda: smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=60))
        self.gpg = Gpg(cfg)
        self._recently_enqueued: dict[str, float] = {}
        self._tagging_available = True

    # -- S3 helpers ---------------------------------------------------------

    def _already_injected(self, key: str) -> bool:
        if not self._tagging_available:
            return False
        try:
            tags = self.s3.get_object_tagging(Bucket=self.cfg.bucket, Key=key)
            return any(t["Key"] == "injected" for t in tags.get("TagSet", []))
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("NoSuchKey", "404"):
                raise
            if code == "AccessDenied":
                # IAM addition not applied yet — degrade gracefully, log once.
                if self._tagging_available:
                    log.warning("s3 tagging denied; running without the tag idempotency layer")
                self._tagging_available = False
                return False
            raise

    def _mark_injected(self, key: str) -> None:
        if not self._tagging_available:
            return
        try:
            self.s3.put_object_tagging(
                Bucket=self.cfg.bucket, Key=key,
                Tagging={"TagSet": [{"Key": "injected", "Value": "true"}]},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "AccessDenied":
                self._tagging_available = False
            else:
                raise

    def _quarantine(self, key: str, raw: bytes, reason: str) -> None:
        dest = f"{self.cfg.quarantine_prefix}{reason}/{key.rsplit('/', 1)[-1]}"
        self.s3.put_object(Bucket=self.cfg.bucket, Key=dest, Body=raw)
        self.s3.delete_object(Bucket=self.cfg.bucket, Key=key)
        QUARANTINED.labels(reason=reason).inc()
        PROCESSED.labels(outcome=f"quarantined_{reason}").inc()
        log.warning("quarantined %s -> %s", key, dest)

    # -- SMTP ---------------------------------------------------------------

    def _inject(self, raw: bytes, envelope_from: str | None, rcpts: list[str]) -> None:
        sender = envelope_from if envelope_from else "<>"  # null reverse-path [R4-6]
        try:
            with self.smtp_factory() as smtp:
                # EHLO arg must be FQDN-shaped — Stalwart 5xx's a bare hostname,
                # and smtplib records a failed ehlo() without raising, so the
                # later MAIL gets "EHLO first" [R5 live finding]. Check the code.
                code, _ = smtp.ehlo("ses-puller.mail.svc.cluster.local")
                if code != 250:
                    raise RuntimeError(f"EHLO rejected with {code}")  # transient
                refused = smtp.sendmail(sender, rcpts, raw)
        except smtplib.SMTPRecipientsRefused as e:
            # Distinguish permanent (5xx) from transient (4xx) per-recipient
            # [R5-2]. Any 5xx = undeliverable → quarantine, never poison-loop.
            if any(code >= 500 for code, _ in e.recipients.values()):
                raise PermanentInjectionError(f"5xx recipient refusal: {e.recipients}")
            raise  # 4xx: transient, let SQS redeliver
        except (smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as e:
            if getattr(e, "smtp_code", 0) >= 500:
                raise PermanentInjectionError(str(e))
            raise
        # sendmail() returns a dict of PARTIALLY refused recipients (some
        # accepted, some not). A partial 5xx here is still permanent for those.
        if refused:
            if any(code >= 500 for code, _ in refused.values()):
                raise PermanentInjectionError(f"5xx partial refusal: {refused}")
            raise RuntimeError(f"transient recipient refusal: {refused}")

    def _map_recipients(self, meta: Meta, outer: Message) -> tuple[list[str], list[str]]:
        """[R4-8] Map SES receipt recipients through the domain map. Returns
        (mapped mailboxes, unmapped recipients)."""
        recipients = meta.recipients
        if not recipients:
            # Sweep path: fall back to the Delivered-To/To header domain match.
            candidates = [outer.get("To", ""), outer.get("Delivered-To", "")]
            recipients = [c for c in candidates if c]
        mapped, unmapped = [], []
        for rcpt in recipients:
            addr = rcpt.strip().strip("<>")
            match = re.search(r"[\w.+-]+@([\w.-]+)", addr)
            domain = match.group(1).lower() if match else ""
            mailbox = self.cfg.domain_mailbox_map.get(domain)
            if mailbox:
                if mailbox not in mapped:
                    mapped.append(mailbox)
            else:
                unmapped.append(addr)
        return mapped, unmapped

    # -- Core pipeline ------------------------------------------------------

    def process(self, meta: Meta) -> None:
        key = meta.object_key
        try:
            if self._already_injected(key):
                log.info("already injected, cleaning up: %s", key)
                self.s3.delete_object(Bucket=self.cfg.bucket, Key=key)
                PROCESSED.labels(outcome="dedup_skip").inc()
                return
            head = self.s3.head_object(Bucket=self.cfg.bucket, Key=key)
            if head["ContentLength"] > self.cfg.max_object_bytes:
                raw = b""  # do not pull an oversize body into memory
                self._quarantine_oversize(key)
                return
            raw = self.s3.get_object(Bucket=self.cfg.bucket, Key=key)["Body"].read()
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                # [R4-5] crash-after-delete redelivery: done means done.
                log.info("object gone (already processed): %s", key)
                PROCESSED.labels(outcome="nosuchkey_skip").inc()
                return
            raise

        try:
            outer = email.message_from_bytes(raw, policy=email.policy.SMTP)
        except Exception:
            self._quarantine(key, raw, "unparseable")
            return

        mapped, unmapped = self._map_recipients(meta, outer)
        if unmapped:
            log.warning("unknown recipients %s for %s", unmapped, key)
        if not mapped:
            self._quarantine(key, raw, "unknown-rcpt")
            return

        try:
            if outer.get_content_type() == "multipart/encrypted":
                self._process_encrypted(key, raw, outer, meta, mapped)
            else:
                self._process_plaintext(key, raw, outer, meta, mapped)
        except PermanentInjectionError as e:
            # Undeliverable (5xx from Stalwart, e.g. unknown mailbox) — quarantine
            # rather than loop forever [R5-2].
            log.error("permanent injection failure for %s: %s", key, e)
            self._quarantine(key, raw, "undeliverable")
        except MalformedMessageError:
            self._quarantine(key, raw, "unparseable")

    def _quarantine_oversize(self, key: str) -> None:
        # Copy server-side (no memory), then delete.
        dest = f"{self.cfg.quarantine_prefix}oversize/{key.rsplit('/', 1)[-1]}"
        self.s3.copy_object(Bucket=self.cfg.bucket, Key=dest,
                            CopySource={"Bucket": self.cfg.bucket, "Key": key})
        self.s3.delete_object(Bucket=self.cfg.bucket, Key=key)
        QUARANTINED.labels(reason="oversize").inc()
        PROCESSED.labels(outcome="quarantined_oversize").inc()

    def _process_encrypted(self, key, raw, outer, meta, rcpts) -> None:
        payload = outer.get_payload()
        if not isinstance(payload, list):
            # multipart/encrypted with a non-multipart body: malformed [R5].
            raise MalformedMessageError("multipart/encrypted payload is not a list")
        armor = None
        for part in payload:
            if hasattr(part, "get_content_type") and part.get_content_type() == "application/octet-stream":
                armor = part.get_payload(decode=True)
        if armor is None:
            self._quarantine(key, raw, "unparseable")
            return
        plaintext, sig_ok = self.gpg.decrypt(armor)
        if plaintext is None:
            self._quarantine(key, raw, "undecryptable")  # [R2-6]
            return
        if not sig_ok:
            # [R4-1] The fatal: decryptable-but-not-Addy-signed is the
            # anyone-with-the-public-key injection channel. Fail closed.
            self._quarantine(key, raw, "bad-signature")
            return
        out_bytes = reconstruct(outer, plaintext, key, self.cfg.msgid_domain)
        self._inject(out_bytes, meta.source, rcpts)
        self._finish(key)
        PROCESSED.labels(outcome="injected_encrypted").inc()

    def _process_plaintext(self, key, raw, outer, meta, rcpts) -> None:
        if meta.synthetic or meta.verdicts_pass is None:
            # [R4-2] Sweep path has no verdicts: fail closed for plaintext.
            self._quarantine(key, raw, "held-for-review")
            return
        if not meta.verdicts_pass or not source_is_addy(meta.source):
            self._quarantine(key, raw, "spoof")  # [R3-7]
            return
        if outer.get("X-AnonAddy-Original-To"):
            # [R2-3] A forward that should have been encrypted: PGP drift.
            # Inject (mail is never lost) but scream.
            PGP_DRIFT.inc()
            out = prepend_headers(
                raw_rewrite_message_id(raw, key, self.cfg.msgid_domain),
                [("X-Puller-Warning", "pgp-drift")],
            )
            self._inject(out, meta.source, rcpts)
            self._finish(key)
            PROCESSED.labels(outcome="injected_drift").inc()
            return
        # Legit Addy service mail: passthrough, raw bytes untouched [R2-6].
        self._inject(raw, meta.source, rcpts)
        self._finish(key)
        PROCESSED.labels(outcome="injected_passthrough").inc()

    def _finish(self, key: str) -> None:
        self._mark_injected(key)
        self.s3.delete_object(Bucket=self.cfg.bucket, Key=key)
        LAST_SUCCESS.set(time.time())

    # -- SQS loop -----------------------------------------------------------

    def poll_once(self) -> None:
        HEARTBEAT.set(time.time())  # also beats on empty polls (idle liveness)
        try:
            resp = self.sqs.receive_message(
                QueueUrl=self.cfg.queue_url,
                MaxNumberOfMessages=self.cfg.batch_size,
                WaitTimeSeconds=20,
                AttributeNames=["ApproximateReceiveCount"],
            )
        except ClientError:
            POLL_ERRORS.labels(op="receive").inc()
            time.sleep(10)
            return
        for msg in resp.get("Messages", []):
            self._handle_sqs_message(msg)
        self._report_depth()

    def _handle_sqs_message(self, msg: dict) -> None:
        HEARTBEAT.set(time.time())  # per-message [R5]: a slow batch must not
        # let the liveness heartbeat go stale mid-inject.
        stop_beat = self._start_visibility_heartbeat(msg["ReceiptHandle"])
        try:
            meta = parse_notification(msg["Body"])
            if meta is None:
                log.warning("unrecognized SQS payload, deleting: %.200s", msg["Body"])
                self._delete_sqs(msg)
                return
            self.process(meta)
            self._delete_sqs(msg)
        except Exception:
            log.exception("processing failed; leaving message for redelivery")
            POLL_ERRORS.labels(op="process").inc()
        finally:
            stop_beat.set()

    def _start_visibility_heartbeat(self, receipt_handle: str) -> threading.Event:
        """[R4-7] Extend visibility while a long decrypt/inject runs. Tolerates
        missing IAM (ChangeMessageVisibility pending in terraform)."""
        stop = threading.Event()

        def beat():
            while not stop.wait(self.cfg.visibility_seconds // 3):
                try:
                    self.sqs.change_message_visibility(
                        QueueUrl=self.cfg.queue_url,
                        ReceiptHandle=receipt_handle,
                        VisibilityTimeout=self.cfg.visibility_seconds,
                    )
                except ClientError:
                    return  # AccessDenied or expired handle: stop quietly

        threading.Thread(target=beat, daemon=True).start()
        return stop

    def _delete_sqs(self, msg: dict) -> None:
        self.sqs.delete_message(QueueUrl=self.cfg.queue_url, ReceiptHandle=msg["ReceiptHandle"])

    def _report_depth(self) -> None:
        try:
            attrs = self.sqs.get_queue_attributes(
                QueueUrl=self.cfg.queue_url, AttributeNames=["ApproximateNumberOfMessages"])
            QUEUE_DEPTH.set(int(attrs["Attributes"]["ApproximateNumberOfMessages"]))
        except (ClientError, KeyError):
            POLL_ERRORS.labels(op="depth").inc()

    # -- Sweep [R3-2, R4-3] -------------------------------------------------

    def sweep_once(self) -> int:
        """Re-enqueue orphaned inbound objects as synthetic SQS messages.
        Never processes inline: one consumer path, no races."""
        now = time.time()
        self._recently_enqueued = {
            k: t for k, t in self._recently_enqueued.items() if now - t < 4 * self.cfg.sweep_interval
        }
        found = 0
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.cfg.bucket, Prefix=self.cfg.inbound_prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                age = now - obj["LastModified"].timestamp()
                if age < self.cfg.sweep_min_age or key in self._recently_enqueued:
                    continue
                try:
                    self.sqs.send_message(
                        QueueUrl=self.cfg.queue_url,
                        MessageBody=json.dumps({"puller_sweep": True, "objectKey": key}),
                    )
                    self._recently_enqueued[key] = now
                    found += 1
                except ClientError:
                    POLL_ERRORS.labels(op="sweep_enqueue").inc()
                    return found
        if found:
            SWEEP_ORPHANS.inc(found)
            log.warning("sweep re-enqueued %d orphaned objects (notification loss?)", found)
        return found

    def sweep_loop(self) -> None:
        while True:
            time.sleep(self.cfg.sweep_interval)
            try:
                self.sweep_once()
            except Exception:
                log.exception("sweep failed")
                POLL_ERRORS.labels(op="sweep").inc()


# ---------------------------------------------------------------------------
# Health endpoint (liveness = main loop heartbeat, sweep excluded [R4-minor])

def start_health_server(port: int, max_age: int = 300) -> None:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            fresh = (time.time() - HEARTBEAT._value.get()) < max_age
            self.send_response(200 if fresh else 503)
            self.end_headers()
            self.wfile.write(b"ok" if fresh else b"stale")

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


# ---------------------------------------------------------------------------
# Drift checker [R3-3] — CronJob entrypoint

def driftcheck() -> int:
    import dns.resolver

    expected = set(json.loads(_env("EXPECTED_ADDY_CIDRS")))
    spf_domain = _env("ADDY_SPF_DOMAIN", "addy.io")
    inbound_host = _env("SES_INBOUND_HOST", "inbound-smtp.us-west-2.amazonaws.com")

    answers = dns.resolver.resolve(spf_domain, "TXT")
    spf = next((s for rdata in answers
                for s in [b"".join(rdata.strings).decode()] if s.startswith("v=spf1")), "")
    live = {f"{t[4:]}/32" if "/" not in t[4:] else t[4:]
            for t in spf.split() if t.startswith("ip4:")}
    drift = False
    if live != expected:
        print(f"DRIFT-DETECTED spf mismatch live={sorted(live)} expected={sorted(expected)}")
        drift = True
    try:
        dns.resolver.resolve(inbound_host, "AAAA")
        print(f"DRIFT-DETECTED {inbound_host} now publishes AAAA — IPv6 invisibility assumption broken")
        drift = True
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN):
        pass
    if not drift:
        print(f"drift-check ok: {len(live)} SPF ip4 terms match; no AAAA on {inbound_host}")
    return 1 if drift else 0


# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "driftcheck":
        raise SystemExit(driftcheck())

    cfg = Config()
    puller = Puller(cfg)
    puller.gpg.setup()
    start_http_server(cfg.metrics_port)
    start_health_server(cfg.health_port)
    threading.Thread(target=puller.sweep_loop, daemon=True).start()
    log.info("puller started; queue=%s bucket=%s domains=%s",
             cfg.queue_url, cfg.bucket, list(cfg.domain_mailbox_map))
    while True:
        puller.poll_once()


if __name__ == "__main__":
    main()
