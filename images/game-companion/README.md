# game-companion

A page for a handheld's small second screen. It works out which game is being played and
puts that game's guide pages and achievement progress one tap apart.

A small Node service polls Steam and RetroAchievements for the current game, indexes guide
documents in an Outline wiki by the `Steam App ID` or `RA Game ID` row in each guide, and
serves a read-only JSON API together with a static front end. The front end is a thin
sidebar that frames real Outline pages and shows an achievements panel.

From an achievement, **Find in guide** searches the game's guide pages and opens the page at
that line. Achievements the guide marks as missable can be shown on their own, and a notice
appears when an achievement unlocks while the page is open. While a RetroAchievements game is
being played, a row under the title shows the status line the game reports (its rich
presence); a tap on it shows a long line in full. When that line names a place or chapter that
is also a heading in the guide, a button beside it opens the guide at that section (with
several matching sections it lists them); **Guide jump from status** under ⋯ › Display turns
this off. The page can be added to the home screen and then opens full screen; it keeps the
screen on and hides Outline's own sidebar and top bar inside the guide frames. Both can be
switched off under ⋯ › Display. **Guide text size** there draws the framed guide pages at 90,
80 or 70 per cent, for a small screen; it enlarges the frame and scales it down, so the guide
lays out in a wider window as it would under browser zoom.

Each pinned page's sidebar button shows how many of its checkboxes are ticked (`done/total`,
or a percentage when that is longer than six characters); the count follows a tick made in the
guide page within a few seconds. RetroAchievements achievements on the story path carry a
**Story** chip and the one for beating the game an **Ending** chip, and a **Story** switch
narrows the list to them. The page refreshes at once when it is shown again or the network
returns.

## Upstream

- **Repository**: none. This directory is the source.
- **Version**: v0.6.0

## Usage

```bash
docker run --rm -p 8080:8080 \
  -e STEAM_API_KEY=... -e STEAM_ID=... \
  -e RA_API_KEY=... -e RA_USERNAME=... \
  -e OUTLINE_BASE_URL=https://outline.example.com \
  -e OUTLINE_API_KEY=... \
  -e OUTLINE_COLLECTION_ID=... -e OUTLINE_GUIDES_PARENT_ID=... \
  ghcr.io/sharkusmanch/containers/game-companion:v0.6.0
```

The page is served at `/companion/` and must be reached on the **same hostname as Outline**
(route `/companion` on Outline's hostname to this container). Outline only allows itself to
be framed by its own origin, so the guide frames stay blank on any other hostname.

There is no sign-in. Every endpoint is read-only. Put it only where everyone who can reach it
may see what is being played, achievement progress, checklist counts and the text of the guide
pages: the guide search returns headings and matching lines from them, although Outline itself
requires a sign-in.

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

| Path                                            | Returns                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `GET /companion/`                               | The page                                                              |
| `GET /companion/healthz`                        | `{"ok":true}`                                                         |
| `GET /companion/api/now`                        | The current game, its matching guide and its live status line         |
| `GET /companion/api/guides`                     | Every guide hub with its platform (`?refresh=1` asks for a re-index)  |
| `GET /companion/api/guides/<hubId>`             | One hub's page tree                                                   |
| `GET /companion/api/guides/<hubId>/find?q=…`    | Lines in the hub's pages that contain the text (2–100 characters)     |
| `GET /companion/api/guides/<hubId>/marks`       | Names the hub's pages mark as missable                                |
| `GET /companion/api/guides/<hubId>/where`       | Guide headings that match the status line of the game being played    |
| `GET /companion/api/guides/<hubId>/progress`    | Ticked and total checkboxes per page (`?refresh=1` re-reads the wiki) |
| `GET /companion/api/achievements/<source>/<id>` | Achievements for a game that has a guide or is being played           |

Achievement requests are limited to games the service knows about, and the number of
upstream fetches per minute is capped, because the API keys are usually shared with other
tools. Guide page text is read from Outline at most a few times a minute and kept in memory. Search
and missable marks use a copy up to ten minutes old; while a page is open, the guide being
shown is read again about once a minute, and a few seconds after a tap inside a guide page, so
the checkbox counts stay current.

## Guide format

The service finds a game's guide by reading the guide documents themselves. It expects:

- The guides to be the direct children of one parent document (`OUTLINE_GUIDES_PARENT_ID`),
  each with its own sub-pages.
- A table row in each guide naming the game: `| Steam App ID | 1234 |` or
  `| RA Game ID | 5678 |` (the label may be bold; the number may be a link to the store or
  RetroAchievements page). A guide with neither row can still be opened by hand.
- Checkbox lines (`- [ ]` / `- [x]`) are what the sidebar counts. Headings are what the status
  line is matched against, so sections named for places or chapters work best.
- Optionally, a `⚠` on a checklist line (`- [ ] **Name** ⚠ …`) to mark that achievement as
  missable. RetroAchievements' own missable flag is used as well.
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
