# kindle-ingest

Kindle → BookOrbit ingest pipeline. Polls a jailbroken Kindle over Tailscale,
pulls newly-downloaded books, decrypts them in-cluster using the per-book key
the device emits, converts to EPUB (or CBZ for comics), and uploads to a
self-hosted BookOrbit library.

Design: `home-ops-private docs/superpowers/specs/2026-08-24-kindle-ingest-design.md`

## Upstream

Vendored at build time, not committed:

- **DeDRM** (`ion.py`, `kfxdedrm.py`) — [Satsuoni/DeDRM_tools](https://github.com/Satsuoni/DeDRM_tools),
  pinned release, SHA-256 verified. GPL v3. Decrypts a KFX archive given the
  per-book key; no PIDs or account secret are needed.
- **KFX Input** — [kluyg/calibre-kfx-input](https://github.com/kluyg/calibre-kfx-input),
  a mirror of jhowell's plugin, pinned commit. `ebook-convert` cannot read KFX
  without it. **The mirror lags upstream** (2.25.0 vs 2.33.0 as of 2026-08);
  the build's smoke test is what catches a version that cannot read a real book.

## Usage

Runs as a Deployment (`replicas: 1`) with a userspace Tailscale sidecar. Loops
on `POLL_INTERVAL`; an unreachable device is a normal state, not an error.

## Environment Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOOKORBIT_URL` | *required* | e.g. `http://bookorbit.media.svc.cluster.local:3000` |
| `BOOKORBIT_USER` / `BOOKORBIT_PASS` | *required* | API credentials; JWTs last ~15 min so it logs in per cycle |
| `KINDLE_HOST` | `100.64.0.12` | tailnet address of the device |
| `KINDLE_PORT` | `2222` | dropbear port |
| `SSH_KEY_PATH` | `/secrets/ssh/id_ed25519` | dedicated keypair, not a personal one |
| `SOCKS_PROXY` | `127.0.0.1:1055` | userspace Tailscale sidecar |
| `LIBRARY_ID` / `FOLDER_ID` | `1` / `1` | BookOrbit upload target |
| `APPRISE_URL` | *(empty)* | e.g. `http://apprise.tools.svc.cluster.local:8000/notify/bookorbit` |
| `POLL_INTERVAL` | `600` | seconds between cycles |
| `CYCLE_DEADLINE` | `POLL_INTERVAL - 60` | must be less than the interval, or cycles overlap |
| `DATA_DIR` | `/data` | archive, epub, cbz (NFS) |
| `WORK_DIR` | `${DATA_DIR}/work` | calibre scratch (emptyDir) |
| `STATE_DIR` | `/state` | ledger (Longhorn, backed up) |
| `CLEANUP_ENABLED` | `false` | delete device sources after verified upload |
| `MAX_DELETES_PER_CYCLE` | `10` | cap on device deletions |
| `CONVERT_TIMEOUT` | `1800` | per-book conversion cap |
| `METRICS_PORT` | `9090` | `/metrics` and `/healthz` |

## Volumes

| Path | Backing | Why |
| --- | --- | --- |
| `/data` | NFS | GB-scale and replaceable |
| `/data/work` | emptyDir | small-file I/O, disposable |
| `/state` | Longhorn (K8up-backed) | the ledger is the only record of what was uploaded |
| `/secrets/ssh` | Secret | dedicated SSH key |

## Safety properties

- **Additive only.** Never deletes or replaces anything in the library.
- **Cleanup deletes `.kfx` and `assets/` only — never `.sdr`**, which holds the
  device's reading position, bookmarks and highlights.
- **"Verified" is a conjunction**: an upload id, a server-side size match, a
  structural check of the artifact, and the local archive matching its recorded
  SHA-256. Deleting on an HTTP 200 alone would strand a corrupt book that an
  additive-only pipeline can never replace.
- **An unreachable device is never an error**, so it cannot page you.
