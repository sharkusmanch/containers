# emailctl-puller

SES/S3 spool → Stalwart injection daemon for the emailctl v3.2 mail architecture.
Fetches Addy.io-forwarded mail from an SQS-notified S3 spool, decrypts + verifies
the Addy PGP signature, and injects into a self-hosted Stalwart server via SMTP.

**Design & rationale:** Outline "emailctl v3 — Puller Design (v1.1)" (doc `En1hODwyWH`),
child of the migration plan `SeHQjQI6aU`. Every non-obvious behavior in `app/puller.py`
is tagged with the red-team finding it satisfies (`[R4-n]`, `[R3-n]`, `[R2-n]`, `[G3-1]`).

## Trust model

1. **SES notification** (SQS body) is the trust root — `receipt.*Verdict`, `mail.source`,
   `receipt.recipients` are attacker-unreachable.
2. **Addy PGP signature** (`VALIDSIG` against a pinned fingerprint) authenticates encrypted mail.
3. Message headers are routing metadata only — never authentication.

Fail-closed everywhere it matters: decryptable-but-unsigned → `quarantine/bad-signature/`;
plaintext failing verdicts or not from addy.io → `quarantine/spoof/`; unknown recipient →
`quarantine/unknown-rcpt/`; sweep-path plaintext (no verdicts) → `quarantine/held-for-review/`.
Mail is never lost: everything either injects or lands in a delete-protected quarantine prefix.

## Entrypoints

- `python puller.py` — the daemon (default).
- `python puller.py driftcheck` — the [R3-3] Addy-SPF-vs-allowlist + no-AAAA drift check
  (CronJob; emits `DRIFT-DETECTED` lines for a VictoriaLogs alert).

## Configuration (env)

| Var | Purpose |
|---|---|
| `SQS_QUEUE_URL`, `S3_BUCKET`, `INBOUND_PREFIX`, `QUARANTINE_PREFIX` | from OpenBao `apps/mail/aws` |
| `DOMAIN_MAILBOX_MAP` | JSON `{"mx.sharkus.xyz":"user@…", "mx.msanchez.io":"user@…"}` — **multi-domain routing, no default** |
| `SMTP_HOST`, `SMTP_PORT` | Stalwart injection target (default `stalwart.mail.svc:25`) |
| `PGP_PRIVATE_KEY_FILE`, `ADDY_SIGNING_KEY_FILE` | mounted key files (never env) |
| `ADDY_SIGNING_FINGERPRINT` | pinned trust anchor, independent of the key file |
| `PULLER_MSGID_DOMAIN` | Message-ID rewrite domain [G3-1] |
| `EXPECTED_ADDY_CIDRS`, `SES_INBOUND_HOST` | driftcheck only |

AWS creds come from the standard boto3 env (`AWS_*`), sourced from the same secret.

## Image

- **amd64 only** (`.platforms`) — the cluster is amd64 and this never runs on ARM.
- Application code is **baked in, not ConfigMap-mounted**: the logic is security-sensitive
  and the cluster's Kyverno policy verifies the image's cosign signature + SLSA attestation,
  so the running code must equal the attested code.
- CI runs `pytest` as a gate before build (`.ci-test`), so broken classification logic
  cannot produce a signed image.

## Tests

`PYTHONPATH=app python -m pytest tests/` — fakes for S3/SQS/SMTP/GPG, no AWS. Covers the
full classification matrix, idempotency (tag pre-check, NoSuchKey-means-done, deterministic
Message-ID), and multi-domain routing. Real-corpus + live-pipeline coverage is Phase 1.
