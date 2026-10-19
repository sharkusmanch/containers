# game-companion

A page for a handheld's small second screen. It works out which game is being played and
puts that game's guide pages and achievement progress one tap apart.

A small Node service polls Steam and RetroAchievements for the current game, indexes guide
documents in an Outline wiki by the `Steam App ID` or `RA Game ID` row in each guide, and
serves a read-only JSON API together with a static front end. The front end is a thin
sidebar that frames real Outline pages and shows an achievements panel.

From an achievement, **Find in guide** searches the game's guide pages and opens the page at
that line. **Ask how** sends `How do I get "<name>"? <description>` to Ask at hint depth (hidden
achievements: only once revealed). Achievements the guide marks as missable can be shown on
their own, and a notice appears when an achievement unlocks while the page is open. While a
RetroAchievements game is being played, a row under the title shows the status line the game
reports (its rich presence); a tap on it shows a long line in full. When that line names a place
or chapter that is also a heading in the guide, a button beside it opens the guide at that
section (with several matching sections it lists them); **Guide jump from status** under
⋯ › Display turns this off. The page can be added to the home screen and then opens full
screen; it keeps the screen on and hides Outline's own sidebar and top bar inside the guide frames. Both can be
switched off under ⋯ › Display. **Guide text size** there draws the framed guide pages at 90,
80 or 70 per cent, for a small screen; it enlarges the frame and scales it down, so the guide
lays out in a wider window as it would under browser zoom.

**Reader mode** (⋯ › Display, on by default) lets you read a guide page and tick its
checkboxes on a touch screen without the on-screen keyboard coming up: the framed page's
editable areas are marked so the browser shows no keyboard for them. Pages meant for typing
are exempt by title, set with `EDITABLE_PAGES`.

Besides the guide's pages, each game can have **links of your own**: other web pages (a
planner, a map, a wiki) added under ⋯ › Pages › Your links and pinned to the sidebar like a
guide page. They are stored in the browser on that device, per game, and the server never sees
them. A link must be an `https` address; it is shown in a sandboxed frame that cannot take
over the page, and a site that refuses to be framed can be opened in a new tab from the same
row. Add only sites you trust: a framed site draws its page under this page's address.

Each pinned page's sidebar button shows how many of its checkboxes are ticked (`done/total`,
or a percentage when that is longer than six characters); the count follows a tick made in the
guide page within a few seconds. RetroAchievements achievements on the story path carry a
**Story** chip and the one for beating the game an **Ending** chip, and a **Story** switch
narrows the list to them. The page refreshes at once when it is shown again or the network
returns.

## Upstream

- **Repository**: none. This directory is the source.
- **Version**: v0.15.0

## Usage

```bash
docker run --rm -p 8080:8080 \
  -e STEAM_API_KEY=... -e STEAM_ID=... \
  -e RA_API_KEY=... -e RA_USERNAME=... \
  -e OUTLINE_BASE_URL=https://outline.example.com \
  -e OUTLINE_API_KEY=... \
  -e OUTLINE_COLLECTION_ID=... -e OUTLINE_GUIDES_PARENT_ID=... \
  ghcr.io/sharkusmanch/containers/game-companion:v0.15.0
```

