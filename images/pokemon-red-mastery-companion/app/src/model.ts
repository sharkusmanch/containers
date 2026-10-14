/** Shared contracts. Unknown facts never imply zero, absence, completion or readiness. */
export type SetKey = 'main' | 'oak' | 'glitch'
export type AttemptKind = 'canonical' | 'glitch' | 'speedrun'
export type Fact<T> = { known: true; value: T } | { known: false; reason: string }
export type Readiness = 'ready' | 'blocked' | 'unknown' | 'missed'
export type AuditStatus = 'sourced' | 'validated'
export type SourceKind = 'upload' | 'url'
export interface TrainerObservation { name: string; id: number }
export type PokemonLocation = { kind: 'party'; slot: number } | { kind: 'box'; index: number; slot: number } | { kind: 'daycare' }
export interface PokemonObservation { internalSpeciesId: number; listedSpeciesId?: number; dexNumber: number | null; location: PokemonLocation; level: Fact<number>; moves: Fact<{ id: number; pp: number; ppUps: number }[]>; special: Fact<number> }
export interface BoxObservation { index: number; pokemon: PokemonObservation[] }
export interface BagSlot { position: number; rawItemId: number; quantity: number }
export interface LocationObservation { mapId: number; name?: string; x?: number; y?: number }
export interface PlayTimeObservation { hours: number; minutes: number; seconds: number }
export interface SaveSnapshot {
  profileId: string; hash: string; importedAt: string
  trainer: Fact<TrainerObservation>; battleStyle: Fact<'set' | 'shift'>; badgeMask: Fact<number>
  ownedDex: Fact<number[]>; seenDex: Fact<number[]>; party: Fact<PokemonObservation[]>
  currentBox: Fact<BoxObservation>; archivedBoxes: Fact<BoxObservation[]>; daycare: Fact<PokemonObservation | null>
  bag: Fact<BagSlot[]>; pcItems: Fact<BagSlot[]>; events: Fact<Record<string, boolean>>
  location: Fact<LocationObservation>; playTime: Fact<PlayTimeObservation>; hallOfFame: Fact<boolean>
  /** Literal byte counts; archives indexed 0–11 include the superseded active record. */
  rawCounts?: { party: number; currentBox: number; currentBoxByte: number; archivedBoxes: number[]; bag: number; pcItems: number; daycare: number; hallOfFame: number }
  /** Separate namespaces. Object true means toggled off, not intrinsically collected. */
  objectFlags?: Fact<Record<string, boolean>>
  hiddenItemFlags?: Fact<Record<number, boolean>>; hiddenCoinFlags?: Fact<Record<number, boolean>>
  tradeFlags?: Fact<Record<number, boolean>>; statusFlags?: Fact<Record<string, boolean>>
  mapScriptStates?: Fact<number[]>; playTimeRaw?: number[]
}
export interface ParseIssue { code: string; message: string; section?: keyof SaveSnapshot; offset?: number }
export type ParseResult = { status: 'readable' | 'partial'; snapshot: SaveSnapshot; issues: ParseIssue[] } | { status: 'rejected'; issues: ParseIssue[] }
export interface ImportContext { projectId: string; attemptId: string; sourceRevision: number; sourceKind: SourceKind; generation: number }
/** origin: 'deployment' = adopted from the private server's app-config; 'user' = set explicitly in source settings. */
export interface SaveSource { kind: SourceKind; url?: string; revision: number; label?: string; lastImportAt?: string; lastError?: string; enabled?: boolean; paused?: boolean; origin?: 'deployment' | 'user' }
export interface BranchChoices { starter?: 'bulbasaur' | 'charmander' | 'squirtle'; fossil?: 'helix' | 'dome'; dojo?: 'hitmonlee' | 'hitmonchan'; eevee?: 'vaporeon' | 'jolteon' | 'flareon'; moonstones?: number[] }
export interface ManualEvidence { id: string; attemptId: string; continuityRevision: number; status: 'active' | 'needs-review' | 'archived'; key: string; value: boolean | number | string; recordedAt: string; ruleId?: number; note?: string }
/** Historical comparison guards only; never current-save facts or readiness evidence. */
export interface ContinuityBaseline { trainer?: TrainerObservation; playTime?: PlayTimeObservation; ownedDex?: number[]; badgeMask?: number }
export interface Attempt { id: string; name: string; kind: AttemptKind; continuityRevision: number; continuityBaseline?: ContinuityBaseline; source: SaveSource; snapshot: SaveSnapshot | null; manualEvidence: ManualEvidence[]; branches: BranchChoices; createdAt: string; importGeneration?: number; diagnostics?: string[]; lastImportedHash?: string; ignoredHashes?: string[]; heldImport?: { context: ImportContext; snapshot: SaveSnapshot; issues: ParseIssue[] } }
export interface HardcoreUnlock { achievementId: number; earnedAt: string }
export interface HardcoreProgress { setKey: SetKey; apiGameId: number; accountIdentity: string | null; lastSuccessfulFetchAt: string | null; stale: boolean; unlocks: HardcoreUnlock[]; unavailableReason?: string }
export interface HardcoreRefreshResult { progress: HardcoreProgress[]; failures: { setKey: SetKey; reason: string }[] }
export interface MasteryProject { id: string; version: number; accountIdentity: string | null; activeAttemptId: string; attempts: Attempt[]; importGeneration: number; accountProgress: HardcoreProgress[]; createdAt: string; updatedAt: string; pendingImport?: ImportContext | null; resetUndo?: { attempt: Attempt; importGeneration: number }; recoveryError?: string }
export type Predicate =
  | { kind: 'all' | 'any'; predicates: Predicate[] }
  | { kind: 'not'; predicate: Predicate }
  | { kind: 'owned'; dexNumbers: number[]; minimum?: number }
  | { kind: 'owned-count'; minimum: number }
  | { kind: 'branch-owned'; groupId: string }
  | { kind: 'event'; flag: string; value: boolean }
  | { kind: 'badge'; mask: number; obtained: boolean }
  | { kind: 'party-level'; maximum: number }
  | { kind: 'party-size'; minimum: number; maximum: number }
  | { kind: 'party-species'; allowed: number[]; excluded?: number[] }
  | { kind: 'battle-style'; value: 'set' | 'shift' }
  | { kind: 'item'; rawItemId: number; minimum: number; position?: number; exactQuantity?: number }
  | { kind: 'move'; moveId: number }
  | { kind: 'special'; value: number; observed: true }
  | { kind: 'manual'; key: string; expected?: boolean | number | string }
  | { kind: 'attempt-kind'; allowed: AttemptKind[] }
  | { kind: 'section-readable'; section: keyof SaveSnapshot }
