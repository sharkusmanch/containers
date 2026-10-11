# Whole-project validation — 2026-10-11

The complete guide is approved as a **reviewed sourced beta** for Main 93 + Oak 133 + Glitch 8, with optional manual/offline operation. Both whole-branch reviews returned with fixes; the ONE scoped final re-review accepted all fixes and evidence preservation, with no new Critical, Important or Minor finding. **Full-coverage release-candidate and runtime-validated status remain blocked.** Passing source, parser and browser checks do not establish mastery eligibility or award execution on the target emulator.

This evidence covers app base `dd951fbcfa0ba62ad0cadc52f11ae065afabd1b2` plus the Task 9 tests and documentation in the commit containing this file. The accepted service branch is `ede0f4edee6fc1ba705018bb76fbc6db1a68d597` in `/config/.worktrees/game-companion-red`; Task 9 changed no service source. No deployment, original service checkout, emulator, account, ROM or save was changed.

## Consolidated final fixes and current checks

App source range: `ac32fbd35cbce215b441dda5ef0fb0e495b8e031..68419c4fc3642ac5274200fd76b0b651551fae41`. The subsequent evidence commit changes only documentation and recorded outputs. Complete [RED](evidence/final-fix-red.json), [focused GREEN](evidence/final-fix-green.json), and [full command outputs with exit codes and source hashes](evidence/final-fix-checks.json) are tracked. The full changed-app commands ran once against the exact source now committed at `68419c4fc3642ac5274200fd76b0b651551fae41`; no product source changed afterward.

| Command | Exit | Actual result |
|---|---:|---|
| `npm test` | 0 | 19 files, 445 tests passed, 0 failed, 0 skipped; 19.70 s |
| `npm run typecheck` | 0 | No diagnostics |
| `npm run build` | 0 | 53 modules; 653 ms; largest chunk 338.65 kB, gzip 18.35 kB |
| `git diff --check` | 0 | No whitespace errors |

Vitest retained its informational isolation suggestion (77 modules evaluated 120 times; ~1.48 s potential saving). Isolation, dependency locks and supported code splitting remain unchanged. No build warning occurred. The unchanged service was not rerun; its prior 19-file/489-test result and typecheck/lint/format/build outputs below remain valid.

The [parser/integration review](reviews/final-parser-review.md) identified FP-I1 recovery-data loss and FP-I2 stale project-file restoration. The [route/data review](reviews/final-route-review.md) identified TFR-I1 Cinnabar gym-entry preparation and small failure-control/static-label/prose issues. [Finding-by-finding resolution, API/UI contract, and every declined-claim disposition](reviews/final-fix-resolution.md) are recorded separately. The initial focused regressions failed for the reviewed behaviors; the first GREEN run passed 63/63. Additional self-review cases passed in the final 445-test run. These include real More reverse file completion and file-versus-paste selection, original-text preservation/export, explicit replacement and quota behavior, Cinnabar over-cap/unreadable/legal party guards, and attributed deduplicated failure controls.

**Scoped fix review APPROVED.** The [complete unchanged final re-review](reviews/final-fix-rereview.md) accepts all six finding groups and essential evidence preservation; it found no new Critical, Important or Minor issue. It reviewed `ac32fbd35cbce215b441dda5ef0fb0e495b8e031..4d3f7e1a43bfdea66431171177b36228d0856d4b`, with product source `68419c4fc3642ac5274200fd76b0b651551fae41`. The [implementation report at handoff](evidence/final-fix-implementation-report.md) is retained unchanged; its then-pending review/browser status is historical. The complete original whole-branch reviews, [legacy Task 1 implementation report](evidence/task-1-implementation-report.md), and [two original formal rulings](reviews/binding-rulings.md) remain preserved. Runtime evidence, raw triggers, actual gameplay and final authenticated deployment gates remain OPEN. Sourced-beta approval does not authorize merge, push, publication or deployment.

## Prior assembled-branch commands and actual results

Node `v24.18.1`; locked dependencies retained. App checks completed at `2026-10-11T21:11:12.094015+00:00`; service checks at the timestamp in [complete command outputs](evidence/final-checks.json). These commands ran against the assembled final source, including local ignored fixtures and the pinned disassembly used by the extractor test.

