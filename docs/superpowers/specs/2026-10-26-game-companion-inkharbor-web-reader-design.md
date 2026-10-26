# Inkharbor-derived web reader for Game Companion

Status: approved by the user on 2026-10-26, including the amendments below (browser-side Outline
access with the user's own session, in-list checkbox matching, 44px tap targets, phased scope).

## Intent and chosen direction

The user chose Inkharbor as the basis for adapting the Outline reading experience to the web, following a discussion of embedded Outline pages, external websites, and checklist interaction. The integration is an Inkharbor-derived reader within the existing Game Companion.

The result should make guides comfortable to read and check off on an iPhone or gaming handheld while retaining Outline as the content and progress source. Existing game detection, achievement tracking, Ask, pinned pages, and split layouts continue to work.

A specific motivation: ticking a checkbox in the framed Outline editor on iOS often takes several rapid taps. Likely causes (from the code, not measured on device): the checkbox sits inside a `contenteditable` editor, where iOS treats a tap as caret placement or selection (reader mode only suppresses the keyboard, `src/web/chrome.ts` `applyReader`); Outline's box is about 14px and the guide-size zoom scales the whole frame to 70–90%; and touches cross an iframe boundary. The reader removes all three.

## Approaches

1. Port the complete Inkharbor Expo app to the web. It already includes react-native-web, but its account storage, SQLite cache, biometrics, routing, and application screens require adaptation. The existing gaming interface would then need integration into a second application. This is a broader product than the requested guide improvement.
2. Adapt Inkharbor's browser renderer and checkbox-save logic inside Game Companion. Chosen: reuse the relevant source, retain the existing TypeScript web shell and Node backend, and replace the framed guide view.
3. Continue modifying Outline's iframe/editor. This would retain the reader-mode workarounds that motivated the change.

## Evidence

- Production Game Companion is v0.16.1, sourced from `images/game-companion` in this repository. `/config/game-companion` is an older prototype.
- The companion is served at `/companion/` on Outline's own hostname (README, "same hostname as Outline"). Outline is 1.12.0 with `FILE_STORAGE=local`, so attachments are served from that hostname too.
- Read-only API probes sampled 16 documents across four guide hubs. All returned structured document JSON and integer revision numbers using `x-api-version: 3`, where `documents.info` answers `{ data: { document: { data, revision, ... } } }`. Without the header it answers Markdown `text` and `revision`. The sample included tables, nested lists, hundreds of checkboxes, headings, and common inline marks. It was not a complete content audit.
- Outline 1.12.0 accepts cookie-authenticated API calls. Mutating calls with cookie auth need the double-submit CSRF token: cookie `__Host-csrfToken` (host-only, not HttpOnly, readable by same-origin JavaScript) echoed in the `x-csrf-token` header. Read-scoped calls such as `documents.info` are exempt (`server/middlewares/csrf.ts`).
- Outline's patch mode (`DocumentHelper.applyMarkdownToDocument`) finds the first occurrence of `findText` in the serialized Markdown. When the match lies within one top-level block it applies a surgical patch that keeps sibling nodes and their rich content. When the match spans several top-level blocks it re-parses those blocks from Markdown, which can drop content Markdown cannot express (comment marks, highlight colours, image sizes).
- Live test on 2026-10-26 against a private draft (created and permanently deleted, read back as 404), running Inkharbor's `setChecked` algorithm: a duplicate label in the same list, a nested item, a duplicate label across a heading, and an untick all changed only the intended `checked` attribute; a stale `lastRevision` returned 409 `document_conflict`. The cross-heading case used a two-block `findText`, so it took the re-parse path; it survived only because the test content was plain Markdown.
- Inkharbor v0.9.0 was inspected at commit `727246326625f25197ce5e0a9ba1f4f3fd318d5b`. Relevant files are `src/lib/editor/render-html.ts` (~200 lines), `src/lib/outline/documents.ts`, and `src/lib/outline/edits.ts` (~170 lines). The HTML renderer emits display-only checkbox markup; native checkbox controls are separate.
- Most of the work is in the companion, not the port: `src/web/main.ts` (1,681 lines), `frames.ts`, `locate.ts`, `chrome.ts`, and the device zoom assume framed Outline pages.

## First version

### Reading

Adapt the upstream HTML rendering rules for structured Outline documents into a scoped companion reader. Use the existing TypeScript/DOM build; this subset does not require Expo, React Native, or a new application framework.

Support headings and stable anchors, paragraphs and inline marks, ordered/bullet/check lists, nested lists, tables with horizontal scrolling, code, quotes, notices, collapsible sections, images, emoji, and reference cards. Render unknown node children when possible and provide an explicit unsupported-content notice with an Outline link for opaque nodes. Mathematical expressions may initially show their source with an Outline fallback; typeset mathematics is not required for this first version and was not observed in the sample.

The port must not copy upstream URL handling unchanged: escaping HTML alone does not make a URL safe. Validate link and image destinations, scope CSS to the reader, use semantic checkbox controls, clamp numeric attributes, and remove the upstream process-global image map in favor of per-document rendering context. Preserve the application's Content Security Policy; do not add unrestricted inline scripts or styles to accommodate the renderer. Notice tints become classes, not inline styles.

Guide text size controls change the reader's font size rather than scaling a whole framed application. Restore reading position and collapsed sections by document identity. Maintain existing pins and slot identities without migrating browser storage keys. Keep a "Show in Outline" option per slot as a fallback while establishing content parity.

### Guide navigation and existing features

A guide slot shows the reader for known guide documents. URLs and IDs are resolved from the server's guide index, including the hub document itself. Internal links to known guides open inside the reader; links to other Outline documents open Outline, preserving its access checks. Heading links, Find in guide, and status-based guide jumps must operate inside the selected reader and open collapsed ancestors when needed.

Retain the existing achievements, game switching, Ask streaming, sidebar counts, and multi-pane behavior. Scope searching/highlighting to the active reader so duplicate headings in another slot cannot receive the jump. Document loads are cancelable; a response for a previously selected game must not replace the current view.

Notes and other editable pages stay in the framed Outline view with a clearly visible Edit in Outline action. A new general-purpose document editor is outside this version.

### Checkboxes

Checkbox state remains in Outline. Manual marks remain separate from confirmed platform achievement awards.

**Touch target.** One tap toggles. Each checkbox has a hit area of at least 44×44 CSS px down the item's leading edge, independent of the visible box size and of the guide text size. The rest of the row is not a toggle, because items often contain links and a whole-row target causes accidental ticks while scrolling. The control shows a pending state immediately and settles when the save is confirmed.

**Write path.** The browser calls Outline's API directly, same-origin, with the user's own Outline session: `documents.info` (read-scoped, no CSRF token) and `documents.update` with `x-csrf-token` read from the `__Host-csrfToken` cookie. No writer API key is provisioned, and no server write endpoint or Outline proxy is added. Edits appear in Outline history as the user. Outline's own permissions are the access control; the companion only offers ticking on documents in the guide index. That is a UI restriction, accepted because the companion page already has same-origin reach into Outline through its frames. When the session is missing or expired (401/403, or no CSRF cookie), the reader stays readable and shows a "Sign in to Outline" action; it never shows an unsaved tick as saved.

**Matching.** Adapt Inkharbor's `setChecked` into the web code:
- Fetch the current Markdown and revision. Require that revision to match the rendered one, the checkbox count to match the structured document, and the target's current state to match what was shown.
- Build `findText` from the target line widened to neighbouring lines (following first, then preceding) **only within the same top-level block**, meaning no blank line inside `findText`, until it occurs exactly once in the Markdown.
- If no in-block window is unique, refuse the tick ("Tick this in Outline") rather than widen across blocks.
- Send `editMode: "patch"` with `lastRevision`. Never send a whole-document replace.

Duplicate labels across areas ("Potion" in every area) are normal in game guides, which is why the window looks at following lines before refusing.

**Flow.** Serialize writes per document and show the pending state. On 409, refresh that document and ask for the tap again; do not replay an old index against a new revision. A network failure after submission is ambiguous: re-read before offering a retry. Read back the document after the write and render that revision before reporting success. Then call the existing `GET /companion/api/guides/<hubId>/progress?refresh=1` so the sidebar count updates. Other visible copies of the same document refresh after the write; keeping their scroll position is best-effort in this version.

### Backend and assets

The reader needs no new server endpoint: guide documents load in the browser through same-origin `documents.info` (x-api-version 3) with the user's session, after resolving IDs from the existing guide index. The server keeps its read-only key for the guide index, search, progress, Ask, and MCP.

Images: Outline attachment URLs (`/api/attachments.redirect?id=…`) are same-origin and load with the session cookie; with local storage, the redirect stays on the same host, so `img-src 'self'` covers them. If storage moves off-host later, the CSP needs that host added. External `https:` images get a visible "open image" link fallback rather than widening `img-src`. The CSP's `connect-src 'self'` already allows `/api/*`.

Keep data requests network-backed. The existing service worker is scoped to `/companion/` and must not cache Outline API responses. Offline guide downloads and queued edits are deferred.

### External resources

Reference links and embed cards inside a rendered guide open in a separate browser tab with `rel="noopener noreferrer"`. They do not attempt to circumvent a site's framing policy. Preserve existing user-added links and their current iframe option; redesigning the resource picker is a separate change.

## Phasing

1. Reader for guide documents with live checkboxes, the Outline fallback toggle, find/jump/text size in the reader, and the 44px targets.
2. Later: cross-slot revision adoption that keeps scroll position, typeset maths, offline guides.

## Source attribution and maintenance

Vendor only the adapted modules/data that are actually used. Include Inkharbor's MIT notice, pinned source commit, original file paths, and a short record of intentional differences. Preserve additional notices for any imported emoji data or other third-party material. Do not copy the entire native application or auto-update this code without reviewing upstream changes.

## Validation and acceptance

Use synthetic public fixtures; do not commit private guide content, identifiers, account data, or credentials.

- Rendering fixtures cover the supported node types, long tables/lists, nested and repeated checklist labels, malformed attributes, unsafe URLs, and unknown nodes.
- Checkbox-matching unit tests cover duplicates within a list, duplicates across areas (resolved by following lines), a duplicate with no unique in-block window (refused), nested items, quoted items, code fences, a count mismatch, and a state mismatch.
- Client API tests cover the version-3 wrapper, the CSRF header, missing/expired sessions, 409 conflicts, an ambiguous failure after submission, and the read-back.
- Preservation check: a checkbox operation changes only its intended state; headings, other checkboxes, media attributes, and unrelated annotations remain intact.
- Existing companion tests, type checking, lint, formatting, and the production build must pass. Add regression coverage for pins, split panes, game-switch races, guide search, status jumps, and sidebar counts where the new view touches them.
- Browser checks at phone and handheld viewport sizes must demonstrate reading, scrolling a wide table, navigating a heading, checking a box, handling a conflict, opening a note in Outline, and returning to the same reading position.
- On a real iPhone, a single tap toggles a checkbox at every guide text size. Real-device Safari verification is a separate claim from automated emulation.
- Before enabling on real guides, repeat the live write test against a disposable draft through the browser path (session cookie plus CSRF), not only with an API key.

The deliverable is an implementation branch and reviewable preview with test evidence. Deployment and making the reader the default are release steps after review.

## Implementation choices left to the builder

Choose module names, cache sizes, small UI details, and test organization using current project conventions. Keep the first version within phase 1. Reopen the design only if a verified upstream constraint prevents preserving content or the existing companion behavior.

## Sources

- Inkharbor: https://github.com/tahsinrefat22/inkharbor/tree/727246326625f25197ce5e0a9ba1f4f3fd318d5b
- HTML renderer: https://github.com/tahsinrefat22/inkharbor/blob/727246326625f25197ce5e0a9ba1f4f3fd318d5b/src/lib/editor/render-html.ts
- Checkbox writes: https://github.com/tahsinrefat22/inkharbor/blob/727246326625f25197ce5e0a9ba1f4f3fd318d5b/src/lib/outline/edits.ts
- Outline update contract: https://github.com/outline/outline/blob/v1.12.0/server/routes/api/documents/schema.ts
- Outline patch mode: https://github.com/outline/outline/blob/v1.12.0/server/models/helpers/DocumentHelper.tsx
- Outline CSRF: https://github.com/outline/outline/blob/v1.12.0/server/middlewares/csrf.ts
