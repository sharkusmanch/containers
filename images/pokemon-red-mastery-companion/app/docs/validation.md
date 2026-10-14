# Validation and release boundaries

This is a sourced beta of the English Pokémon Red mastery guide. Public hosting, successful builds and defensive parser tests do not validate gameplay methods or hardcore award triggers.

## Published scope

The app contains 234 published objectives: Main 93, Professor Oak Challenge 133 and Glitch Showcase 8. It retains 28 route stages, all 151 species, current-save observations, continuity-scoped manual history and separately attributed optional hardcore account feeds. [Membership evidence](evidence/membership-recheck.json) records an independent comparison of published IDs and titles.

The public repository starts from the previously reviewed [container source snapshot](https://github.com/sharkusmanch/containers/tree/e877a93133cc6aac9bc03aa62461bdb51b5b59e6/images/pokemon-red-mastery-companion/app). Complete private execution records and local build history are retained separately. Public documentation summarizes their scope; it does not redistribute private records or claim that rewritten summaries are the original reports.

## Automated checks

Run `npm ci`, `npm test`, and `npm run build` with Node.js 24 or newer. The production build includes TypeScript checking. The [GitHub Pages workflow](../.github/workflows/pages.yml) repeats the public test/build gate before deployment. Its current run is the source of truth for the public commit being deployed.

The reviewed prepublication app passed 445 tests locally when optional independent fixtures and the pinned disassembly were available. A clean public checkout supplies neither input: 431 tests run and 14 visibly skip. The skips cover private/genuine and independently sourced reader fixtures plus source-dependent extraction checks. Passing synthetic tests or skipped optional tests cannot satisfy a gameplay or capture gate.

The defensive suite checks immutable input, checksum/region integrity, unknown species/items, count bounds, unsigned quantities, live-versus-archived storage authority, daycare uncertainty, source-generation cancellation, stale/failed account feeds, project persistence/recovery and conservative planner evidence. Browser verification covers manual import, all five screens, route/set navigation, export/reload and project-path asset loading. Record fresh publication checks separately from earlier whole-project reviews.

The automatic-loading release adds synthetic tests for the optional `app-config.json` deployment declaration: strict key validation (same-origin relative save/progress paths, `https:` guide links only), public manual mode on a 404, HTML fallback or network error, signed-out reporting on login redirects and 401s, in-place migration of existing browser projects, precedence of a player-set save address, confirmed account connection, and the simplified Next and More screens. They use zero-filled synthetic save bytes and mocked responses only, and one test confirms the public build ships no deployment config. These are browser/controller checks, not runtime or deployment acceptance.

Raw save files, ROMs and emulator artifacts stay outside Git. The [fixture documentation](../test/fixtures/README.md) and [public metadata catalogue](../test/fixtures/online-save-catalogue.json) describe optional inputs, independent expected-value checks and provenance limitations. Tests never download, rewrite or resave those inputs.

## Evidence semantics

The 124 Oak acquisition records have independently audited source/access paths. That validates factual availability and canonical route access. The remaining 102 Main/Oak history/badge/Champion rules, eight glitch rules and all eight candidate methods remain sourced: **110 unvalidated rules, eight unvalidated methods and six pending runtime prerequisites**. Dataset release validation intentionally rejects those open gates.

Current save facts cannot establish prior sessions, battle order or hardcore awards. Manual entries retain their own scope and never promote a sourced method to runtime validated. Optional account feeds confirm only attributed hardcore timestamps; they do not establish which attempt produced an award.

## Remaining runtime gates

| Gate | Evidence still required |
| --- | --- |
| Target ROM/core | Actual emulator/core versions, target platform, hardcore configuration and supported-ROM hash comparison |
| Loaded hardcore sets | Main/Oak/Glitch activation and representative real awards on the target emulator |
| Later-state reader fixtures | Independent target-runtime storage, daycare, pre/post-Brock, Safari, Silph, postgame and representative glitch captures |
| Safari conditions | Decoded current trigger definitions or controlled tests for every pickup/reset/session condition; the sourced eleven-object list alone is insufficient |
| Historical rules | Controlled execution and raw-trigger acceptance of sourced Main/Oak conditions; final SRAM cannot prove past uninterrupted sessions |
| Glitch methods | Individual target-core procedure, measured preparation, physical attempt isolation, recovery boundaries and actual hardcore awards |
| Private synchronization | Authenticated same-origin save/progress acceptance on each deployment, exact account identity, set membership and genuine last-successful timestamps |

Optional private synchronization is configured and accepted separately. The public Pages app starts without endpoints, credentials or account progress. See [self-hosting](self-hosting.md), [source audit](data-sources.md), [save reader](save-reader.md), [route evidence](route-evidence.md), [Oak access audit](oak-validation.md) and [glitch method audit](glitch-methods.md).

## Retained source limitations

Deferred extractor cases include arithmetic beyond safe intermediate precision and tab-separated map directives; neither occurs in the pinned source. Reassess them before accepting a new source pin. The current bundle uses supported module splitting. None of these source observations or passing automation removes the runtime gates above.
