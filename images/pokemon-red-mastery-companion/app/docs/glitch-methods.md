# Glitch Showcase source audit and planner contract

`planGlitches(input: PlanInput): GlitchPlan` supports all eight published objectives in backing game11632/site subset4827. Every shipped method is **sourced**, and final `readiness` remains blocked. No target ROM/core execution, crash, safe underflow operation, achievement trigger decoding or hardcore validation occurred. Manual runtime-validation checkboxes cannot change the dataset audit. Planning is complete at source scope; runtime execution and validated coverage remain explicit release gates.

Sources are the per-method `sourceUrls` below and the public RA achievement pages and forum. Factual source is [pret/pokered af519899719f0754965776faac0e836a3b906e6d](https://github.com/pret/pokered/tree/af519899719f0754965776faac0e836a3b906e6d). Per-method `sourceUrls` identify the actual files/procedure references. Source proofs, hand-calculated arithmetic, and synthetic save observations do not establish runtime success. The published API `MemAddr` hashes do not disclose trigger predicates.

| Objective | Chosen sourced guidance | Placement / pending evidence |
| --- | --- | --- |
| 57639 | Celadon Hotel PC: stand(13,4), face north toward(13,3), press A | On the save copy after mastery, subset opted in; observed PC use and hardcore result pending |
| 57640 | Safari exit setup, steps run out on Route 1, exit into Route 1's Glitch City and walk off the map edge until a real crash; fallback: a glitch item in the corrupted Speedrun? bag | Same save copy after 57644; reset without saving; a freeze, softlock or white screen is insufficient |
| 57641 | Empty-save SRAM-corruption route; names and Trainer ID do not matter for the casual recipes (the official any% list assumes RED/JOHN/TID25794) | Separate empty save copy, last; four-frame reset timing, corrupted menu and ≤1minute Hall-of-Fame transition pending |
| 57642 | Special21 → six successful Growls → party level1 Mew → one battle awarding1–53EXP | After protected main/Oak; separate glitch SRAM while encounter transport remains unvalidated |
| 57643 | Old-man encounter; physical bag slot6 Rare Candy×1 →129 → toss2 →127 →255 | After protected main/Oak; exact player-name encounter compatibility, slot order and hardcore trigger pending |
| 57644 | Safari exit; remaining steps run out in Pallet Town; exit the gate south into the Pallet Town Glitch City (the only one reported to pop it) and Fly away | After protected Safari and main/Oak, on the save copy; needs ¥500, Fly and the Thunder Badge; observed entry and hardcore result pending |
| 57645 | Special226 → branch-correct successful Growls → correct full Oak roster and victory | After protected main/Oak; separate glitch SRAM; transport and correct-roster result pending |
| 57655 | Continue own legitimate collection below151; exact Special encounters and ordinary evolutions; observe final acquisition | After protected main/Oak; separate glitch SRAM until repeated transport validated; own provenance/final transition pending |

Method records retain ordered source instructions and specific observed-event requirements. Main/Oak rule guidance is synchronized with these eight method records; original published objective/title/membership and sourced status are preserved. Release validation still reports eight unvalidated methods, 110 unvalidated rules and existing runtime prerequisites. No unsupported objective disappears.

## Preparation and observations

`GlitchPlan.methods` remains exactly the eight chosen objectives. Each assessment retains `methodId`, `ruleId`, `readiness`, `reasons`, `instructions`, `auditStatus` and adds:

- `prerequisites: PredicateAssessment`: dynamic preparation, independent of final validation. A `ready` prerequisite assessment permits no sourced procedure to become executable.
- `validationBlockers`, `sourceUrls`, `evidence`, `placement`, `requiredAttemptKind`, `requiresPhysicalIsolation`, `nextAction`, `recoveryBoundary`: display the source and attempt boundary. An app attempt name never isolates emulator SRAM. The app cannot create emulator storage or verify that configuration from a battery save.
- `requiresMeasuredSpecial`, `measuredDonors`: actual current readable party Special, slot/internal species identity and snapshot observation time. Box level, historical baselines, guessed stats and level100 Mew cannot supply Special21/226. Unknown values stay unknown.
- `transitionEvidence: Fact<boolean>`: eligible user-attributed attempt history from `rule:<id>:completed`; never save proof or an RA award. `manualEvidence` keeps flagged/foreign/revision-mismatched records visible, but these cannot supply predicates or transitions.
- `hardcoreEarnedAt: string|null`: only the matching account/backing game/set feed. A stale feed remains visible with a diagnostic. Current save state and manual records never grant a timestamp.
- Optional `oakRoster`, `experienceRoute`, `collection`: already-assessed display data. UI should not recompute planner semantics.

An unreadable save retains source instructions, unknown preparation facts, visible history and account progress. No planner operation mutates save observations, ordered inventory, manual history or imported bytes. The companion never edits, restores, patches or writes a battery save.

Before setup, Growl requires a current party carrier with sufficient usable PP. The explicit pending phase instead requires setup-bound Transform into the measured donor, neutral initial Attack, the method's **successful** reduction count, and no intervening encounter; spent PP does not negate observed successful reductions. Misses and “nothing happened” do not count. Switch to the Growl carrier after Transform as needed; avoid Haze, another Transform and other stage changes; escape Ditto instead of defeating it. The pinned lowering code can restore a stage when the effective stat reaches one; observed successful reductions remain authoritative.

Oak player branches are Bulbasaur→team1/6Growls/Blastoise, Charmander→team2/5Growls/Venusaur, Squirtle→team3/4Growls/Charizard. All teams have Tauros66, Exeggutor67, Arcanine68, chosen evolved starter69, Gyarados70. Missing branch provenance stays unknown. A victory against the wrong starter roster is insufficient.

Mew's Medium Slow level1 EXP is−54 stored as24-bit `0xFFFFCA` (16777162). EXP awards1–53 keep it near the maximum and invoke the level100 cap;54 wraps to zero. Two surviving participants, own untraded Mew first, one switch, wild Route1 L2/L3 Pidgey or Rattata, no trainer bonus and no Exp. All are the supported sourced calculation. Base EXP is divided among participants **before** multiplication by level: Pidgey7/11 and Rattata8/12. Exp. All's raw item ID is75 (`$4B`). A current level100 snapshot is never a transition.

Rare Candy must be actual ordered slot6, quantity1 at preparation. OR128 gives1→129, then127→255; this is not unconditional+128. A sorted equivalent bag or a different starting quantity fails the predicate. Normalize different quantities using ordinary handling first. Compatibility is name/encoded-encounter-dependent; a Cinnabar visit or Ditto is insufficient.

Collection counts deduplicate only owned legitimate Dex IDs1–151. Seen flags, padding/glitch IDs, held-mon counts and public fixture provenance are insufficient. `collection.missingDex` retains unknown when owned flags are unreadable. `targets` supplies the source-audited Special values and normal follow-ups for Mew, trade evolutions, missing starter/version/fossil/dojo families and Eevee. Each target's `measured` uses current party stats. Selecting a target checks its exact Special. Ordinary catches use neutral stage7 and zero successful Growls. No donor is promised to reach every value. An existing151 snapshot displays collection status but cannot prove the below151→151 final acquisition or grant an award.

## Transport and reservations

On a finished main save every trainer is beaten, so the trainer-free PC underflow is the transport for the three Special-encounter methods; Trainer-Fly is listed only for a save that still has both trainers unbeaten, and it never holds back trainers in the main run. All Glitch Showcase work happens on a renamed copy of the completed main save (Speedrun? on an empty copy), with the subset opted out until main and Oak are mastered.

`GlitchPlan.transports` contains two separate candidates, without adding a ninth chosen objective. Both remain sourced/blocked; their `prerequisites` describe preflight eligibility for a new transport use. The selected method's `encounter.assessment` governs its actual setup phase; do not substitute transport preflight for an existing pending encounter. `ordinary-trainer-fly` requires Fly/field badge and both actual unbeaten flags:

- Route8 north-facing Gambler `(13,9)`, sight4, `EVENT_BEAT_ROUTE_8_TRAINER_1`. Release him only after final planned use, then legitimately defeat him.
- Route25 Youngster2 `(18,5)`, `EVENT_BEAT_ROUTE_25_TRAINER_1`. He must walk at least one tile; his release battle consumes the trainer.

Either defeated flag blocks ordinary transport even with Ditto and measured Special. Unknown flags stay unknown. Two reservations do not establish unlimited repeated encounters for151. Default canonical all-trainer clearance reserves neither indefinitely. `GlitchPlan.reservations` is empty unless the user explicitly selects ordinary Trainer-Fly; consumed trainer flags and eligible final-use evidence release them. Main trainer clearance stays outstanding while these battles are reserved.

The trainer-free PC-underflow candidate carries its exact sourced A×1/B×1/C×255, N−2 tosses,253 toss, two swaps, absolute slot100,255 toss and Route24 trigger sequence in transport instructions. This crosses unrelated memory, so canonical-safe operation and repeatability remain unavailable. Verify slot numbering, affected bytes, key items, bag/PC contents, trainer flags and ordinary postgame behavior in separately stored controlled SRAM before any support promotion. No random glitch item use, key-item discards or backup restoration is recommended.

## Manual history keys

Use existing `record-manual` with active attempt/revision. Source audits remain dataset-owned, never user-editable validation. Relevant keys are:

- `rule:<id>:completed`: attributed event/transition completion, with the method's evidence description and note; does not mean hardcore earned.
- `protected-main-oak-complete`, `protected-safari-complete`: historical protection confirmations. A true current flag or unrelated account award cannot prove the order.
- `glitch:physically-isolated`: user confirmation of externally configured separate emulator SRAM. Naming an attempt is insufficient.
- `glitch:transport`: string `ordinary-trainer-fly` or `pc-underflow`; `glitch:trainer-fly-final-use-complete` for reservation release. Exact underflow setup is now confirmed through the scoped control below.
- `glitch:ditto-access` remains access preparation. Transform, neutral Attack, no intervening encounter, successful Growls and exact underflow setup use generated scoped confirmation controls. Old shared `glitch:*` records for those observations are visible history only and cannot certify a current encounter.
- `glitch:balls-and-finisher`, `glitch:mew-own-untouched`, `glitch:oak-battle-supplies` remain preparation. Exact EXP award uses the numeric setup-bound control; shared old `glitch:exp-award` history cannot certify a new Mew setup.
- `glitch:old-man-compatible`: observed appropriate encoded-name encounter eligibility, not guessed from Cinnabar location.
- `glitch:celadon-access`, `glitch:safari-entry-fee` (¥500). `glitch:cinnabar-access` is retired (the Route 20 method was replaced); old marks stay visible under More → Marks no longer used.
- `glitch:subset-opted-in-after-mastery`: the Glitch Showcase subset is opted in only for a save copy, after main and Oak are mastered (every method requires it).
- `glitch:fresh-start`. The former `glitch:rival-name`=`JOHN` and RED/TID25794 checks are retired: names do not matter for the casual routes.
- `glitch:own-collection`, `glitch:collection-start-below151`, `glitch:balls-and-storage`, numeric `glitch:collection-target-dex` selecting a sourced target. The scoped Growl count must be0 for ordinary catches.

## Encounter setup controls and lifetime

Special-based methods57642/45/55 expose `encounter: GlitchEncounterAssessment` with `identity: Fact<GlitchSetupIdentity>`, explicit `phase`, current phase `assessment`, and labelled controls. Identity binds method, selected transport, current donor party slot/internal species/Special, source revision and required Growl count. Every Start action appends a persisted manual start record; its new UUID is `setupId`, and its ordinal among start records is the setup generation. Repeated Start clicks create new identities even for the same donor; old confirmations remain history.

The latest start must be active and eligible and match this method/source/transport/branch count. Before the catch boundary it must match actual donor stats/slot; the Mew continuation exception below retains completed encounter history without requiring that live slot. Malformed metadata, unknown stats, different donor or method, and older unscoped observations cannot supply current proof. The shared pure codec/signature lives in `src/state/glitch-setup.ts`; state does not import planner logic. The donor signature intentionally excludes snapshot hash, PP and trainer flags, so legitimate forward imports do not invalidate an otherwise matching setup.

Before the catch boundary, `commitObservation` permanently marks the latest start for review if the bound donor changes or becomes unreadable. A later matching snapshot cannot revive it. A strictly catch-compatible import may retain only the observation opportunity below, and an attributed completed catch ends donor-slot checking. Project restoration and Undo of an app reset likewise retain historical records while marking the current start for review; a backup cannot restore a live pending encounter. Existing persistent completion history keeps its established meaning. Generic `reconfirm-manual` cannot copy a start record: use the labelled Start/new setup control to capture current resources. No persistence-schema addition is required; setup metadata uses the existing bounded string-value manual record format.

Phases separate resource lifetime:

- `preflight`: both concrete trainers undefeated, Fly/field badge, current measured donor, enough initial Growl PP; underflow requires physical isolation. Missing setup identity remains unknown even when resources exist.
- `restored` (ordinary Trainer-Fly only): starting preflight resources must have been observed, escaped Gambler remains undefeated, the release trainer is now defeated, scoped escape and walked-trainer/menu-restoration observations exist, and Growl PP is available before Ditto.
- `pending`: starting preflight eligibility remains required; scoped restoration observations and consumed release flag remain required for ordinary transport. Scoped Transform, neutral initial Attack, exact successful Growls and no intervening encounter replace full remaining-PP checks. Underflow also needs its setup-bound exact-PC confirmation. Source/physical-isolation/current donor and other actual prerequisites remain assessed.
- `exp` (Mew only): a setup-associated intended level-one Mew catch ends live donor-slot, trainer/PP, balls and free-party-slot requirements. Current first-slot Mew, scoped own/untouched/finisher/two-participant conditions, actual EXP award and Exp.All exclusion govern the continuation. Current Mew and attributed catch history remain separate.

Starting preflight readiness is captured by the planner-created Start descriptor; entering `pending` cannot repair a trainer already lost or zero initial PP. This captured resource guard is user-attributed setup metadata, not independent runtime validation. It does not synthesize future trainer flags or party stats. Final method readiness remains source-blocked in every phase.

The UI renders the provided labels and value types rather than offering private-key entry:

- `startControls[]`: label `Start/new setup: party slot N, Special S`, with `action: {key,value,ruleId}`. Dispatch `{type:'record-manual', ...control.action}`. New controls require a selected supported transport and a current measured matching donor.
- `phaseControls[]`: labelled preflight/restored/pending/EXP actions in the same shape. Render the current phase and `encounter.assessment` reasons. These actions record user stage assertions, not game actions; the planner still verifies the phase prerequisites.
- `confirmationControls[]`: `{id,label,key,valueType,expected,minimum?,maximum?,observed}`. Render boolean confirmations or numeric fields using `valueType`; dispatch `record-manual` with the generated key, entered value and method ruleId. Successful Growls range0–6; actual EXP range1–53 (7 is only a suggested initial input, not a mandated award). Each key embeds the current setup record ID. Old keys and generic reconfirmation of their history cannot certify another setup.

Controls are method/transport-specific: ordinary transport supplies escape/restoration, PC underflow supplies exact setup, and only Mew supplies EXP entry. Actual game execution remains deferred behind the eight existing source/runtime gates. A setup confirmation is never an RA timestamp or dataset audit promotion.

## Mew catch boundary and EXP continuation

The donor's live slot lifetime ends at the intended catch, rather than extending through the level-jump battle. This matters when the Special21 donor began first: moving caught Mew into slot1 moves the donor to slot2, and the release trainer/PP are already consumed.

Mew adds labelled boolean controls `mew-caught-level-one` (observed intended encounter produced a level-one Mew caught into the party) and `mew-exp-conditions` (own untouched Mew first, healthy finisher, one switch/two surviving participants, supported wild opponent/no bonuses). The labelled `exp` phase action is “Caught intended level-one Mew; continue EXP step.” The original unique setup ID remains the EXP/catch scope. A genuinely new Start creates a new ID and cannot inherit the catch or EXP confirmations.

`encounter.continuation` is `none`, `catch-compatible` or `attributed-catch`. `encounter.currentMew?: Fact<PokemonObservation|null>` shows the **current** first-slot observation separately from the original donor binding and user-attributed event history. The method-wide `requiresMeasuredSpecial` still describes initial source procedure needs; current phase reasons determine whether a live donor is needed.

The shared pure state helper only accepts continuation for the eligible latest Special21/six-Growl Mew start with captured ready preflight, a scoped pending phase and complete scoped escape/restoration (ordinary transport) or exact-PC setup (underflow), Transform, initial neutral Attack, six successes and no intervening encounter. `attributed-catch` additionally requires the explicit catch observation and EXP phase. This ends donor-slot checking, so the later donor can move/box/change without triggering another encounter-preparation demand. Other source/continuity/attempt/isolation guards still apply.

No intermediate save is required. The player may record the actual catch boundary before the next import. If catch and party reorder occur before that import and before manual confirmation, the helper may retain a **catch-compatible** pending context only when the current first-slot Pokémon is observed Mew at level1 and the same measured donor signature is now in another party slot. This preserves labels/history so the actual catch can be confirmed afterward; it cannot establish the catch, advance readiness, prove a level jump or grant an award. Premature/unrelated drift without those compatible facts still reviews the start permanently.

Once the catch is attributed, `exp` readiness uses current level-one Mew first, scoped EXP conditions, at least two party members, readable Exp.All exclusion and the exact1–53 award. It no longer asks for donor Special/Growl/Ditto access, balls or a free catch slot. A full party after capture is valid. A later level100 observation retains the controls and catch history but leaves the battle transition unproven/unknown; only attributed event history and the matching external hardcore feed retain their respective meanings. Source validation blockers remain unchanged.

Restore/Undo still review the start even after an attributed catch; generic reconfirm cannot copy it. Old backup observations, old setup IDs and new encounters cannot revive the EXP continuation. The app records observations only and never rearranges the party or writes emulator SRAM.

## Open release gates

All eight methods require exact target ROM hash/language/revision, frontend/core/version, loaded subset/hardcore configuration, exact starting facts/procedure, observations/deviations/final state, recovery boundary and legitimate earned-at evidence. Exact crash recipe/diagnostics, manual TID setup/timing, accepted Glitch City destination, safe/repeatable PC underflow, Trainer-Fly geometry/release behavior, successful Growls/EXP/starter roster, compatible old-man table and151 acquisition transition remain open. Validate without deliberately inducing accidental achievement-code unlocks. No target-runtime observation has been invented in these records.