| Workspace | Command | Exit | Result |
|---|---|---:|---|
| App | `npm run test` | 0 | 17 files, 418 tests passed, 0 failed, 0 skipped; 15.37 s |
| App | `npm run typecheck` | 0 | No diagnostics |
| App | `npm run build` | 0 | 53 modules; Vite build 814 ms; largest chunk 338.65 kB, gzip 18.35 kB |
| Service | `npm run test` | 0 | 19 files, 489 tests passed, 0 failed, 0 skipped; 24.12 s |
| Service | `npm run typecheck` | 0 | No diagnostics |
| Service | `npm run lint` | 0 | No diagnostics |
| Service | `npm run format:check` | 0 | All matched files use Prettier code style |
| Service | `npm run build` | 0 | TypeScript build and static copy completed |

The final app test runner emitted an informational import/isolation suggestion: 75 modules evaluated 110 times, 2.91 s total and approximately 925 ms potentially faster with `isolate: false`. The earlier broad run suggested 5.25 s of worker startup savings. Isolation was retained. No build chunk-size warning, lint warning or service test warning occurred. No dependency upgrade or warning threshold change was made.

Focused `npm run test -- test/whole-project.test.ts` passed 4/4. `test/online-saves.test.ts` passed 5/5 with all five originals present. A controlled missing-fixture check temporarily moved all five originals, ran `npm run test -- test/online-saves.test.ts`, then restored every original in a `finally` block: exit 0, **5 visibly skipped, zero fixture passes**. This is test portability evidence, not a passing runtime gate. The new tests verify existing behavior; they are not claimed as production-fix TDD. Initial scenario failures were corrected test setup (gym ID mapping, valid ISO import timestamp, and unknown bag input); no production mismatch was found.

## Scenario and independent fixture coverage

[Whole-project scenarios](../test/whole-project.test.ts) exercise real import guards, state reduction, planner composition and export/restore. Independently audited exact rosters progress through Brock, Misty, Silph Rival before clearance, pre/post-Koga Safari, Erika, Surge, Sabrina, Blaine, Giovanni, separate League parties, postgame, all eight sourced glitch objectives and an empty fresh speedrun attempt. Assertions retain the 28 route stages and known missable deadlines, verify the eleven deferred Safari objects, protect eligible history through forward imports, and prevent late results or account awards from populating a new attempt. Unknown and reviewed history remain distinct from known missed ship/Silph/Safari conditions. These are **synthetic integration observations**, not recorded gameplay sessions. Synthetic manual completion represents attributed test history and never claims a hardcore award.

The [public fixture catalogue](../test/fixtures/online-save-catalogue.json) contains source URLs, source claims, byte lengths, SHA256, provenance limitations and independent fixed-offset expectations only. Earlier companion reader-smoke outputs were deliberately excluded. The independent decoder imported no companion code and used pinned `pret/pokered` `af519899719f0754965776faac0e836a3b906e6d`. No binary redistribution licence was established; neither save bytes nor ROM bytes are committed or bundled.

| Original local fixture | Independently checked boundary and expected reader result |
|---|---|
| `zophar-rog.sav` | 32,768 bytes; valid initialized archives, live index 7/count 5 supersedes archived count 0; 151 registrations, badge mask 255 (all eight badges), six level-100 party members; partial because positive HoF count has unchecked history; inconsistent story flags retained |
| `digiex-yoshira.sav` | 32,768 bytes; source admits moving party Pokémon; valid main but invalid initialized archive checksums; rejected without a replacement snapshot |
| `extrabytez-red.dat` | Original 32,768-byte auxiliary extension; uninitialized archives remain unknown despite stale checksum-valid contents; 18 owned/110 seen, live count 2; partial HoF history |
| `roc-red.dat` | Original 32,768-byte VC-labelled auxiliary image; valid initialized archives, 151 registrations; invalid PC item count remains unknown, never empty; partial result |
| `zophar-rey.sav` | Original 31,315 bytes; rejected unsupported length without conversion or padding |

