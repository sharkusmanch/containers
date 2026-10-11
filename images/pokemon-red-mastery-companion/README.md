# pokemon-red-mastery-companion

Pokémon Red mastery guide for the main, Professor Oak Challenge and Glitch Showcase
sets. A static Preact app runs on unprivileged nginx, reads exactly one battery save,
and requests the three progress feeds through a restricted same-origin proxy.

## Upstream

- **Repository**: Original application, vendored under `app/` from reviewed commit
  `ce1b23f2ab0995efc8ebf5393c6a0a60b78b02c4`.
- **Version**: v0.1.0
- **Provenance**: `source-provenance.json` records SHA256 for every unchanged vendored
  source, build, public test and attribution file. `test/provenance.py` checks it.
- **License and data**: [MIT license](app/LICENSE), [data sources](app/docs/data-sources.md).
  The runtime retains the license under `/usr/share/licenses/`.

## Usage

```bash
docker run --rm -p 8080:8080 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -v /path/to/synced-saves:/saves:ro \
  -e 'SAVE_FILE=/saves/Pokemon Red (USA, Europe).srm' \
  -e COMPANION_UPSTREAM=game-companion:8080 \
  ghcr.io/sharkusmanch/containers/pokemon-red-mastery-companion:v0.1.0
```

Connect the two containers to a shared Docker network when using the example hostname.
The frontend uses its existing `/save` and `/companion/api/achievements/ra/…` defaults.
It starts without a save or progress service; unavailable inputs remain unavailable
while the guide loads. The image creates no saves and performs no save conversion,
copying, selection, rewriting or synchronization. Mount the existing save directory
read-only and ensure UID/GID 10000 can traverse the directory and read the intended file.
Keep this personal data endpoint on a trusted private network.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `SAVE_FILE` | No | Exact absolute battery-save filename, default `/saves/red.srm`. Supports ASCII letters, digits, spaces and `_./()+,-`; quotes, controls, variables and directive delimiters fail startup. |
| `COMPANION_UPSTREAM` | No | Trusted DNS hostname or IPv4 plus port 1–65535, default `127.0.0.1:9999` for offline startup. No scheme, path, IPv6 literal or credentials. |

Configure the separate **game-companion v0.8.0 or newer** service with
`RA_ADDITIONAL_GAME_IDS=724,16084,11632`. It retains the RA credentials and adds account
identity and the real last successful fetch timestamp to each separately cached feed.
The browser never receives API credentials. Progress remains account-wide hardcore
history, distinct from current-save facts and continuity-scoped manual evidence.

## Volumes

| Path | Description |
| --- | --- |
| `/saves` | Existing source save directory, mounted read-only. Only `SAVE_FILE` is exposed. |
| `/tmp` | Writable temporary nginx config, PID and buffers. All other paths can be read-only. |

## Transport contract

- UID/GID 10000, port 8080, nginx receives PID 1 signals directly.
- Exact `GET`/`HEAD /save` returns binary `application/octet-stream` with `no-store`,
  including error responses. A missing save is 404; `/save/…` never lists files or
  falls back to the app. Every other HTTP method is denied.
- Only `/companion/api/achievements/ra/724`, `/companion/api/achievements/ra/16084`
  and `/companion/api/achievements/ra/11632` are proxied, with the complete prefix
  preserved. Other companion paths return 404. Request credentials and bodies are
  not forwarded; responses are not server-cached, carry `no-store`, and use bounded
  connect/send/read timeouts.
- `/healthz` reports nginx health. The index is revalidated, hashed assets can be
  cached immutably, and missing static paths return 404. The reviewed index has no
  favicon; no new UI assets are added.
- Only `SAVE_FILE` and `COMPANION_UPSTREAM` are substituted into nginx's template;
  nginx variables remain literal. Untrusted request inputs cannot configure upstreams.

## Validation

`.ci-test` verifies source hashes, installs the locked Node dependencies in a clean
container, runs the frontend type check, full test suite and production build, then
exercises the actual Dockerfile `runtime-base` stage with that output. HTTP checks
cover exact bytes, missing paths, denied methods, all three progress routes, preserved
prefixes, stripped credentials, cache behavior and service unavailability. Docker
checks verify UID 10000 and read-only root/save mounts. The final multiarch image is
built separately by the repository workflow and still needs artifact/deployment checks.

Private save/ROM bytes, sessions and source clones are excluded. Missing optional
private/public save fixtures and the pinned external pokered clone visibly skip their
existing dependent tests. Those skips are not target-emulator acceptance. See the
vendored [fixture catalogue](app/test/fixtures/README.md) and [source boundaries](app/docs/data-sources.md).

## Modifications from Upstream

- Application source, defaults, locked dependencies and selected public build/test inputs
  are unchanged. Packaging adds nginx, a validated two-variable entrypoint, provenance
  and container transport tests.
- The image ships no Outline proxy or existing game-companion UI. The existing service
  remains responsible for its own guide, rich-presence and achievement interfaces.
