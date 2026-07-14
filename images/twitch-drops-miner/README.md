# twitch-drops-miner

Automated Twitch drops mining application with a web-based interface.

**Self-maintained image.** We build our own TwitchDropsMiner image permanently — attested,
digest-pinned, and independent of the under-maintained upstream (which repeatedly breaks
against Twitch API changes). It builds from the upstream `rangermix/TwitchDropsMiner`
**release tarball** (Renovate tracks `github-releases` and opens a bump PR on each new
release) with two backported fixes applied as local patches: **PR #70** (Twitch removed the
`sendSpadeEvents` GraphQL mutation during the 2026 Summer Drops event, freezing all drop
progress, upstream [issue #69](https://github.com/rangermix/TwitchDropsMiner/issues/69);
reverts to a direct Spade POST) and **PR #62** (per-game GQL crash-resilience).

> **Maintenance model:** a Renovate bump PR rebuilds from the new upstream release + the
> patches. When upstream ships one of these fixes *in a release*, its patch stops applying
> and the build fails loudly — the signal to delete that patch. We keep building our own
> image throughout. (Python is Renovate-pinned — see the Dockerfile's `partitioned`-cookie
> note; bumping it below 3.14 breaks the saved Twitch session.)

> **Runtime note:** drop crediting requires `beacon.twitch.tv` (Twitch's watch-event
> endpoint) to resolve — it is blocked by default on tracker-blocking DNS (e.g. NextDNS)
> and must be allowlisted, or drops silently never progress.

## Upstream

- **Repository**: [rangermix/TwitchDropsMiner](https://github.com/rangermix/TwitchDropsMiner)
- **Version**: upstream release `v1.2.4` (Renovate-tracked) + patches [PR #70](https://github.com/rangermix/TwitchDropsMiner/pull/70) + [PR #62](https://github.com/rangermix/TwitchDropsMiner/pull/62)

## Usage

```bash
docker run -p 8080:8080 -v tdm-data:/app/data ghcr.io/sharkusmanch/containers/twitch-drops-miner:v1.2.4
```

(The image tag is the upstream release version; the backport patches are applied on top.)

The web UI is served on port 8080; complete the Twitch device-code login once via the UI.

## Volumes

| Path | Description |
|------|-------------|
| `/app/data` | Persistent storage — `settings.json` + `cookies.jar` (Twitch session). Back this up. |
| `/app/logs` | Rotating log files (redundant with stdout). Ephemeral. |

## Modifications from Upstream

- Built from the upstream release tarball with two backport patches in `patches/`:
  - `pr70-...` — PR #70 (Spade-POST drop-progress fix; the drop-progress fix is not yet in
    any upstream release).
  - `pr62-...` — PR #62 (per-game GQL crash-resilience; upstream fatally crashes on an
    intermittent `PersistedQueryNotFound`, this skips the affected game for the cycle).
  Each patch is removed once upstream ships it in a release (its build then fails to apply).
- Multi-stage build (deps installed into an isolated prefix; build toolchain kept out of
  the runtime image) and a non-root `appuser` (UID/GID 10000), per this repo's standards.
  Otherwise functionally identical to the upstream Dockerfile (same `python main.py`
  entrypoint, port 8080, `/app/data` + `/app/logs` layout).
