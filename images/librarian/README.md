# librarian

BookOrbit intake service. It watches an intake directory for new audiobooks and
ebooks (Libation, Kindle, manual drops), works out where each one belongs in the
BookOrbit library, and has a sandboxed `claude -p` run propose and a second
`claude -p` run review each filing.

- **Python staging core.** It scans intake and waits until files stop changing,
  hashes them, and builds a compact dossier for each arrival. Every string that
  comes from a file, tag or remote API goes into the dossier's `untrusted`
  object. It enforces guards on every intent and turns approved intents into
  "would do" plans.
- **Sandboxed LLM run.** `claude -p` gets no built-in tools. It reaches the core
  only through a stdio MCP shim (`app/mcp_shim.py`), and the shim calls a
  loopback-only HTTP API that checks a per-run token. Each run gets an empty
  cwd and its own `HOME` / `CLAUDE_CONFIG_DIR` under `RUNS_ROOT`, plus an
  allowlisted environment. After each run the core checks the tools the run
  was actually granted, and discards the run if any extra tool shows up.

**This release is DRY_RUN only.** The service refuses to start with
`DRY_RUN=false`. It never moves, writes or deletes anything under `/media`, and
never writes to BookOrbit. Mount the media volume read-only. Live mode comes in
a later release.

## Environment variables

From `app/config.py`. A blank value counts as unset.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOOKORBIT_URL` | *required* | API base **including** `/api/v1`, e.g. `http://bookorbit.media.svc.cluster.local:3000/api/v1` |
| `BOOKORBIT_USER` / `BOOKORBIT_PASS` | *required* | read-only use; login is throttled, so a failed login waits 300 s |
| `CLAUDE_CODE_OAUTH_TOKEN` | *required for runs* | passed through to `claude -p` (the only secret the child sees) |
| `DRY_RUN` | `true` | `false` exits: "live mode ships in plan P2" |
| `INTAKE_ROOT` | `/media/library_intake` | contains `libation/`, `kindle/`, `manual/` |
| `LOCAL_BOOKS_ROOT` | `/media/books` | where BookOrbit's `/books/...` paths are mounted in this pod |
| `BOOKORBIT_PATH_PREFIX` | `/books` | BookOrbit's container path prefix, mapped to `LOCAL_BOOKS_ROOT` |
| `STATE_DIR` | `/state` | JSONL ledgers (arrivals, intents, runs), dossiers, transcripts, cookie jar |
| `LISTS_DIR` | `/etc/librarian/lists` | `kids-allowlist.json`, `kids-denylist.json` |
| `PROMPTS_DIR` | `/etc/librarian/prompts` | `librarian.md`, `reviewer.md` (shipped with the deployment, not the image) |
| `POLL_INTERVAL` | `120` | seconds between ticks |
| `QUIET_PERIOD` | `600` | seconds a candidate must be unchanged before it is hashed |
| `DEBOUNCE` | `300` | seconds after the newest change before a run starts, so a burst becomes one run |
| `MAX_ARRIVALS_PER_RUN` | `20` | arrivals offered to one run |
| `RUN_TIMEOUT` | `2700` | per `claude -p` run |
| `MODEL` / `REVIEWER_MODEL` | `opus` / `opus` | models for the two runs |
| `RETRY_AFTER` | `3600` | hold time before a failed or interrupted run's arrivals are offered again |
| `METRICS_PORT` | `9090` | `/metrics` and `/healthz` |
| `API_PORT` | `8081` | internal API, bound to 127.0.0.1 only |
| `CLAUDE_BIN` | `claude` | path to the Claude Code binary |
| `RUNS_ROOT` | `/tmp/runs` | per-run cwd, `HOME` and `CLAUDE_CONFIG_DIR` (use an emptyDir) |
| `ONLY` | *(unset)* | restrict to one `source_id` or one full arrival key (debugging) |
| `LOG_LEVEL` | `INFO` | Python logging level |

## Ports

| Port | Bind | Purpose |
| --- | --- | --- |
| `9090` | all interfaces | Prometheus `/metrics`, liveness/readiness `/healthz` |
| `8081` | `127.0.0.1` only | internal API for the MCP shim; never expose it |

## Image

- Base `python:3.14-slim` (Debian/glibc). The build is **amd64 only**
  (`.platforms`), because the Claude Code native binary is per-architecture.
- Claude Code is pinned (`CLAUDE_VERSION`, bumped by Renovate). It is installed
  with the official installer into `/opt/claude` and symlinked as
  `/usr/local/bin/claude`.
- `ffprobe` comes from Debian's `ffmpeg`. `tini` runs as PID 1, so SIGTERM
  reaches the service (which kills a running `claude` process group and
  discards the cycle) and child processes get reaped.
- The image runs as `911:911` with no writable home. It works with
  `readOnlyRootFilesystem: true` if `/tmp` (for `RUNS_ROOT`) and `STATE_DIR`
  are writable mounts.
- The build fails unless `claude --version` reports the pinned version,
  `ffprobe` runs, the package imports, and the MCP shim's derived
  `PYTHONPATH` is `/app`.

## Tests

The unit tests need no network, BookOrbit or ffprobe. They inject fakes.

```bash
cd images/librarian
uv run -q --with pytest --with requests==2.34.2 --with prometheus-client==0.26.0 --with "mcp==1.30.0" \
  python -m pytest -q
```

`.ci-test` runs the same suite as the pre-build gate in CI (`.github/workflows/build.yml`).

## Eval

The eval makes real, paid `claude -p` runs against a fake BookOrbit, using the
deployment's prompts. See `evals/README.md` for the cases and how they are graded.

```bash
cd images/librarian
export CLAUDE_CODE_OAUTH_TOKEN=...     # never commit or log it
uv run -q --with requests==2.34.2 --with prometheus-client==0.26.0 --with "mcp==1.30.0" --with pytest \
  python evals/run_eval.py --prompts <prompts dir> --model opus [--case NAME ...]
```