[Public-fixture regressions](../test/online-saves.test.ts) verify each original SHA256, unchanged input bytes, independent party/Dex/live/nonactive archive/world facts and conservative failure behavior. Each missing local fixture **visibly skips its own test** on a fresh checkout. Skips do not satisfy a capture or runtime release gate. Four distinct exact-size Red-labelled images include one integrity rejection; the ROG duplicate from PKSav was not counted twice. Core, exact region, edit history and clean chronological provenance are unverified or source-qualified; all four have empty daycare. Auxiliary `.dat` inputs test byte-layout compatibility, not a new promised emulator/import format.

The existing [fixture record](../test/fixtures/README.md) also covers three button-only Serverboy initial/starter/Shift-to-Set captures and two public BaseSAV variants. Serverboy captures prove only those early observed states, not target Gambatte acceptance. Public snapshots, including full Dex/badges/HoF count, cannot establish unobserved story order or clean play.

## Published inventory and independent browser evidence

Official `API_GetGameExtended.php`, `f=3`, was rechecked server-side at `2026-10-11T20:02:23.440Z`. [Exact public IDs and titles](evidence/membership-recheck.json) and [comparison results](evidence/membership-comparison.json) confirm unchanged Main 93 (`724`), Oak 133 (`16084`) and Glitch 8 (`11632`), totaling 234. The new scenario compares the complete rule membership against these independent IDs. Credentials and private account responses were not retrieved, printed or copied. `MemAddr` values were 32-character hashes, **not decoded triggers**. This does not prove all three sets loaded in hardcore or accept the new service routes.

Independent coordinator Chromium/Playwright production-preview QA passed all [22 import/recovery scenarios](evidence/browser-import-recovery-report.json) at app `dd951fb`, checked `2026-10-11T21:01:50.119Z`. It covered genuine Serverboy starter imports and Set polarity, all three set filters, labelled history versus HC, public rejections/partial storage, held trainer assignment, empty new attempts, URL failure retention, export/restore/reset/Undo/reload, invalid startup preservation, quota failure and no upload POST requests. There were no page errors.

[Layout QA](evidence/browser-layout-report.json), checked `2026-10-11T20:53:46.324Z` at `417c1a9`, passed all five screens at 360×780 and 1440×1000, with no horizontal overflow or page errors. Navigation targets measured about 70.4×60 px mobile and 167×47.92 px desktop. The later `dd951fb` change concerned per-feed deadlines, not layout. Screenshots were actually inspected; they are not distributed with private data. The root-owned local harness used intercepted GET transport for the trainer-change URL scenario. **That is browser/controller acceptance, not actual private-host or deployed-route acceptance.** Harness selector/contract corrections were not product findings. These browser checks were not rerun by Task 9.

## Final changed-surface browser verification and docs-only finalization

Root independently ran the production preview in Chromium/Playwright at product source `68419c4fc3642ac5274200fd76b0b651551fae41` with reviewed evidence HEAD `4d3f7e1a43bfdea66431171177b36228d0856d4b`. At `2026-10-11T21:39:17.577Z`, all **9/9 checks passed**, with zero page errors and zero non-GET requests. The [exact browser result JSON](evidence/browser-final-fixes-report.json) is preserved unchanged.

The checks cover original recovery text after failed restore and ordinary edits, explicit stored replacement retaining session recovery text, real file A/B reverse completion, file-versus-paste restoration, stale read errors after newer edits, pre-entry Cinnabar level-47/Set guidance, offline static Special labels, and reachable Cinnabar/ghost failure controls with correct key/value/rule attribution and no HC award. Root also measured no horizontal overflow in recovery More at 360×900 and actually viewed its full screenshot; the screenshot remains temporary and is not distributed.

Two initial native-select exact-label timeouts were scratch harness errors because option text participates in accessible label matching. Root corrected only scratch selectors: initial zero-check/partial five-check runs were not product failures or passing acceptance. The final nine-check run exited 0; the seven-check run was extended solely to cover the two failure controls. No product change or repeat of broad screen/import QA resulted.

This is production-browser/controller guidance evidence using synthetic app backups. No SRAM, ROM or account data was edited; no target-runtime/gameplay/raw-RA or final authenticated deployed-route gate is satisfied by these checks. The re-review was dispatched while this browser work was incomplete; its historical pending statement is retained unchanged and resolved by the final root result above.

The final outcome update changes tracked documentation/evidence only. All **70 recorded source/test SHA256 values match** the final app check record, and source/test content still equals the tested source commit. [Docs-only identity and whitespace verification](evidence/final-docs-checks.json) records the exact commands and results. No suite or build was repeated, and the service/dependencies remain unchanged.