The page is served at `/companion/` and must be reached on the **same hostname as Outline**
(route `/companion` on Outline's hostname to this container). Outline only allows itself to
be framed by its own origin, so the guide frames stay blank on any other hostname.

The container has no sign-in of its own: put it behind the sign-in proxy of the ingress in
front of it, which redirects the page to sign in and answers an expired API request with 401.
When an API request gets a 401, the page shows **Signed out — tap to sign in** across the top
and stops polling; a tap reloads the page, which goes through the sign-in again. Every endpoint
is read-only except `POST /companion/api/ask`, which runs a question on the agent (see **Ask
assistant**), `POST /companion/api/xbox/<action>`, which starts or ends the Xbox sign-in (see
**Xbox**), and `POST /companion/mcp`, which only the agent may reach. Put it only where
everyone who can reach it may see what is being played, achievement progress, checklist counts
and the text of the guide pages: the guide search returns headings and matching lines from
them, although Outline itself requires a sign-in. The page's Content-Security-Policy allows
frames from itself and from any `https` address, so that links added on a device can be shown;
nothing but an address typed on that device is ever framed.

## Environment Variables

| Variable                   | Required | Description                                                                                                                                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STEAM_API_KEY`            | Yes      | Steam Web API key                                                                                                                                                                          |
| `STEAM_ID`                 | Yes      | SteamID64 of the account to watch                                                                                                                                                          |
| `RA_API_KEY`               | Yes      | RetroAchievements Web API key                                                                                                                                                              |
| `RA_ADDITIONAL_GAME_IDS`   | No       | Comma-separated positive integer RA game IDs allowed without a guide or detector history; empty by default. For Red: `724,16084,11632`. Uses the general fetch budget.                     |
| `RA_USERNAME`              | Yes      | RetroAchievements user to watch                                                                                                                                                            |
| `OUTLINE_BASE_URL`         | Yes      | Base URL of the Outline instance, without a trailing slash                                                                                                                                 |
| `OUTLINE_COLLECTION_ID`    | Yes      | ID of the Outline collection that holds the guides                                                                                                                                         |
| `OUTLINE_GUIDES_PARENT_ID` | Yes      | ID of the document whose children are the guide hubs                                                                                                                                       |
| `OUTLINE_API_KEY`          | No       | Read-only Outline API key. Without it the guide index is disabled                                                                                                                          |
| `OUTLINE_SCHEDULE_DOC_ID`  | No       | ID of a document whose `## Now Playing` section lists games to show first                                                                                                                  |
| `DEFAULT_PINNED_PAGES`     | No       | Comma-separated guide page titles to pin the first time a game is opened                                                                                                                   |
| `EDITABLE_PAGES`           | No       | Comma-separated guide page titles that stay typeable in reader mode (for example a notes page)                                                                                             |
| `AGENT_URL`                | No       | Base URL of the Claude Code agent service (for example `http://companion-agent:8080`). Ask is on only when this and `AGENT_TOKEN` are set; otherwise `/api/now` reports `assistant: false` |
| `AGENT_TOKEN`              | No       | Bearer token the agent service requires                                                                                                                                                    |
| `ASSISTANT_PER_MINUTE`     | No       | Questions admitted per rolling minute, all callers together (default `10`)                                                                                                                 |
| `ASSISTANT_PER_DAY`        | No       | Questions admitted per calendar day in `TZ` (default `150`)                                                                                                                                |
| `COMPANION_MCP_TOKEN`      | No       | Bearer token for `POST /companion/mcp`, the guide and status tools the agent calls. Without it that endpoint answers 404                                                                   |
| `XBOX_CLIENT_ID`           | No       | Application (client) ID of your own Microsoft Entra app for Xbox Live (see **Xbox**). Without it Xbox is off                                                                               |
| `XBOX_STATE_DIR`           | No       | Writable directory for the Xbox sign-in and each guide's last platform (default `/data`); keep it on a persistent volume                                                                   |
| `PORT`                     | No       | Listening port (default `8080`)                                                                                                                                                            |
| `STATIC_DIR`               | No       | Directory of the built front end (default `/app/dist/web`)                                                                                                                                 |

The Outline key needs only these scopes:
`/api/documents.list /api/documents.info /api/collections.documents`.

## Endpoints

| Path                                            | Returns                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /companion/`                               | The page                                                                    |
| `GET /companion/healthz`                        | `{"ok":true}`                                                               |
| `GET /companion/api/now`                        | The current game, its matching guide and its live status line               |
| `GET /companion/api/guides`                     | Every guide hub with its platform (`?refresh=1` asks for a re-index)        |
| `GET /companion/api/guides/<hubId>`             | One hub's page tree                                                         |
| `GET /companion/api/guides/<hubId>/find?q=…`    | Lines in the hub's pages that contain the text (2–100 characters)           |
| `GET /companion/api/guides/<hubId>/marks`       | Names the hub's pages mark as missable                                      |
| `GET /companion/api/guides/<hubId>/where`       | Guide headings that match the status line of the game being played          |
| `GET /companion/api/guides/<hubId>/progress`    | Ticked and total checkboxes per page (`?refresh=1` re-reads the wiki)       |
| `GET /companion/api/achievements/<source>/<id>` | Achievements for a game that has a guide or is being played                 |
| `GET /companion/api/xbox`                       | The Xbox sign-in: state, and the code, gamertag or expiry that goes with it |
| `POST /companion/api/xbox/<action>`             | `connect`, `cancel` or `disconnect` the Xbox sign-in; answers the new state |
| `POST /companion/api/ask`                       | Streams an answer to a question about a game (newline-delimited JSON)       |
| `POST /companion/mcp`                           | MCP tools for the agent: game status and the player's guides (bearer token) |

## Xbox

Xbox Live is a second source after Steam: games started from the Xbox app on a PC or handheld
(Game Pass included) and everything on an Xbox console. When Steam reports no game, the game
Xbox reports gets the same guide pages, achievements panel, Missable, Find in guide and Ask as
a Steam game. The detection order is Steam (a game with an app ID), then Xbox, then a fresh
RetroAchievements game, then a Steam non-Steam shortcut, then the last game seen. Only genuine
Xbox Live games count: a program the Xbox app happens to report (a Steam game, an emulator, a
launcher) or an app (titles Xbox lists as anything but a game) never hides a RetroAchievements
game.

**Setting up.** Register an app in Microsoft Entra under your own account ("Personal Microsoft
accounts only", public client flows allowed, no secret, no redirect URI) and set its client ID
as `XBOX_CLIENT_ID`. Then open ⋯ › Display › Xbox and tap **Connect**: the row shows a code to
enter at `microsoft.com/link` (the link opens in a new tab; the code lasts 15 minutes and
**Cancel** drops it). The row reads "Xbox: connected as <gamertag>" once you have signed in, and
**Disconnect** deletes the stored sign-in (if the file cannot be deleted the row stays connected
and the page says "Couldn't disconnect"). "Xbox: connect again" means Microsoft no longer
accepts it (revoked, expired or refused); **Connect** signs in again. Steam and
RetroAchievements keep working throughout. Starting, cancelling or ending a sign-in takes the
Ask route's checks (`Content-Type: application/json`, `Origin` of `OUTLINE_BASE_URL`, a JSON
object body); without `XBOX_CLIENT_ID` those routes answer 404 and `GET /api/xbox` reports
`off`.

**What is read.** Read only, for the signed-in account: its presence (the game being played,
on which device, and the game's status line when it sets one) every 30 seconds while connected;
its title history, once a day per game, to tell an Xbox Live game from a plain PC program; and
the achievements of the game on screen. Nothing is ever written to Xbox Live. The sign-in is a
refresh token in `XBOX_STATE_DIR/xbox-token.json` (mode 0600, replaced atomically each time
Microsoft rotates it); no token or device code ever reaches the page, a log line or the
assistant. The page sees only the sign-in state, the code and link to enter it, its expiry and
the gamertag. If `XBOX_STATE_DIR` cannot be written, start-up logs it once as
`xbox state directory is not writable`.

**Guides.** One guide serves a game on both Steam and Xbox. A guide is linked to an Xbox game by
an `Xbox Title ID` row, or else by its title matching the game's name (case, punctuation and ™ ®
© ignored); a guide with only an `RA Game ID` row never matches by name, nor does a guide already
tied to another Xbox title (by its row or an earlier detection), and two guides with the same
name link to neither. The guide remembers which platform its game was last detected on (in
`XBOX_STATE_DIR/platforms.json`), and the achievements panel shows that platform when the game
is not being played. When a guide knows both a Steam and an Xbox ID, a **Steam / Xbox** switch
above its achievements picks the other one; the choice is kept per device. The game list labels
each guide "Steam", "Xbox" or "Steam + Xbox", and the device ("Series X", "PC") shows beside the
title while an Xbox game is being played.

**The panel.** Xbox achievements show their Gamerscore, their rarity, and progress counters
(`3/10`) where the game has them; the header adds Gamerscore earned out of the total. Secret
achievements stay hidden until tapped, like Steam's. A game with Gamerscore but no list from
Xbox Live (Xbox 360 back-compat titles) shows "No Xbox achievements list for this game yet."

**Limits.** One Xbox account. A game shows up about a minute after it starts. Xbox 360 back-compat
achievement lists, friends and Xbox Cloud Gaming are not covered. A rate-limited or failing
Xbox Live backs off (honouring `Retry-After`) and leaves Steam and RetroAchievements detection as
it was.

## Ask assistant

`POST /companion/api/ask` takes `{hubId, game, history, question, depth}` (a JSON body of at
most 32 KiB; `hubId` or `game` may be `null`, not both; the question is 1-1,000 characters, up to
10 earlier turns) and streams one JSON event per line (`search`, `lookup`, `text`, `done`,
`error`, and `ping` to keep a quiet answer open) as `application/x-ndjson`.

The question is answered by a separate Claude Code agent service at `AGENT_URL`. The companion
posts it to `<AGENT_URL>/ask` with `authorization: Bearer <AGENT_TOKEN>` and the JSON body
`{instructions, statusBlock, history, question, depth, hub}`: the answering rules, a status
block (the game, the play state, the status line, achievement progress with the missables
still open and the next story achievements, and the guide section matching the status line),
the earlier turns, the question, the depth (`hint` or `full`) and the id of the game's guide
(`null` for a game with no guide). No guide text is sent: the agent reads the guide through the
companion's MCP endpoint (`companion_status`, `list_guides`, `guide_outline`, `search_guide`,
`read_guide_page`), and also has read-only RetroAchievements, RomM, Syncthing and Outline
tools, web search and fetch, and a shell for its skills.

The agent's answer streams through as it comes. Only well-formed events of the known types
pass; anything else, and the agent's own pings, is dropped. A busy agent (its 429) gets the
browser a 429 with `limit: "minute"` and `Retry-After: 30`. An agent that cannot be reached,
answers any other error, sends no response headers within 20 seconds, or ends without `done`
or `error` gets one error event: "The assistant is unavailable right now. Try again in a
minute." When the browser goes away, the request to the agent is aborted.

Each lookup shows above the answer as one line, as the agent labels it (for example
`Searched your guide: <query>`, `Read guide: <page>`, `Searched the web: <query>` or
`Opened: <host>`). Lookup lines are not kept in the saved conversation.

Requests are checked in this order, each failing before any later work: `Content-Type` must be
`application/json` (415); `Origin` must be the origin of `OUTLINE_BASE_URL` (403); the body must
fit (413); the assistant must be configured (503); the body must validate and name a known
hub and a game that may be looked up (400); the rate limit must admit it (429, with
`Retry-After`). A question refused by any of these checks is not counted, but one the limit
admits is counted even if the agent then turns it away as busy (its 429): that refusal still
counts toward the per-minute and per-day limits. When a hub has a game of its own, a `game`
sent with it is ignored. This route reads only those three request headers.

Limits: `ASSISTANT_PER_MINUTE` and `ASSISTANT_PER_DAY` are counted in memory for the whole
service, not per caller, so a restart resets them; the agent also takes only a few questions
at once. Question and answer text is never logged: the one log line per question carries the
outcome (`done`, `error`, `busy`, `unavailable` or `aborted`), the agent's HTTP status or the
failure kind when there is one, and the duration.

RA responses include the configured `accountIdentity` and the last successful upstream
`fetchedAt` timestamp. Stale cache reads and failed retries preserve that timestamp;
`stale` describes the individual game feed. Each Red set is fetched and cached separately.
Malformed or impossible hardcore earned dates remain locked with no unlock timestamp.
These fields are additive; Steam responses keep their existing shape.

Achievement requests are limited to games the service knows about or explicitly allowlisted
RA IDs, and the number of
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
  RetroAchievements page). A guide with neither row can still be opened by hand. A guide may
  also carry `| Xbox Title ID | 1234567890 |` to link it to the Xbox game explicitly (see
  **Xbox**).
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