export interface BranchOption { value: string; dexNumbers: number[] }
export interface BranchGroup { id: string; choiceKey?: keyof BranchChoices; options: BranchOption[]; minimumDistinct?: number; requiredAll?: boolean }
export interface MissableCutoff { id: string; when: Predicate; message: string }
export interface PreservationObligation { id: string; resource: 'item' | 'trainer' | 'pokemon' | 'pickup' | 'session' | 'choice'; description: string; consumingRuleId: number; releaseAfterRuleId: number; predicate?: Predicate }
export interface EvidenceRequirement { kind: 'save' | 'manual' | 'hardcore'; description: string; section?: keyof SaveSnapshot; key?: string }
export interface AttemptPolicy { allowedKinds: AttemptKind[]; placement: 'canonical' | 'postgame' | 'separate' | 'fresh'; protectedRunRequired: boolean }
export interface AchievementRule {
  id: number; setKey: SetKey; title: string; objective: string; points: number
  prerequisites: Predicate[]; cutoffs: MissableCutoff[]; branches: BranchGroup[]
  preservation: PreservationObligation[]; evidence: EvidenceRequirement[]; attemptPolicy: AttemptPolicy
  routeStepIds: string[]; instructions: string[]; sourceUrls: string[]; auditStatus: AuditStatus
  validationEvidence?: string[]; tags?: string[]; acquisitions?: CanonicalAcquisition[]
  /** In-game RA counter target. Exactly this many area entries carry the rule ID; uncounted extras use uncountedFor. */
  counter?: AchievementCounter
}
export interface AchievementCounter { total: number; unit: string; note: string }
export interface RouteStep { id: string; order: number; area: string; title: string; instructions: string[]; ruleIds: number[]; prerequisites: Predicate[]; preserves: PreservationObligation[]; checkpoint?: GymCheckpoint; afterStepIds?: string[]; session?: string }
/** orderGroup: checkpoints sharing a group may be beaten in any order once every earlier checkpoint is done (Oak Badges V–VII). marginAdvice: the guide's safer party level, below the hard cap. */
export interface GymCheckpoint { leader: string; badgeMask: number; ownedCount: number; requiredDex: number[]; branchGroups: BranchGroup[]; levelCap: number; ruleIds: number[]; orderGroup?: string; marginAdvice?: number }
export type CanonicalPhase = 'brock' | 'misty' | 'koga' | 'erika' | 'surge' | 'league' | 'postgame'
export type AcquisitionMilestone = 'old-rod' | 'good-rod' | 'super-rod' | 'surf' | 'strength' | 'moon-stone' | 'celadon-stones'
export interface CanonicalAcquisition { targetDex: number; phase: CanonicalPhase; method: Encounter['method'] | 'level' | 'item' | 'trade'; area?: string; executionArea?: string; level?: number; rawItemId?: number; sourceDex?: number; sourceUrl: string; dependencies: CanonicalAcquisition[]; requiredMilestones: AcquisitionMilestone[]; historyRuleIds: number[] }
export interface Evolution { method: 'level' | 'item' | 'trade'; targetDex: number; level?: number; rawItemId?: number }
export interface Species { dexNumber: number; internalSpeciesId: number; name: string; symbol: string; evolutions: Evolution[]; levelMoves: { level: number; moveId: number }[]; baseStats: { hp: number; attack: number; defense: number; speed: number; special: number }; sourceUrls: string[] }
export interface Encounter { dexNumber: number; area: string; method: 'grass' | 'surf' | 'old-rod' | 'good-rod' | 'super-rod' | 'gift' | 'static' | 'purchase'; level: number; sourceUrl: string; prerequisite?: Predicate }
export interface Trade { giveDex: number; receiveDex: number; area: string; nickname: string; sourceUrl: string }
export interface Pickup { area: string; x: number; y: number; rawItemId: number; kind: 'visible' | 'hidden'; objectFlag?: string; hiddenFlagIndex?: number; inaccessible: boolean; sourceUrl: string }
export interface GameData { profileId: string; saveSize: number; species: Species[]; encounters: Encounter[]; trades: Trade[]; eventFlags: Record<string, number>; objectFlags: Record<string, number>; pickups: Pickup[]; itemIds: Record<string, number>; moveIds: Record<string, number>; sourceCommit: string }
export interface AchievementSet { key: SetKey; title: string; siteSetId: number; apiGameId: number; expectedPublishedIds: number[]; sourceUrl: string }
export interface DatasetManifest { version: string; publishedCheckedAt: string; sourceCommit: string; sources: { url: string; purpose: string }[]; runtimePrerequisites: { id: string; description: string; status: 'pending' | 'verified'; evidence?: string }[] }
export interface GlitchMethod {
  id: string; ruleId: number; title: string; attemptPolicy: AttemptPolicy; prerequisites: Predicate[]
  instructions: string[]; requiredMoves: number[]; requiredItems: { rawItemId: number; quantity: number; position?: number }[]
  measuredSpecial: number[]; consumedTrainerFlags: string[]; branches: BranchGroup[]
  evidence: EvidenceRequirement[]; recoveryBoundary: string; sourceUrls: string[]; auditStatus: AuditStatus
  validationEvidence?: string[]; validationBlockers?: string[]; oakRosters?: Record<string, OakGlitchRoster>; collectionTargets?: { dexNumber: number; special: number; followUp: string }[]; experienceRoute?: GlitchExperienceRoute; warnings: string[]; transport?: 'none' | 'pc-underflow' | 'trainer-fly' | 'save-corruption' | 'old-man' | 'safari-exit' | 'pending'; successfulGrowls?: number | { bulbasaur: number; charmander: number; squirtle: number }; experienceAward?: { minimum: number; maximum: number }
}
export interface Dataset { areas?: AreaChecklist[]; manifest: DatasetManifest; sets: AchievementSet[]; game: GameData; route: RouteStep[]; rules: AchievementRule[]; glitches: GlitchMethod[] }
export type DatasetIssueCode = 'unpublished-rule' | 'missing-rule' | 'duplicate-rule' | 'duplicate-method' | 'duplicate-route' | 'missing-source' | 'unresolved-reference' | 'unvalidated-rule' | 'unvalidated-method' | 'missing-guidance' | 'missing-placement' | 'missing-evidence' | 'missing-validation-evidence' | 'runtime-prerequisite' | 'invalid-membership' | 'inaccessible-acquisition' | 'counter-mismatch'
export interface DatasetIssue { code: DatasetIssueCode; message: string; ruleId?: number; methodId?: string; reference?: string }
export interface PlanInput { project: MasteryProject; attempt: Attempt; dataset: Dataset }
export interface PredicateAssessment { readiness: Readiness; reasons: string[] }
export interface ManualControl { key: string; label: string; expected: boolean | number | string; valueType: 'boolean' | 'number' | 'string'; scope: string; ruleId?: number }
export interface AchievementAssessment { manualControls?: ManualControl[]; ruleId: number; readiness: Readiness; reasons: string[]; hardcoreEarned: boolean; earnedAt?: string; manualEvidence: ManualEvidence[] }
export interface PlannedAction { id: string; routeStepId: string; ruleIds: number[]; title: string; instructions: string[]; readiness: Readiness; reasons: string[]; order: number }
export interface CheckpointAssessment { stepId: string; leader: string; readiness: Readiness; ownedCount: Fact<number>; requiredCount: number; missingDex: number[]; reasons: string[] }
export interface Reservation { id: string; consumingRuleId: number; releaseAfterRuleId: number; description: string; readiness: Readiness }
export interface RunPlan { areas?: AreaAssessment[]; acquisitions?: AcquisitionPlan; actions: PlannedAction[]; checkpoints: CheckpointAssessment[]; achievements: AchievementAssessment[]; reservations: Reservation[]; diagnostics: string[] }
export interface AcquisitionPath { targetDex: number; method: 'catch' | 'evolve' | 'trade' | 'gift' | 'static' | 'purchase' | 'unavailable'; sourceDex?: number; area?: string; level?: number; rawItemId?: number; readiness: Readiness; reasons: string[]; instructions: string[] }
export interface AcquisitionTarget { dexNumber: number; registered: Fact<boolean>; heldInstances: PokemonObservation[]; paths: AcquisitionPath[]; missingResources: string[] }
export interface AcquisitionPlan { targets: AcquisitionTarget[]; alreadyRegistered: number[]; missingResources: string[]; diagnostics: string[] }
export interface OakGlitchRoster { teamNumber: number; successfulGrowls: number; starter: string; members: { species: string; level: number }[] }
export interface GlitchExperienceRoute { minimum: number; maximum: number; initialExperience: number; participants: number; awards: { species: string; level: number; exp: number }[] }
export interface GlitchTrainerReservation { flag: string; trainer: string; geometry: string; releaseAfter: string }
export interface GlitchTransportAssessment {
 methodId: 'ordinary-trainer-fly' | 'pc-underflow'; readiness: Readiness; reasons: string[]; prerequisites: PredicateAssessment
 auditStatus: AuditStatus; instructions: string[]; warnings: string[]; sourceUrls: string[]; reservations: GlitchTrainerReservation[]
}
export interface GlitchCollectionAssessment { ownedCount: Fact<number>; missingDex: Fact<number[]>; targets: { dexNumber: number; special: number; missing: Fact<boolean>; measured: Fact<boolean>; followUp: string }[] }
export interface GlitchManualAction { key: string; value: boolean | number | string; ruleId: number }
export type GlitchSetupPhase = 'preflight' | 'restored' | 'pending' | 'exp'
export interface GlitchSetupIdentity {
 setupId: string; generation: number; methodId: string; transport: string
 donor: { slot: number; internalSpeciesId: number; special: number }; successfulGrowls: number; sourceRevision: number; preflightReadiness: 'ready' | 'blocked' | 'unknown'
}
export interface GlitchEncounterAssessment {
 identity: Fact<GlitchSetupIdentity>; phase: GlitchSetupPhase; assessment: PredicateAssessment
 currentMew?: Fact<PokemonObservation | null>; continuation: 'none' | 'catch-compatible' | 'attributed-catch'
 startControls: { label: string; action: GlitchManualAction }[]
 phaseControls: { label: string; phase: GlitchSetupPhase; action: GlitchManualAction }[]
 confirmationControls: { id: string; label: string; key: string; valueType: 'boolean' | 'number'; minimum?: number; maximum?: number; expected: boolean | number; observed: Fact<boolean | number | string> }[]
}
export interface GlitchMethodAssessment {
 methodId: string; ruleId: number; readiness: Readiness; reasons: string[]; instructions: string[]; auditStatus: AuditStatus
 /** Preparation is distinct from validation and official earned status. */
 prerequisites: PredicateAssessment; validationBlockers: string[]; sourceUrls: string[]; evidence: EvidenceRequirement[]
 placement: AttemptPolicy['placement']; requiredAttemptKind: AttemptKind; requiresPhysicalIsolation: boolean; nextAction: string; recoveryBoundary: string
 requiresMeasuredSpecial: boolean; measuredDonors: { slot: number; special: number; internalSpeciesId: number; importedAt: string }[]
 transitionEvidence: Fact<boolean>; manualEvidence: ManualEvidence[]; hardcoreEarnedAt: string | null
 encounter?: GlitchEncounterAssessment; oakRoster?: OakGlitchRoster; experienceRoute?: GlitchExperienceRoute; collection?: GlitchCollectionAssessment
}
export interface GlitchPlan { methods: GlitchMethodAssessment[]; transports: GlitchTransportAssessment[]; reservations: GlitchTrainerReservation[]; diagnostics: string[] }

