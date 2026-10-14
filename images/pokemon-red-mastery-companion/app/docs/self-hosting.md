# Private hosting

Build with Node.js ≥24 (`npm ci && npm run build`) and serve `dist/` behind your existing private authentication/access controls. The application requires a browser with local storage, Web Crypto and File/ArrayBuffer support; use HTTPS or localhost. Keep the static app and save/progress routes under the same private origin. Upload/manual guide use needs neither endpoint.

The development server (`npm run dev -- --host 127.0.0.1`) and local preview (`npx vite preview --host 127.0.0.1 --port 4173`) do not implement a save route or the companion API. An unconfigured endpoint fails visibly and retains the previous observation. A fallback returning `index.html` is not a working binary-save endpoint.

## Automatic setup (`app-config.json`)

A private host can make the app load its save with no setup by serving a small JSON file next to `index.html`:

```json
{ "saveUrl": "./save", "companionUrl": "./companion/", "guideUrl": "https://wiki.example/your-guide" }
```

All three keys are optional. `saveUrl` and `companionUrl` must be same-origin relative paths (`./…` or `/…`); `guideUrl` must be `https://`. Anything else is ignored. Serve the file with `Content-Type: application/json` behind the same authentication as the app. The public GitHub Pages build contains no such file: its 404 (or an SPA fallback that answers with HTML) means manual-upload mode with no save or progress requests.

On startup the app reads the file once (five-second limit). When `saveUrl` is declared:

- The canonical main/Oak attempt adopts it when that attempt has no save address, and automatic refresh is turned on (30 seconds, focus and tab return). This also migrates an existing browser project in place: its observations, marks, choices and history are kept. The first import still applies the trainer-identity hold and continuity checks.
- An address the player set in **Advanced → Save address** is never replaced, and clearing it there (in this version) stays cleared. A canonical attempt from an earlier version that has no address is treated as never configured and adopts it. Glitch and speedrun attempts never receive the canonical address. A reset attempt adopts it again.
- **More → Your save → Reload automatically** turns automatic reload on or off without treating it as a new save source, so your marks are not sent for review.
- An adopted address is only requested where the private host declares it. A project restored on the public site (or where the config could not be read) keeps the address but makes no request; upload a save there instead.
- If the declared address changes later, an attempt that adopted the earlier deployment address follows it. Saving the same address in **Advanced → Save address** makes it the player's own, so it stops following.

When `companionUrl` is declared, **More → Hardcore progress → Connect** reads the account name the server reports and asks the player to confirm it; nothing is stored until they do. After confirmation, hardcore unlocks refresh on open, on tab return and every five minutes while the app is open (never more often). A different account name from the server is rejected and the last good data kept.

`guideUrl` adds a link to a private written guide on Next and More. Keep it out of the public build.

An expired sign-in (a redirect to the login page or a 401) shows **Signed out — reload to sign in** with a Reload button, and the last good save stays on screen. The message is cleared on the next successful page load. A web page returned with status 200 from the save route is reported as a possible sign-in problem or wrong address. Requests use `redirect: 'manual'` so they never follow the login redirect.

## Read-only save route

For an app mounted at `/red/`, configure a **private GET-only** `/red/save` URL serving your English Red 32,768-byte battery save. Declare it as `saveUrl` in `app-config.json`, or set the attempt’s address to `./save` under **More → Advanced → Save address**. Disable caching, return `application/octet-stream`, and exclude this exact route from the SPA fallback. Do not expose a directory listing or an unauthenticated public save URL.

Example Nginx location fragments (adapt the paths and integrate the existing authentication for **all** these locations; this is not a complete server configuration):

