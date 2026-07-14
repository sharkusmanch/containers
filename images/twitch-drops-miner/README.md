# twitch-drops-miner

Automated Twitch drops mining application with a web-based interface.

**Self-maintained image.** We build our own TwitchDropsMiner image permanently — attested,
digest-pinned, and independent of the under-maintained upstream (which repeatedly breaks
against Twitch API changes). It currently tracks upstream `rangermix/TwitchDropsMiner`
**1.2.4** plus two backported fixes: **PR #70** (`capkz:fix/drops-spade-post-endpoint` —
Twitch removed the `sendSpadeEvents` GraphQL mutation during the 2026 Summer Drops event,
freezing all drop progress, upstream
[issue #69](https://github.com/rangermix/TwitchDropsMiner/issues/69); PR #70 reverts to a
direct Spade POST) and **PR #62** (per-game GQL crash-resilience).

> **Maintenance model:** when a backported fix lands in an upstream *release*, bump the
> source to that release and drop the now-redundant local patch — but keep building this
> image. The `patches/` backports exist only until upstream ships an equivalent.

> **Runtime note:** drop crediting requires `beacon.twitch.tv` (Twitch's watch-event
> endpoint) to resolve — it is blocked by default on tracker-blocking DNS (e.g. NextDNS)
> and must be allowlisted, or drops silently never progress.

## Upstream

- **Repository**: [rangermix/TwitchDropsMiner](https://github.com/rangermix/TwitchDropsMiner)
- **Version**: v1.2.4 + [PR #70](https://github.com/rangermix/TwitchDropsMiner/pull/70) (`capkz/TwitchDropsMiner@6092705`)

## Usage

```bash
docker run -p 8080:8080 -v tdm-data:/app/data ghcr.io/sharkusmanch/containers/twitch-drops-miner:1.2.4-pr70-pr62
```

The web UI is served on port 8080; complete the Twitch device-code login once via the UI.

## Volumes

| Path | Description |
|------|-------------|
| `/app/data` | Persistent storage — `settings.json` + `cookies.jar` (Twitch session). Back this up. |
| `/app/logs` | Rotating log files (redundant with stdout). Ephemeral. |

## Modifications from Upstream

- Built from PR #70's head commit instead of a release tag (the drop-progress fix is not
  yet in any upstream release).
- Also backports PR #62 (per-game GQL crash-resilience) via `patches/` — upstream 1.2.4
  fatally crashes on an intermittent `PersistedQueryNotFound`; this skips the affected
  game for the cycle instead. Drop when upstream ships an equivalent.
- Multi-stage build (deps installed into an isolated prefix; build toolchain kept out of
  the runtime image) and a non-root `appuser` (UID/GID 10000), per this repo's standards.
  Otherwise functionally identical to the upstream Dockerfile (same `python main.py`
  entrypoint, port 8080, `/app/data` + `/app/logs` layout).