/** Concrete Areas entries describe physical source semantics, not decoded RA trigger membership. */
export type FlagNamespace = 'events' | 'objectFlags' | 'hiddenItemFlags' | 'hiddenCoinFlags' | 'tradeFlags' | 'statusFlags'
export interface AreaChecklistEntry {
 id: string; area: string; routeStepId: string; kind: 'trainer' | 'pickup' | 'door' | 'static' | 'gift' | 'trade' | 'session' | 'coin'
 title: string; ruleIds: number[]; instructions: string[]; sourceUrls: string[]; manualKey: string
 observation?: { namespace: FlagNamespace; key: string; meaning: string }
 /** A true flag supports this entry only under these explicitly audited limitations. */
 proof: 'direct' | 'manual' | 'spawned' | 'trainer-before-leader' | 'resolution'
 spawnEvent?: string; invalidatedByEvent?: string; rawItemId?: number; x?: number; y?: number
 deadline?: string; deferredUntil?: string
 /** Counter rules this entry is still advised for but reportedly does not move (e.g. Genocide Route "fight anyway"). Never counted. */
 uncountedFor?: number[]
}
export interface AreaChecklist { id: string; title: string; entries: AreaChecklistEntry[] }
export interface AreaEntryAssessment {
 entry: AreaChecklistEntry; observed: Fact<boolean>; completion: Fact<boolean>
 evidence: 'save' | 'manual' | 'unknown'; manualEvidence: ManualEvidence[]; reasons: string[]
}
export interface AreaAssessment { id: string; title: string; entries: AreaEntryAssessment[] }
/** Checklist progress toward a counter rule: save flags and the player's own marks only, never an award. */
export interface CounterProgress { ruleId: number; total: number; listed: number; done: number; unknown: number; outstanding: number; uncounted: number }
