# twitch-drops-miner

Automated Twitch drops mining application with a web-based interface.

**Self-maintained image.** We build our own TwitchDropsMiner image — attested,
digest-pinned, non-root and without upstream's browser stack — for as long as it earns its
keep (see [Why not upstream's image](#why-not-upstreams-image)). It builds from the
upstream `rangermix/TwitchDropsMiner`
**release tarball** (Renovate tracks `github-releases` and opens a bump PR on each new
release) with two local patches applied: **PR #62** (per-game GQL crash-resilience) and
**gql-transient-retry-budget** (a local fix, no upstream PR — see below). The **PR #70**
drop-progress fix (Twitch removed the `sendSpadeEvents` GraphQL mutation during the 2026
Summer Drops event, freezing all drop progress, upstream
[issue #69](https://github.com/rangermix/TwitchDropsMiner/issues/69)) shipped upstream in
**v1.2.5**, so that patch was dropped.

> **Maintenance model:** a Renovate bump PR rebuilds from the new upstream release + the
> patches. When upstream ships one of these fixes *in a release*, its patch stops applying
> and the build fails loudly — the signal to delete that patch. (Python is Renovate-pinned —
> see the Dockerfile's `partitioned`-cookie note; bumping it below 3.14 breaks the saved
> Twitch session.)

> **Runtime note:** drop crediting requires `beacon.twitch.tv` (Twitch's watch-event
> endpoint) to resolve — it is blocked by default on tracker-blocking DNS (e.g. NextDNS)
> and must be allowlisted, or drops silently never progress.

## Upstream

- **Repository**: [rangermix/TwitchDropsMiner](https://github.com/rangermix/TwitchDropsMiner)
- **Version**: whatever `ARG UPSTREAM_VERSION` in the Dockerfile says (Renovate-tracked; the image tag mirrors it) + patch [PR #62](https://github.com/rangermix/TwitchDropsMiner/pull/62) + a local GQL retry-budget patch

## Usage

```bash
docker run -p 8080:8080 -v tdm-data:/app/data ghcr.io/sharkusmanch/containers/twitch-drops-miner:latest
```

(The image tag is the upstream release version; the local patches are applied on top.)

The web UI is served on port 8080. This image has no Twitch sign-in of its own: it restores
the session already saved in `/app/data/cookies.jar` (see
[Why not upstream's image](#why-not-upstreams-image)).

## Volumes

| Path | Description |
|------|-------------|
| `/app/data` | Persistent storage — `settings.json` + `cookies.jar` (Twitch session). Back this up. |
| `/app/logs` | Rotating log files (redundant with stdout). Ephemeral. |

## Modifications from Upstream

- Built from the upstream release tarball with two patches in `patches/`:
  - `pr62-...` — PR #62 (per-game GQL crash-resilience; upstream fatally crashes on an
    intermittent `PersistedQueryNotFound`, this skips the affected game for the cycle).
  - `gql-transient-retry-budget...` — local, no upstream PR. Upstream retries a transient
    `PersistedQueryNotFound` / `service error` exactly **once**; a cold Twitch edge routinely
    returns it twice in a row, and the unguarded `fetch_inventory()` startup path turns the
    second one into `exit 1` → CrashLoopBackOff → ingress 503 (observed 2026-08-18). This
    replaces the one-shot flag with a 5-retry budget in the GQL client, which covers every
    call site — inventory, directory and drop-claim — not just the per-game one PR #62 wraps.
  Each patch is removed once upstream ships it in a release (its build then fails to apply).
  `pr70-...` was removed on the v1.2.5 bump for exactly that reason.
- Multi-stage build (deps installed into an isolated prefix; build toolchain kept out of
  the runtime image) and a non-root `appuser` (UID/GID 10000), per this repo's standards.
  Same `python main.py` entrypoint, port 8080 and `/app/data` + `/app/logs` layout as
  upstream.
- No browser stack. Upstream's image has shipped Chromium, Xvfb, openbox, x11vnc, xdotool
  and noVNC since v2.1.0 for its in-dashboard Twitch sign-in; this one ships none of it.

## Why not upstream's image

Re-evaluated at v2.2.0 (2026-10-06); the answer was still "keep ours".

- **Both patches are still needed.** At v2.2.0 `GQLClient.request()` still raises on a
  second consecutive `PersistedQueryNotFound`, and `fetch_inventory()` and the per-game
  directory call still let that exception end the process. PR #62 was closed unmerged.
- **Upstream's sign-in cannot run where we deploy.** Since v2.1.0 the miner signs in
  through a Chromium desktop inside the container, started as a second `tdm-browser`
  user — so it refuses unless the miner itself runs as root (`BrowserIsolation` requires
  `geteuid() == 0`). The v2.1.1 desktop helper moves the sign-in to a PC but still needs
  headless Chromium on the miner to verify and renew. Our consumers run non-root with
  every capability dropped, so the stack would be about 320 MiB of dead weight (upstream
  is ~354 MiB compressed, this image ~37 MiB).
- **What we rely on instead.** The miner restores the legacy `ANDROID_APP` auth-token from
  `cookies.jar`, which upstream still honours. If Twitch ever revokes those tokens, a
  browser is needed whichever image is used — that is the point to revisit this.
