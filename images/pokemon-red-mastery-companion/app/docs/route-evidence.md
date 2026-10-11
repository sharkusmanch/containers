# Canonical route and Areas evidence

`planRun(input: PlanInput): RunPlan` preserves the 28 source stages and produces ordered stage/rule actions, eight exact Oak gym assessments, 234 independent achievement assessments, current acquisition plans, reservations and diagnostics. Main93 + Oak133 have concrete guidance. Glitch8 assessments deliberately refer to the separate glitch planner and remain unknown here. Readiness describes current preparation or eligible attempt history; it never establishes a hardcore award.

## Additive Task6 / Task8 contract

- `Dataset.areas?: AreaChecklist[]` carries concrete source entries. `RunPlan.areas?: AreaAssessment[]` assesses the same entries without UI code. Both are optional for backward-compatible datasets/consumers; the shipped dataset/planner supplies them.
- Entry identity: `id`, `area`, `routeStepId`, `kind`, `title`, `ruleIds`, `instructions`, `sourceUrls`, `manualKey`. Optional `rawItemId`, `x`, `y`, `deadline`, `deferredUntil` support labels/maps/Next guidance.
- `observation` identifies a flag namespace, key and literal source meaning. `proof` is `direct`, `manual`, `spawned`, `trainer-before-leader` or `resolution`; optional `spawnEvent` / `invalidatedByEvent` are source guards. UI must display assessed results, rather than reimplement these guards or turn a raw true flag into completion.
- Entry results separate `observed: Fact<boolean>` (literal current flag), `completion: Fact<boolean>` (the *entry's named obligation* after semantic guards), `evidence: 'save' | 'manual' | 'unknown'`, visible `manualEvidence`, and reasons. A static entry's completion means **resolved**, never captured. A `manual` result is attributed user history, not save proof. Unknowns retain reasons.
- To confirm an entry, dispatch existing `record-manual` with `key: entry.manualKey` and a boolean value. Rule completion uses `rule:<id>:completed`; session preparation uses existing `rule:<id>:session-prepared`. These keys do not establish an RA unlock. `manualEvidenceIsEligible` must accept history for the active attempt/revision; flagged history stays visible.
- Extra preparation keys: `safari:supplies-ready`, `safari:prior-pickup`, `hideout:clear-before-giovanni`, `cave:supplies-ready`, and `rule:<id>:prepared` where no complete save-observable preparation predicate exists. `safari:supplies-ready` confirms entry funding, remaining hunt steps/balls and sufficient storage as appropriate. Session completion still requires its own rule history. Source cutoff keys already declared by rules remain supported.
- `RunPlan.acquisitions?: AcquisitionPlan` exposes Task4 output. `heldInstances` always means currently observed instances; conditional plans do not synthesize future Pokémon into the snapshot. Trade and evolution allocations are plan-local.
- Task6 may reuse `evaluatePredicate(predicate,input,rule?)`, `flagFact`, `manualFact`, `heldPokemon` and the three-valued assessment helpers. Special uses observed party stats; unreadable stats stay unknown. These helpers do not validate any glitch procedure.

Actions retain all instructions even when an account-wide award exists. Eligible attempt completion is called out in reasons. Account identity/backing game must match before a feed supplies `hardcoreEarned`. Reservations release only on eligible current-attempt evidence or a specifically sufficient current source fact. Old account unlocks and `continuityBaseline` never supply current prerequisites or release resources.

The raw checkpoint helper's `missed` means the current preparation opportunity has passed; `planRun` converts that to historical **unknown**, since a late party/badge cannot establish failure. Definite missed examples require observed unmet durable obligations after a cutoff (ship pickups/trainers or Silph trainers) or eligible explicit failure history. Current final flags cannot reconstruct a quiz session, Doll method, Safari hunt or historical arrival count.

## Source scope and checklist inventory

Pinned factual source: [pret/pokered af519899719f0754965776faac0e836a3b906e6d](https://github.com/pret/pokered/tree/af519899719f0754965776faac0e836a3b906e6d). Achievement guidance: [main guide](https://github.com/RetroAchievements/guides/wiki/Pokemon-Red-Version-%28Game-Boy%29), current published inventory and the independently recorded domain/area audits. Entry URLs retain source files and coordinates. Task5's scratch audit independently checks trainer source identities, real trade row indices and the exact 50-disk set; tests also compare all104 visible pickups with the independently transcribed source oracle.

Physical lists include Forest3 trainers/5items; Mt. Moon12/10 plus chosen fossil; ship16/8 plus conversation/Cut; Rock Tunnel15/0; Hideout11 optional Rockets + Giovanni,15 pre-Scope pickups + Scope; Tower16 optional trainers + Rival/ghost,8items; Safari11 protected optional items plus Gold Teeth/HM03 exceptions; Silph30trainers/16physical items/20doors plus TM36; Victory11ordinary trainers + Moltres/10items; all15 stationary encounters. Regional maps, optional gym/Dojo trainers, coin tiles/patrons, journal/quiz coordinates, six Pokémon gifts, nine actual trades and all50 field disks are explicit.

The 104 visible item operands and 52 obtainable hidden items are physical source records. Inaccessible Safari Gate hidden16 and unused-map hidden34 are excluded. Global Living Itemfinder still needs decoded gift membership verification; it is never inferred from a 104+52 conjunction. Global trainer guidance follows guide exclusions (gym/Dojo, ship, Silph, Nugget Bridge recruiter, story bosses/rivals/statics), while those physical entries remain available for other obligations. Exact RA trigger membership is unverified.

Semantic exceptions are intentional:

- Ordinary initially ON pickups hide only after successful GiveItem; hidden-item bits likewise follow receipt. Lift Key and Scope start OFF and require their spawn events first.
- Gym leaders/Dojo master can mass-set unfought trainer bits. Silph Giovanni hides NPCs without proving their battles. Static resolution is not capture.
- Route1 Potion interaction is set before GiveItem and may lose receipt to a full bag. Mansion journals and ship conversation have no persistent history bit. Quiz gates also open after battles.
- Fossil processing flags reset; both Moon fossils are hidden after a choice. Neither mechanism proves receipt of both fossil species. Six gifts exclude the starter and include the purchased Magikarp.
- The coin namespace is separate; a collected tile does not prove credited balance when the wallet is full.

Main/source guidance and runtime validation remain separate. No Task5 synthetic test or source checklist promotes main93, Oak badge8 or Champion to fully validated. The prior124 Oak knowledge records retain their scoped validation. Thus **110 rules, all8 glitch methods and all existing runtime gates remain open**. In particular the physical Safari count is eleven, but decoded trigger enumeration/reset boundaries, real later-state reader fixtures, actual target ROM/core/configuration, loaded hardcore subsets and successful runtime sessions remain required before a full-coverage release candidate.

## Integrated display metadata (Task8)

`AchievementAssessment.manualControls?: ManualControl[]` adds planner-owned keys, plain labels, expected values/value types, observation scope and optional rule attribution. `planRun` supplies rule evidence, declared manual prerequisites and the custom prerequisite controls actually consulted by the planner. Cross-rule obligations retain the prerequisite rule’s label/ID (for example ship conversation before receiving Cut). Generic shared encounter observations are excluded; the Glitch planner’s per-setup descriptors remain the only current Transform/Growl/catch/EXP controls. No control edits dataset audit status or an account unlock.

`src/planner/display.ts` also supplies `suggestedStage(input)` and `heldSummary(snapshot,dex)`. The stage is only an initial UI suggestion, using current observed location, early gift window and badge progression; all 28 stages remain selectable. It never marks a historical stage complete. Held summaries count current observed instances, exclude the superseded active archive and explicitly preserve unknown storage/unreadable-species uncertainty.

The integrated UI renders assessed Area completion and literal observations separately. It does not rebuild source flag semantics. Manual entry/history uses existing record/reconfirm/archive paths and `manualEvidenceIsEligible`, with current setup starts excluded from generic reconfirmation. Source/readiness, user-attributed history and independent HC feeds remain separate in all screens.
