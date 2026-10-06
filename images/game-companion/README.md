# game-companion

A page for a handheld's small second screen. It works out which game is being played and
puts that game's guide pages and achievement progress one tap apart.

A small Node service polls Steam and RetroAchievements for the current game, indexes guide
documents in an Outline wiki by the `Steam App ID` or `RA Game ID` row in each guide, and
serves a read-only JSON API together with a static front end. The front end is a thin
sidebar that frames real Outline pages and shows an achievements panel.

## Upstream

- **Repository**: none. This directory is the source.
- **Version**: v0.1.0

## Usage

```bash
docker run --rm -p 8080:8080 \
  -e STEAM_API_KEY=... -e STEAM_ID=... \
  -e RA_API_KEY=... -e RA_USERNAME=... \
  -e OUTLINE_BASE_URL=https://outline.example.com \
  -e OUTLINE_API_KEY=... \
  -e OUTLINE_COLLECTION_ID=... -e OUTLINE_GUIDES_PARENT_ID=... \
  ghcr.io/sharkusmanch/containers/game-companion:v0.1.0
```

The page is served at `/companion/` and must be reached on the **same hostname as Outline**
(route `/companion` on Outline's hostname to this container). Outline only allows itself to
be framed by its own origin, so the guide frames stay blank on any other hostname.

There is no sign-in. Every endpoint is read-only. Put it only where everyone who can reach
it may see achievement progress and guide page titles.

## Environment Variables

| Variable                   | Required | Description                                                               |
| -------------------------- | -------- | ------------------------------------------------------------------------- |
| `STEAM_API_KEY`            | Yes      | Steam Web API key                                                         |
| `STEAM_ID`                 | Yes      | SteamID64 of the account to watch                                         |
| `RA_API_KEY`               | Yes      | RetroAchievements Web API key                                             |
| `RA_USERNAME`              | Yes      | RetroAchievements user to watch                                           |
| `OUTLINE_BASE_URL`         | Yes      | Base URL of the Outline instance, without a trailing slash                |
| `OUTLINE_COLLECTION_ID`    | Yes      | ID of the Outline collection that holds the guides                        |
| `OUTLINE_GUIDES_PARENT_ID` | Yes      | ID of the document whose children are the guide hubs                      |
| `OUTLINE_API_KEY`          | No       | Read-only Outline API key. Without it the guide index is disabled         |
| `OUTLINE_SCHEDULE_DOC_ID`  | No       | ID of a document whose `## Now Playing` section lists games to show first |
| `DEFAULT_PINNED_PAGES`     | No       | Comma-separated guide page titles to pin the first time a game is opened  |
| `PORT`                     | No       | Listening port (default `8080`)                                           |
| `STATIC_DIR`               | No       | Directory of the built front end (default `/app/dist/web`)                |

The Outline key needs only these scopes:
`/api/documents.list /api/documents.info /api/collections.documents`.

## Endpoints

| Path                                            | Returns                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `GET /companion/`                               | The page                                                             |
| `GET /companion/healthz`                        | `{"ok":true}`                                                        |
| `GET /companion/api/now`                        | The current game and its matching guide                              |
| `GET /companion/api/guides`                     | Every guide hub with its platform (`?refresh=1` asks for a re-index) |
| `GET /companion/api/guides/<hubId>`             | One hub's page tree                                                  |
| `GET /companion/api/achievements/<source>/<id>` | Achievements for a game that has a guide or is being played          |

Achievement requests are limited to games the service knows about, and the number of
upstream fetches per minute is capped, because the API keys are usually shared with other
tools.

## Guide format

The service finds a game's guide by reading the guide documents themselves. It expects:

- The guides to be the direct children of one parent document (`OUTLINE_GUIDES_PARENT_ID`),
  each with its own sub-pages.
- A table row in each guide naming the game: `| Steam App ID | 1234 |` or
  `| RA Game ID | 5678 |` (the label may be bold; the number may be a link to the store or
  RetroAchievements page). A guide with neither row can still be opened by hand.
- Optionally, a title ending in `(<console> — RetroAchievements)`, which becomes the
  platform label shown next to the guide.
- Optionally, in the schedule document, a `## Now Playing` section whose bold titles are
  listed first in the game picker.

## Development

```bash
npm ci
npm test          # vitest
npm run typecheck && npm run lint && npm run format:check
npm run build     # compiles to dist/ and copies the static front end
```

`.ci-test` runs the same checks in CI before the image is built. Bump
`GAME_COMPANION_VERSION` in the `Dockerfile` for every change that should ship.

## Modifications from Upstream

- None. Original code.