```nginx
location = /red/save {
    # Existing private auth/access middleware must apply here.
    alias /srv/read-only-emulator-mirror/red.srm;
    default_type application/octet-stream;
    add_header Cache-Control "no-store" always;
    limit_except GET { deny all; }
}
location /red/ {
    # Copy the build contents into /srv/www/red/.
    root /srv/www;
    try_files $uri $uri/ /red/index.html;
}
location /companion/ {
    # Existing private auth/access middleware must apply here too.
    proxy_pass http://your-existing-companion-service/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Use read-only permissions/mounts for the save mirror. The app issues GET requests only and never sends uploaded bytes or writes the source file. A manual upload is parsed entirely in the browser. Automatic URL refresh runs at least 30 seconds apart and on focus/tab return, with a 10-second timeout and no overlapping automatic requests. Upload cancels/invalidate pending URL imports and pauses automatic/focus refresh. **Reload now** (or **Reload from address now**) or saving changed source settings resumes it.

Each named app attempt has independent source settings and imported observations; a new attempt starts with no source. **Configure physically separate emulator storage for glitch and speedrun attempts.** Separate app names alone provide no isolation. Do not point fresh attempts at the canonical URL. A URL trainer-identity change is held; choose an existing intended attempt explicitly or discard/ignore the fingerprint. To use a new attempt, create it before selecting its upload/source.

## Companion progress proxy

With `companionUrl` in `app-config.json`, use **More → Hardcore progress → Connect hardcore progress** and confirm the reported account. Without it, in **More → Advanced → Account settings** configure the exact account identity emitted by the server and enter the companion **mount**, for example `/companion/`. The client appends:

```text
api/achievements/ra/724      # Main, 93 published achievements
api/achievements/ra/16084    # Professor Oak, 133
api/achievements/ra/11632    # Glitch Showcase, 8
```

Do not enter `/companion/api/` as the mount. The mount is on the same origin as the static app; the example proxy strips `/companion/` so an existing service listening at `/api/...` receives the intended route. If the upstream itself includes a mount, adjust the proxy accordingly. Never embed a RetroAchievements key in a build variable, browser URL or client configuration.

Prerequisites in the separately managed existing companion service:

- Accepted service implementation, restarted through its normal deployment process; allowlist `RA_ADDITIONAL_GAME_IDS=724,16084,11632`.
- Existing required server-only variables remain configured: `STEAM_API_KEY`, `STEAM_ID`, `RA_API_KEY`, `RA_USERNAME`, `OUTLINE_BASE_URL`, `OUTLINE_COLLECTION_ID`, `OUTLINE_GUIDES_PARENT_ID`. Keep any existing optional Outline authentication/configuration. None of these secret values belongs in this app.
- Server `RA_USERNAME` and the explicit project account identity must match exactly. Changing the project identity clears account feeds and preserves attempts, save observations and manual evidence.
- Independently verify the final authenticated deployed responses for all three paths, published membership/titles, `accountIdentity`, hardcore `unlockedAt`, and genuine last-successful `fetchedAt`. Local mock/service tests are not this acceptance gate.

Without a declared `companionUrl`, progress refresh is manual only; it never runs merely from entering a mount or opening the app. With a declared `companionUrl` it refreshes automatically only after the player has confirmed an account. Blank mount/identity means no request. Each feed has its own ten-second deadline covering the request and body parsing, so a stalled set cannot discard completed sets. Cancellation settles even if the transport ignores abort. A failed, malformed, denied, stale or drifted feed preserves that set’s prior successful data/time independently. A feed with no successful fetch is unknown, never confirmed zero. Manual observations and save registration do not change account unlocks.

The public app performs no deployment or authenticated final-route acceptance. Runtime target-core and achievement-trigger acceptance remains a separate release gate documented in the dataset and source notes.

## Backup and build behavior

The browser stores `pokemon-red-mastery-project-v1` in local storage. More exports a validated JSON project; imported/exported project files never contain original SRAM bytes. Keep that export before clearing browser data or moving hosts. Storage/parse/export errors show recovery UI and preserve live state. Reset clears one attempt and provides Undo; restoring or Undo cannot revive a pending encounter setup.

Production build uses supported Rolldown `codeSplitting.groups`. One large immutable rules JSON is partitioned into virtual Main/Oak/Glitch modules during the Vite build, preserving the curated source file and exported dataset contract. Game facts and area checklists have separate cacheable chunks. This is measured splitting; no warning thresholds are raised. The entry reports a recoverable load error if guide chunks are unavailable.