## Binding evidence rulings and open release gates

The two accepted execution rulings are preserved here so scratch execution records can be retired without losing requirements:

1. Carry genuine later-state and target-core fixture acceptance into final verification as open release gates while completing the parser/app with early game-written and independently decoded public samples. Requirements remain deferred, not satisfied. Cost if wrong: unobserved storage/daycare/glitch behavior could misguide a run. No full-coverage release-candidate or runtime-validation claim is permitted before these gates pass.
2. Carry actual gameplay, session-history, target-core and raw RetroAchievements-trigger validation for 102 main/Oak badge/Champion/history conditions and all eight glitch procedures as open gates while completing sourced guidance. Authenticated membership, source audits, public samples and synthetic tests supply neither those observations nor decoded trigger definitions. Cost if wrong: source interpretation, ordering or a glitch procedure could misguide mastery and require correction. No runtime-validated method or guaranteed mastery claim is permitted before those gates pass.

Development dataset validation passes. Release-mode validation deliberately reports **110 unvalidated rules (102 main/Oak plus 8 glitch), 8 unvalidated methods, and 6 pending runtime prerequisites**. The 124 other Oak acquisition records have independently audited **source/access** validation; that does not validate gameplay or awards. The following remain open:

| Gate | Evidence still required |
|---|---|
| Target core/ROM | Actual emulator/core versions, platform, hardcore configuration and target ROM hash comparison; public supported hash alone is insufficient |
| All loaded hardcore sets | Demonstrate Main/Oak/Glitch activation and representative actual awards on the target emulator |
| Genuine later-state reader fixtures | Target-runtime pre/post-Brock, initialized/live archive transition, occupied daycare, pre/post-Koga Safari, Silph phases, ordinary postgame and representative glitch captures; include unknown IDs, overflow counts and slot-six quantity 255 |
| Safari trigger/reset boundary | Current decoded 108045 enumeration or a controlled target-runtime test for every required pickup/reset/session condition; physical eleven-object source list does not close this |
| Historical/session/RA conditions | Controlled execution and raw-trigger acceptance of sourced main/Oak conditions; final SRAM and manual entries cannot prove prior uninterrupted sessions |
| All eight glitch methods | Individual target-core procedure, measured preparation, transition, recovery/crash-versus-freeze boundary, physical attempt isolation and actual hardcore award acceptance |
| Optional deployed synchronization | Authenticated final same-origin private-save and three progress routes, attribution/membership/titles, hardcore timestamps and genuine last-successful times |

Optional synchronization may remain disabled with manual operation and documented prerequisites. Disabled/unverified synchronization is **not passing acceptance**. The service branch was not deployed. [Private hosting](self-hosting.md) contains GET-only same-origin save/proxy configuration and required server variables; [README startup](../README.md#run-locally) and the built `dist/` are reviewable startup/deployment artifacts. Authentication and physically separate emulator storage must be configured through their normal processes before corresponding acceptance. No publish or deploy action was performed.

## Review record and retained concerns

Tasks 1–8 were accepted after their scoped independent reviews and material fixes, including exact acquisition/route deadlines, continuity baselines, scoped encounter setup and Mew continuation, unreadable hardcore timestamps, and per-feed request/body/cancellation deadlines. Final whole-branch route/data and parser/evidence/integration reviews are complete and preserved unchanged under `docs/reviews/`; both returned **with fixes**. All reported material findings and small minors have implementation fixes and regressions in the source range above. The coordinator’s ONE scoped fix re-review is **APPROVED**, with all six finding groups and evidence preservation addressed and no new Critical, Important or Minor finding. Root’s changed-surface browser checks subsequently passed 9/9; their scope and historical harness corrections are recorded below. No second product-fix wave was needed.

Deferred source-extractor minors: unsafe intermediate arithmetic rounding and tab-separated map directive retention do not occur in the pinned source, but need attention before accepting a future pin. Some glitch/model boundary logic remains compressed. The large bundle warning was resolved by measured supported splitting; no threshold was raised. Vitest's isolation suggestion remains informational. None of these concerns or passing automation removes the runtime gates above.
