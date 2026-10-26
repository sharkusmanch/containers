# Game Companion Guide Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show guide pages in a companion-rendered reader (from Outline's structured JSON) with one-tap checkboxes saved to Outline, instead of framing Outline's editor.

**Architecture:** A new slot kind, `"reader"`, sits beside the existing `"doc"` (framed Outline) and `"link"` kinds inside `createFrames`, so `main.ts` keeps its slot logic. The reader fetches documents and saves ticks straight from the browser to Outline's same-origin `/api/`, using the user's session cookie and CSRF header. Pure modules (`guide-checkbox`, `guide-render`, `guide-tick`) carry the logic. `reader.ts` is a thin DOM layer over them.

**Tech Stack:** TypeScript 6 compiled by `tsc` to browser ES modules (no bundler, no runtime npm dependencies in `src/web`), Vitest 5 with jsdom, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-10-26-game-companion-inkharbor-web-reader-design.md`

All paths below are relative to `images/game-companion/` unless they start with `docs/`. Run every command from `images/game-companion/`.

## Global Constraints

- No new runtime dependencies; `src/web` imports only relative modules. Imports use `.js` suffixes (NodeNext).
- CSP is unchanged: no inline scripts, no `style=""` attributes in rendered HTML (notice tints are classes).
- Outline calls: `POST /api/documents.info` with `x-api-version: 3` (answer `data.document`: `id, title, url, revision, data`), `POST /api/documents.info` without the header for Markdown (`data.text`, `data.revision`), and `POST /api/documents.update` with `x-api-version: 3`, `editMode: "patch"`, `findText`, `text`, `lastRevision`, plus the `x-csrf-token` header. All use `credentials: "same-origin"`.
- CSRF cookie: `__Host-csrfToken`, falling back to `csrfToken` (plain-HTTP dev).
- Never send `editMode: "replace"`, and never send a `findText` containing a blank line (`"\n\n"`, or a line that is empty or whitespace only).
- The checkbox hit area is at least 44×44 CSS px, on the item's leading edge only, at every guide text size.
- Guide text size in the reader is `font-size` (100/90/80/70%), never `transform: scale`.
- No private guide content, IDs or credentials in fixtures; use synthetic documents.
- Inkharbor source: MIT, commit `727246326625f25197ce5e0a9ba1f4f3fd318d5b`; record adapted files in `THIRD-PARTY-NOTICES.md`.
- Content audit (2026-10-26, 724 guide pages): node types seen are text, paragraph, table/tr/th/td, checkbox_list/item (35,550 items, max 908 on one page), list_item, heading, bullet/ordered_list, hr, blockquote, emoji (only `star`, `warning`, `white_check_mark`), code_block, container_notice, embed. Marks: strong, em, code_inline, link, strikethrough. No images, maths, toggles or attachments.
- Not built, because nothing needs it: refreshing other slots showing the same page (`assignSlot` keeps a page in one slot), and remembering collapsed sections (no guide has a toggle).
- Release is v0.17.0 (`package.json`, `Dockerfile` `GAME_COMPANION_VERSION`, `README.md` version lines).

## Review Focus

1. **A tick saved by a request that timed out on the client.** Outline applied it but the browser saw a failure. Expected: re-read shows the tick as saved, not an error and a duplicate retry (Task 3 test `treats a failed request that did land as saved`).
2. **A label repeated across areas ("Potion" under every area heading).** Expected: the right item is ticked by widening to following lines inside its own list; never a cross-block match (Task 1 tests).
3. **Session expired while the reader stays open.** Expected: reading still works from the loaded copy; the tap shows "Sign in to Outline to tick boxes." and the box reverts (Task 3 `signed-out`, Task 5 test).
4. **Two quick taps on different boxes.** Expected: both save, in order, each against the revision the previous one produced; neither is dropped or sent against a stale revision (Task 5 `queues a second tap until the first is saved`).
5. **Switching game or slot while a page is loading.** Expected: the late answer for the old page never replaces the current one (Task 5 `ignores a load answer for a page it has left`).

---

### Task 1: Checkbox matching

**Files:**
- Create: `src/web/guide-checkbox.ts`
- Test: `test/web-guide-checkbox.test.ts`

**Interfaces:**
- Produces:
  - `export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string }`
  - `export function checkboxItems(node: PMNode): PMNode[]`: every `checkbox_item`, document order.
  - `export function checkboxLines(markdown: string): { line: number; checked: boolean }[]`: lines matching `/^(?:\s*>\s?)*\s*- \[([ xX])\] /` outside ``` / ~~~ fences (Inkharbor's rule).
  - `export type PatchPlan = { ok: true; findText: string; text: string } | { ok: false; reason: "count" | "state" | "ambiguous" }`
  - `export function planCheckboxPatch(markdown: string, structuredCount: number, index: number, shownChecked: boolean, checked: boolean): PatchPlan`

- [ ] **Step 1: Install dependencies in the worktree**

Run: `npm ci && npx vitest run test/web-state.test.ts`
Expected: install succeeds; existing test passes.

- [ ] **Step 2: Write the failing tests**

```ts
const MD = [
  "## Area One", "", "- [ ] Potion", "- [ ] Ether", "- [ ] Potion", "  - [ ] Nested",
  "", "## Area Two", "", "- [ ] Potion", "- [x] Done", "",
  "```", "- [ ] not a box", "```",
].join("\n");

it("finds checkbox lines outside code fences, in order", () => {
  expect(checkboxLines(MD).map((l) => l.line)).toEqual([2, 3, 4, 5, 9, 10]);
  expect(checkboxLines(MD)[5]?.checked).toBe(true);
});
it("lists checkbox_item nodes depth-first", () => { /* nested list inside an item → parent before child */ });
it("patches a unique line on its own", () => {
  expect(planCheckboxPatch(MD, 6, 1, false, true))
    .toEqual({ ok: true, findText: "- [ ] Ether\n", text: "- [x] Ether\n" });
});
it("widens a duplicate to the following line first", () => {
  expect(planCheckboxPatch(MD, 6, 4, false, true)).toEqual({
    ok: true, findText: "- [ ] Potion\n- [x] Done\n", text: "- [x] Potion\n- [x] Done\n" });
});
it("widens to the preceding line when the item ends its list", () => {
  const tail = "- [ ] X\n- [ ] Potion\n\npara\n\n- [ ] Y\n- [ ] Potion\n";
  expect(planCheckboxPatch(tail, 4, 1, false, true))
    .toEqual({ ok: true, findText: "- [ ] X\n- [ ] Potion\n", text: "- [ ] X\n- [x] Potion\n" });
});
it("refuses when no window inside the block is unique", () => {
  const twin = "- [ ] A\n- [ ] B\n\ntext\n\n- [ ] A\n- [ ] B\n";
  expect(planCheckboxPatch(twin, 4, 0, false, true)).toEqual({ ok: false, reason: "ambiguous" });
});
it("refuses a count mismatch", () => expect(planCheckboxPatch(MD, 7, 0, false, true)).toEqual({ ok: false, reason: "count" }));
it("refuses when the box is not in the state shown", () =>
  expect(planCheckboxPatch(MD, 6, 5, false, true)).toEqual({ ok: false, reason: "state" }));
it("never returns a findText with a blank line", () => {
  for (let i = 0; i < 6; i++) {
    const plan = planCheckboxPatch(MD, 6, i, i === 5, i !== 5);
    if (plan.ok) expect(plan.findText).not.toMatch(/\n\s*\n/);
  }
});
it("patches the last line of a document without a trailing newline", () => {
  expect(planCheckboxPatch("- [ ] A\n- [ ] B", 2, 1, false, true))
    .toEqual({ ok: true, findText: "- [ ] B", text: "- [x] B" });
});
it("keeps a quoted item's quote marks", () => { /* "> - [ ] Q" → text "> - [x] Q" */ });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/web-guide-checkbox.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/web/guide-checkbox.ts`**

Window algorithm for `planCheckboxPatch` (the tests above pin it):

```
k = checkboxLines(md)[index].line; lo = hi = k
piece(lo, hi, replaced?) = lines[lo..hi] joined by "\n" (line k swapped for `replaced`) + ("\n" if hi < lines.length - 1)
occurrences = overlapping indexOf count over the whole markdown
loop:
  if occurrences(piece(lo, hi)) === 1 → ok
  else if hi + 1 < lines.length && lines[hi + 1].trim() !== "" → hi += 1
  else if lo > 0 && lines[lo - 1].trim() !== "" → lo -= 1
  else → ambiguous
edited line = lines[k] with its first "- [ ] " / "- [x] " / "- [X] " swapped for "- [x] " or "- [ ] "
```

Check `count` (lines vs `structuredCount`) and then `state` (`checkboxLines[index].checked !== shownChecked`) before matching. Header comment credits Inkharbor `src/lib/outline/edits.ts` and states the in-block difference.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/web-guide-checkbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/guide-checkbox.ts test/web-guide-checkbox.test.ts
git commit -m "feat(game-companion): match a guide checkbox to a single-block Outline patch"
```

### Task 2: Browser Outline client

**Files:**
- Create: `src/web/outline-api.ts`
- Test: `test/web-outline-api.test.ts`

**Interfaces:**
- Consumes: `PMNode` (Task 1).
- Produces:
  - `export interface GuideDocument { id: string; title: string; url: string; revision: number; data: PMNode }`
  - `export type OutlineErrorKind = "signed-out" | "conflict" | "not-found" | "other"`
  - `export class OutlineError extends Error { constructor(readonly status: number, readonly kind: OutlineErrorKind) }`
  - `export function csrfToken(cookie: string): string | null`
  - `export interface OutlineApi { document(id: string, signal?: AbortSignal): Promise<GuideDocument>; markdown(id: string): Promise<{ text: string; revision: number }>; patch(id: string, edit: { findText: string; text: string; lastRevision: number }): Promise<void> }`
  - `export function createOutlineApi(deps: { fetch: typeof fetch; cookie: () => string; timeoutMs?: number }): OutlineApi`, default timeout 10 000 ms.

- [ ] **Step 1: Write the failing tests**

Use a recording fake `fetch`. Assert:
- `document("abc")` POSTs `/api/documents.info` with body `{"id":"abc"}`, headers `content-type: application/json` and `x-api-version: 3`, and `credentials: "same-origin"`. It returns `data.document` narrowed to `GuideDocument`. A missing `data`, or a non-integer `revision`, throws `OutlineError(200, "other")`.
- `markdown("abc")` sends no `x-api-version` header and returns `{ text, revision }`.
- `patch` sends `{ id, editMode: "patch", findText, text, lastRevision }` with `x-api-version: 3` and `x-csrf-token` taken from the cookie `__Host-csrfToken=tok.sig; other=1`.
- `csrfToken("csrfToken=a.b")` → `"a.b"`; `csrfToken("x=1")` → `null`; values are URI-decoded.
- `patch` with no CSRF cookie rejects with `OutlineError(0, "signed-out")` and makes no request.
- Status mapping: 401 and 403 → `signed-out`; 409 → `conflict`; 404 → `not-found`; 500 → `other`. A network error or timeout → `OutlineError(0, "other")`.
- `document(id, signal)`: aborting the signal rejects with the abort error, not an `OutlineError`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web-outline-api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/web/outline-api.ts`**

Follow `src/web/api.ts` for the timeout style (an `AbortController` per request, combined with the caller's signal).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/web-outline-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/outline-api.ts test/web-outline-api.test.ts
git commit -m "feat(game-companion): same-origin Outline client for the guide reader"
```

### Task 3: Tick flow

**Files:**
- Create: `src/web/guide-tick.ts`
- Test: `test/web-guide-tick.test.ts`

**Interfaces:**
- Consumes: `checkboxItems`, `planCheckboxPatch` (Task 1); `OutlineApi`, `GuideDocument`, `OutlineError` (Task 2).
- Produces:
  - `export type TickResult = { kind: "saved"; doc: GuideDocument } | { kind: "conflict"; doc: GuideDocument } | { kind: "refused"; reason: "count" | "state" | "ambiguous" } | { kind: "signed-out" } | { kind: "failed"; doc: GuideDocument | null }`
  - `export async function tick(outline: OutlineApi, shown: GuideDocument, index: number, checked: boolean): Promise<TickResult>`

- [ ] **Step 1: Write the failing tests** against a fake `OutlineApi` holding `{ md, doc }`:
- `saves and returns the read-back document`: `patch` is called once with the planned `findText`/`text` and `lastRevision === shown.revision`. The result is `saved`, carrying the re-read doc whose item `index` has `checked === true`.
- `reports a conflict when the Markdown revision moved`: `markdown().revision !== shown.revision` → `conflict` with a fresh `document()`, and `patch` is not called.
- `reports a conflict on 409`: `patch` rejects with `OutlineError(409, "conflict")` → `conflict` with a fresh doc.
- `passes a refusal through`: a twin-list fixture → `{ kind: "refused", reason: "ambiguous" }`, no `patch`.
- `signed-out`: `markdown` or `patch` rejects with kind `signed-out` → `{ kind: "signed-out" }`.
- `treats a failed request that did land as saved`: `patch` rejects with `OutlineError(0, "other")`, but the re-read doc has the box ticked and `revision > shown.revision` → `saved`.
- `fails when the read-back disagrees`: `patch` resolves, but the re-read shows the old state → `failed` with that doc.
- `fails with no document when the re-read also fails` → `{ kind: "failed", doc: null }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web-guide-tick.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `tick` in `src/web/guide-tick.ts`**

Order: `markdown` → revision check → `planCheckboxPatch(md.text, checkboxItems(shown.data).length, index, shownChecked, checked)` → `patch` → `document` re-read → verify `checkboxItems(reread.data)[index]?.attrs?.checked === checked`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/web-guide-tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/guide-tick.ts test/web-guide-tick.test.ts
git commit -m "feat(game-companion): checkbox save with conflict handling and read-back"
```

### Task 4: Guide renderer

**Files:**
- Create: `src/web/guide-render.ts`, `THIRD-PARTY-NOTICES.md`
- Test: `test/web-guide-render.test.ts`

**Interfaces:**
- Consumes: `PMNode`, `checkboxItems` (Task 1).
- Produces: `export function renderGuide(root: PMNode, ctx: { origin: string }): string`. This is an HTML string with no global state; `ctx.origin` is e.g. `"https://outline.example"`.

Output contract (the tests assert these exact shapes):

| Node | HTML |
|---|---|
| `checkbox_item` | `<li class="cb-item[ checked]"><button type="button" class="cb" role="checkbox" aria-checked="true\|false" aria-label="{item text, max 80 chars}" data-cb="{N}"></button><div class="cb-body">…</div></li>`, where N is the index in `checkboxItems` order |
| `checkbox_list` | `<ul class="checklist">` |
| `heading` | `<hL id="h-{slug}">`, L clamped 1–6; slug is lowercase with non-alphanumeric runs as `-`; repeats get `-2`, `-3` |
| link mark, `/doc/x` or `{origin}/doc/x` | `<a href="/doc/x" data-doc="/doc/x" target="_blank" rel="noopener noreferrer">` (query/hash dropped from `data-doc`) |
| link mark, other `http(s):` | `<a href="{url}" target="_blank" rel="noopener noreferrer">` |
| link mark, any other scheme | the text only |
| `emoji` | `star` ⭐, `warning` ⚠️, `white_check_mark` ✅, else `:{name}:` escaped |
| `table` | `<div class="table-scroll"><table>`; `colspan`/`rowspan` integers clamped 1–50, omitted when 1 |
| `ordered_list` | `start` integer clamped 1–1 000 000 |
| `container_notice` | `<div class="notice notice-{info\|warning\|tip\|success}">`, unknown → `info` |
| `code_block` / `code_fence` | `<pre><code>{escaped text}</code></pre>` |
| `embed` / `attachment` / `video` | `<a class="card" href target="_blank" rel="noopener noreferrer">` for an `http(s)` URL, else `<span class="card">` |
| `image` | `<img loading="lazy" src alt>` only for `src` starting `/api/attachments.redirect?id=`; else the same as a card |
| `math_inline` / `math_block` | `<code>{tex}</code>` |
| `container_toggle` | `<details class="toggle"><summary>` |
| unknown, with children | children only |
| unknown leaf | `<p class="unsupported">This part can't be shown here. Use Show in Outline to see it.</p>` |

Marks: strong, em, underline→`u`, strikethrough→`s`, code_inline→`code`, highlight→`mark`; comment and others → no wrapper. All text and attribute values are escaped (`& < > " '`).

- [ ] **Step 1: Write the failing tests.** Build one synthetic fixture per row of the table. Also assert:
- `javascript:` and `data:` links render no `<a>`.
- `<script>` in a text node comes out escaped.
- Two renders of different documents share no state: checkbox numbering restarts at 0.
- `data-cb` values equal the `checkboxItems` order on a nested checklist.
- The output contains no `style=`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web-guide-render.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `renderGuide`** by adapting Inkharbor `src/lib/editor/render-html.ts` (switch on `node.type`), changed per the table above. Write `THIRD-PARTY-NOTICES.md` with the Inkharbor MIT licence text (from `/tmp/inkharbor-web-research/LICENSE`, or GitHub at the pinned commit), the commit, and the mapping `render-html.ts → src/web/guide-render.ts` and `outline/edits.ts → src/web/guide-checkbox.ts`, `src/web/guide-tick.ts`. List the intentional differences: in-block matching, URL allow-list, class-based notices, no maths/emoji tables, per-call state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/web-guide-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/guide-render.ts test/web-guide-render.test.ts THIRD-PARTY-NOTICES.md
git commit -m "feat(game-companion): render Outline guide JSON as safe reader HTML"
```

### Task 5: Find-in-element and the reader view

**Files:**
- Modify: `src/web/locate.ts` (`scan` at line 59, `findTextRange` at 118, `findFallbackRange` at 162, `reveal` at 247)
- Create: `src/web/reader.ts`
- Test: `test/web-locate.test.ts` (add cases), `test/web-reader.test.ts`

**Interfaces:**
- Consumes: `OutlineApi`, `GuideDocument` (Task 2); `tick`, `TickResult` (Task 3); `renderGuide` (Task 4); `docId` from `state.ts`.
- Produces:
  - `locate.ts`: `findTextRange(root: Document | Element, …)` and `findFallbackRange(root: Document | Element, …)`. A `Document` keeps today's behaviour (`searchRoot`); an `Element` searches only inside itself, and ranges come from `root.ownerDocument`.
  - `locate.ts`: `export function locateInElement(root: Element, text: string, heading: string | null, opts: { mode?: LocateMode; fallback?: string; highlightMs?: number; signal?: AbortSignal }): boolean`. It works synchronously: it opens every `details` ancestor of the match, then reveals and highlights as `locateInFrame` does.
  - `reader.ts`: `export interface ReaderDeps { doc: Document; outline: OutlineApi; origin: string; openPage(url: string): boolean; showInOutline(url: string): void; onSaved(): void }`
  - `reader.ts`: `export interface Reader { element: HTMLElement; readonly url: string; load(url: string): void; locate(text: string, heading: string | null, mode: LocateMode, fallback?: string): Promise<boolean>; dispose(): void }`
  - `reader.ts`: `export function createReader(deps: ReaderDeps, url: string): Reader`

Reader DOM: `<div class="reader"><div class="reader-bar"><button type="button" class="reader-outline">Show in Outline</button><span class="reader-status" role="status"></span></div><article class="reader-body"></article></div>`.

Status copy (exact):
- loading: `Loading…`
- signed out, on load: `Sign in to Outline to read this page.`
- signed out, on tap: `Sign in to Outline to tick boxes.`
- conflict: `This page changed elsewhere and was refreshed. Tap again.`
- refused: `Couldn't match this item safely. Tick it in Outline.`
- failed: `Couldn't save. Check your connection and try again.`

The sign-in variants append `<a href="/" target="_blank" rel="noopener noreferrer">Sign in</a>`.

- [ ] **Step 1: Write the failing locate tests.** `findTextRange(element, …)` ignores matching text outside the element. `locateInElement` opens a closed `<details>` around the match and returns `true`; it returns `false` when the text is absent.

- [ ] **Step 2: Write the failing reader tests** (jsdom, fake `OutlineApi`, `tick` exercised through the fake):
- `renders the document and clears the status`.
- `ignores a load answer for a page it has left`: `load("/doc/a-1")`, then `load("/doc/b-2")`, then resolve a's promise last → body shows b.
- `marks a tapped box pending, then checked after save`: click `.cb[data-cb="0"]` → `aria-busy="true"` and `aria-checked="true"` at once; after save `aria-busy` is removed, and `onSaved` is called once.
- `reverts the box and shows the message on refused | signed-out | failed | conflict`. One case per kind, with the exact copy above. Conflict re-renders from the fresh doc.
- `queues a second tap until the first is saved`: two taps → the second `patch` uses the revision returned by the first save's read-back.
- `keeps scroll position across a re-render after save`.
- `opens a known guide link in the companion`: click `a[data-doc]` with `openPage` returning true → `preventDefault` was called; returning false → default not prevented.
- `Show in Outline calls showInOutline with the current url`.
- `restores the reading position when a page is loaded again`: per `docId`, a module-level `Map`.
- `locate waits for the current load, then finds inside the body`, with a 10 s cap that resolves `false`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/web-locate.test.ts test/web-reader.test.ts`
Expected: new cases FAIL; existing locate cases still pass.

- [ ] **Step 4: Implement the `locate.ts` changes and `src/web/reader.ts`**

Use one delegated `click` listener on the body for `.cb` and `a[data-doc]`. Run ticks on a FIFO promise chain per reader. Each queued tap re-reads the current shown document when it starts, so it uses the latest revision. The `.cb` itself is the 44px target (CSS, Task 6).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/web-locate.test.ts test/web-reader.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/locate.ts src/web/reader.ts test/web-locate.test.ts test/web-reader.test.ts
git commit -m "feat(game-companion): guide reader view with one-tap checkboxes"
```

### Task 6: Slot integration, styles, release

**Files:**
- Modify: `src/web/frames.ts` (Entry, `show`, `locate`, `sync`, `reset`)
- Modify: `src/web/main.ts` (AppOptions at line 69, `createFrames` call at 296, `picker.onPage` at 336, `showSlot` at 1063)
- Modify: `src/web/boot.ts`, `web-static/style.css`, `README.md`, `Dockerfile`, `package.json`
- Test: `test/web-frames.test.ts`, `test/web-main.test.ts`, `test/web-zoom-style.test.ts`

**Interfaces:**
- Consumes: `createReader`, `Reader` (Task 5); `createOutlineApi`, `OutlineApi` (Task 2).
- Produces:
  - `FrameKind = "doc" | "link" | "reader"`.
  - `createFrames(doc, slotCount, { …, reader?: (url: string) => Reader })`. Without the factory, `"reader"` falls back to `"doc"`.
  - `AppOptions.outline?: OutlineApi`.

- [ ] **Step 1: Write the failing frames tests**

With a fake reader factory:
- `show(0, "/doc/a-1", "reader")` appends the reader's element with class `reader`, and no iframe.
- Showing the same slot with another URL calls `reader.load` and does not create a second reader.
- Switching a slot from `"reader"` to `"doc"` disposes the reader and creates an iframe.
- `locate` on a reader slot delegates to `reader.locate` and maps `true` to `"found"` and `false` to `"not-found"`; it returns `"gone"` if the slot was replaced meanwhile.
- `reset()` disposes every reader.
- `setReader` and `setHideChrome` never touch reader entries.

- [ ] **Step 2: Write the failing main tests**

With `outline` supplied:
- A non-editable guide page shows as a reader.
- A page listed in `editablePages` shows as an iframe.
- `showInOutline` switches that slot to an iframe.
- Choosing the page again from the picker shows the reader.
- A saved tick triggers a fresh progress request (`api.progress(hubId, true)`).

Without `outline`, existing tests are unchanged: every guide page is still an iframe.

- [ ] **Step 3: Write the failing CSS tests** in `test/web-zoom-style.test.ts`:
- Rules `.frames.zoom-{90|80|70} .reader` each contain `font-size: {90|80|70}%;` and no `transform`.
- `.reader .cb` contains `min-width: 44px;` and `min-height: 44px;`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/web-frames.test.ts test/web-main.test.ts test/web-zoom-style.test.ts`
Expected: new cases FAIL.

- [ ] **Step 5: Implement the frames change**

`Entry` gains `node: HTMLElement`, `frame: HTMLIFrameElement | null` and `reader: Reader | null`. The `.inactive` class toggles on `node`, and `applyTo`/`watchClicks` return early for reader entries.

- [ ] **Step 6: Implement the main change**

- `outlineView: Set<string>` (docIds, session only). `showSlot` picks `"link"` for links; `"doc"` when there is no `opts.outline`, `isEditable(url)`, or `outlineView.has(docId(url))`; otherwise `"reader"`.
- `picker.onPage` deletes the page's docId from `outlineView`.
- The reader factory passes `openPage`, which opens a page of `current.pages` matched by `docId` through the same path as `picker.onPage`, and returns false otherwise.
- It also passes `showInOutline` (add the docId, then re-show the active slot), `onSaved` (calls `refreshProgress(current, true)` when `current !== null`), and `origin`, taken from `doc.location.origin`.

- [ ] **Step 7: Wire boot and styles**

- `boot.ts`: `outline: createOutlineApi({ fetch: window.fetch.bind(window), cookie: () => document.cookie })`.
- `style.css`:
  - `.reader`: absolute fill like `.frame`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch`; `.reader.inactive` uses the same visibility rule as `.frame.inactive`.
  - The `.reader .cb` box is drawn with `::before`. Pending is `[aria-busy="true"]` at reduced opacity, and checked is `[aria-checked="true"]`.
  - `.table-scroll { overflow-x: auto }`; `.notice-*` tints; `.reader-bar` small and not sticky.

- [ ] **Step 8: Bump the release and document it**

- Version 0.16.1 → 0.17.0 in `package.json`, `Dockerfile` (`GAME_COMPANION_VERSION=v0.17.0`), and both README version lines.
- README: a "Guide reader" section covering the reader, Show in Outline, editable pages staying framed, ticks saved as the signed-in Outline user, and the 0.4% "Tick it in Outline" case.

- [ ] **Step 9: Run the full suite and checks**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check && npm run build`
Expected: all pass; `dist/web/reader.js`, `guide-render.js`, `guide-checkbox.js`, `guide-tick.js` and `outline-api.js` exist.

- [ ] **Step 10: Commit**

```bash
git add -A src web-static test README.md Dockerfile package.json package-lock.json
git commit -m "feat(game-companion): show guide pages in the reader (v0.17.0)"
```

### Task 7: Live verification (release gate)

No code. These steps run after the image is built and deployed, and they need the user's signed-in browser.

- [ ] **Step 1:** In the deployed companion, create a draft Outline page containing the Task 1 `MD` fixture, open it as a guide page, and tick items 1, 2 and 4. Expected: each saves; Outline's history shows the user as editor; nothing else on the page changed. Delete the draft afterwards.
- [ ] **Step 2:** On the iPhone (Safari and the installed app), at text sizes 100 and 70: one tap toggles a box; a wide table scrolls sideways; a heading jump from status and from Find lands in the reader; a Notes page opens framed with Edit in Outline.
- [ ] **Step 3:** Sign out of Outline in another tab, then tap a box. Expected: "Sign in to Outline to tick boxes." and the box reverts.
