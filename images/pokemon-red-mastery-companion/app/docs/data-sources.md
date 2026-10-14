# Dataset sources and validation boundaries

The 2026-10-11 inventory contains 234 published achievements: main 93 (API game 724/site set 23), Professor Oak Challenge 133 (16084/6385), and Glitch Showcase 8 (11632/4827). The seventeen unpublished glitch records are excluded. IDs, short titles and point values identify records; all instruction summaries are original prose. The static client contains no API credentials.

## Membership evidence

Published membership was independently checked on 2026-10-11 against the public [Red set pages](https://retroachievements.org/game/724). The [metadata-only membership comparison](evidence/membership-recheck.json) records matching counts, IDs and titles for all three backing games. These records establish the published inventory; account observations are kept separately.

The API's `memAddr` fields are thirty-two-character hashes, **not executable achievement definitions**. Public metadata verifies membership and mapping; it does not establish exact trigger conditions, hardcore loading in an emulator, or runtime method validity. Recheck published membership before a release; update both rules and independently declared `sets.json` membership rather than silently ignoring drift.

## Factual source and reproducibility

[pret/pokered](https://github.com/pret/pokered/tree/af519899719f0754965776faac0e836a3b906e6d) is pinned to `af519899719f0754965776faac0e836a3b906e6d`. `scripts/extract-pokered.ts` refuses another HEAD or a dirty tracked/untracked source tree and writes only factual data. Run with Node 24 or newer:

```sh
npm run extract -- /path/to/pinned/pokered
npm run extract -- /path/to/pinned/pokered /tmp/red-facts.json
cmp src/data/pokered.generated.json /tmp/red-facts.json
```

Inputs are `constants/{pokemon,pokedex,item,move,event,toggle}_constants.asm`, `data/pokemon/{evos_moves,base_stats/*}.asm`, Red branches of `data/wild/maps/*`, `data/wild/{good_rod,super_rod}.asm`, `data/events/{trades,prize_mon_levels,hidden_events,hidden_item_coords}.asm`, and `data/maps/{objects/*,toggleable_objects}.asm`. The extractor emits all 151 national/internal species mappings, base stats, evolution edges and level-up moves, 692 deduplicated Red encounter/acquisition facts, nine usable NPC trades, 507 event indices, 228 toggleable-object indices, and 158 visible/hidden physical pickup records. The unused Butterfree→Beedrill trade is excluded. The Old Rod Magikarp fact and static/gift levels were checked against their individually linked scripts. Encounter records describe available factual methods; access, selected alternatives and intentional deferrals belong to route planning.

Toggle indices are byte indices in the source's toggleable-object state/list domain; event indices are bits in the event flag domain. Hidden pickup indices are bits in the hidden-item coordinate domain. Do not mix these representations or assume all visible objects are event bits. Source symbols/indices are factual references; a reader still needs independently audited SRAM offsets and fixtures.

Factual availability and canonical access are separate. `src/data/acquisitions.ts` explicitly gates areas, fishing rods, field Surf/Strength and evolution stones by the nonstandard Oak phase order; unknown areas are excluded. It recursively checks evolution parents and trade donors, and prioritizes the specific purchased Mt. Moon Magikarp needed for gift history. `CanonicalAcquisition` stores the phase, factual source, method, execution area, resource milestones, historical dependencies and recursive donor paths. Every single/alternative acquisition in the 124 non-badge/non-Champion Oak rules is audited. `scripts/curate-oak-acquisitions.ts` regenerates those selected paths and fixed-species instructions without changing factual availability. `validateDataset` rechecks access against the assigned route phase, so a real encounter that is too early still fails validation. Generic rod facts select a concrete accessible shore (Fuchsia for Good Rod); pre-Koga water species use shore fishing rather than locked Surf/Seafoam access.

Factual data and curated guidance are separate. `pokered.generated.json` is reproducible extraction; `rules.curated.json`, `route.curated.json`, and `glitches.curated.json` are original editorial decisions. The source clone/ROM, save files and third-party guide prose are not bundled.

## Guidance sources

- The [RA main-set guide](https://github.com/RetroAchievements/guides/wiki/Pokemon-Red-Version-%28Game-Boy%29) supplies main achievement requirements and area checklists. Its ordinary gym order differs from the Oak route, so route decisions use the Oak checkpoint sequence.
- Each rule links to its [specific achievement](https://retroachievements.org/achievement/108023). Current Oak membership reconstructs exact fixed species plus consistent starter/fossil/Dojo/Eevee alternatives. Two **distinct** Moon Stone evolutions are required before Misty, all four before Koga. Counts are additional consistency checks.
- The [Glitch Showcase developer forum](https://retroachievements.org/forums/topic/6082) supports extending the player's own core collection to 151; it does not authorize arbitrary restored saves as current-run history.
- Candidate methods cite the original [Red Any% route](https://github.com/pokemon-speedrunning/speedrun-routes/blob/main/docs/gen-1/red-blue/main-any/README.md), Torchickens' [trainer-free Special-encounter procedure](https://pastebin.com/SPYqSQSL), the [original Super Glitch research archive](https://zzazzdzz.github.io/gcl-thread-backups/SuperGlitchResearch_Backup.pdf), and individually linked mechanics/procedure sources. Candidate records retain their detailed source/preparation audit in [glitch methods](glitch-methods.md), remain `sourced`, and require target-runtime acceptance before supported execution.

The physical Safari discrepancy is resolved by the pinned object tables: **eleven optional objects**, ten visible plus West's hidden Revive. Both Max Potions are separate pickups. HM03 and Gold Teeth are progression items; the inaccessible Safari Gate Nugget is excluded. This factual list does **not** close the exact current RA trigger/reset-boundary gate. Final runtime acceptance still requires decoded definitions or a controlled target-core test.

## Concrete runtime prerequisites

The 124 Oak acquisition records have independent source/access validation. The 102 main/Oak badge/Champion/history rules, eight glitch rules and all eight candidate methods remain `sourced`. Source/access validation never proves runtime execution or hardcore awards. `validateDataset(dataset, 'development')` verifies inventory structure; release mode intentionally rejects the remaining unvalidated rules/methods and pending runtime gates. See [final validation](validation.md) for fresh membership, full checks, evidence rulings and the precise open gates.

1. **Actual emulator/core and ROM:** obtain emulator application version, core name/version, target platform, hardcore configuration, and actual ROM MD5. Public [supported hashes](https://retroachievements.org/game/724/hashes?set=4827) list unpatched USA/Europe Red `3d45c1ee9abd5738df46d2bdda8b57dc`; comparison against the player's target ROM is still pending. Hash alone does not prove set activation.
2. **All three sets loaded:** on that target emulator, demonstrate main/Oak/Glitch activation in hardcore and perform representative awards. Verified public subset membership does not prove the emulator loaded those sets.
3. **Safari conditions:** obtain current decoded 108045 definition or controlled pickup/reset tests demonstrating every required condition and uninterrupted-hunt boundaries. The eleven-object physical source list is established.
4. **Reader fixtures:** obtain independently checked local battery saves for initial, pre/post-Brock, initialized boxes with live/current archive disagreement, pre/post-Koga Safari, Silph, postgame, and representative glitch states. Optional early game-written Serverboy 0.0.7 fixtures use ordinary NEW GAME/SAVE button inputs, fresh SRAM and independent field/checksum audits. These establish only observed early-game states, not target-core or initialized-box/glitch validation. Keep capture bytes outside git; fixture audit records must explain independent expected-value checks. See the [fixture documentation](../test/fixtures/README.md).
5. **Glitch execution:** Detailed sourced procedures now retain measured-stat prerequisites, successful Growl counts, item positions, named consumed trainers and trainer-free fallback, starter-dependent Oak rosters, crash versus freeze distinction and recovery boundaries. Current-core/hardcore execution results remain open for all eight methods. A missing trainer or guessed Special does not satisfy an encounter prerequisite.
6. **Rule audit:** owning route tasks must validate exact missable/session conditions, battle caps before gym entry, ordered area obligations, separate League parties, and evidence semantics. Final SRAM does not prove past sessions or action order.

The companion reads original save bytes without edits/restoration. Account-wide hardcore timestamps, current save facts, and continuity-scoped manual history are independent. Unknown data must remain unknown.

## Dependency and license attribution

The locked Preact/Vite/TypeScript/Vitest/happy-dom dependency baseline and compatible configuration were copied from [DQ8 Alchemy Planner](https://github.com/sharkusmanch/dq8-alchemy-planner) on 2026-10-11. Its MIT plumbing is attributed to Marcus Sanchez (2026); the unchanged MIT permission and warranty text is preserved in `LICENSE`. Package identity changed; dependency versions/integrities remain locked. Third-party dependency licenses are their respective authors'. The factual extraction does not redistribute source code, ROM data, or bulk source descriptions.

Review fix test note: the dirty-source extractor integration test uses an isolated temporary shared clone and never changes the source checkout. It runs when `POKERED_SOURCE` (default `/tmp/pokemon-red-source`) is available; otherwise Vitest visibly skips only that source-dependent test. The required local verification ran it successfully.
