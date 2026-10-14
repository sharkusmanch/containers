import type { Attempt, AttemptKind, ContinuityBaseline, ImportContext, ManualEvidence, MasteryProject, ParseResult, SaveSnapshot, SourceKind } from '../model'
import { glitchDonorMatches, glitchSetupKey, mewContinuation, parseGlitchSetup } from './glitch-setup'

export function activeAttempt(project: MasteryProject): Attempt {
  const attempt = project.attempts.find(a => a.id === project.activeAttemptId)
  if (!attempt) throw new Error('Active attempt is missing')
  return attempt
}
/** Include every involved counter so restoration and Undo cannot resurrect tokens. */
export function nextGeneration(...projects: MasteryProject[]): number {
  const highest = Math.max(0, ...projects.flatMap(p => [p.importGeneration, p.pendingImport?.generation ?? 0,
    p.resetUndo?.importGeneration ?? 0, p.resetUndo?.attempt.importGeneration ?? 0, p.resetUndo?.attempt.heldImport?.context.generation ?? 0,
    ...p.attempts.flatMap(a => [a.importGeneration ?? 0, a.heldImport?.context.generation ?? 0])]))
  if (highest >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Import generation exhausted')
  return highest + 1
}
export function updateAttempt(project: MasteryProject, attempt: Attempt): MasteryProject {
  return { ...project, attempts: project.attempts.map(a => a.id === attempt.id ? attempt : a), updatedAt: new Date().toISOString() }
}
function freshAttempt(kind: AttemptKind, name: string): Attempt {
  return { id: crypto.randomUUID(), name, kind, continuityRevision: 0, source: { kind: 'upload', revision: 0, enabled: false, paused: false },
    snapshot: null, manualEvidence: [], branches: {}, ignoredHashes: [], createdAt: new Date().toISOString() }
}
export function createProject(accountIdentity: string | null = null): MasteryProject {
  const attempt = freshAttempt('canonical', 'Main / Oak'), now = new Date().toISOString()
  return { id: crypto.randomUUID(), version: 1, accountIdentity: accountIdentity?.trim() || null, activeAttemptId: attempt.id, attempts: [attempt], importGeneration: 0,
    accountProgress: [], pendingImport: null, createdAt: now, updatedAt: now }
}
export function createAttempt(project: MasteryProject, kind: AttemptKind, name: string): MasteryProject {
  const attempt = freshAttempt(kind, name)
  return { ...project, attempts: [...project.attempts, attempt], activeAttemptId: attempt.id, importGeneration: nextGeneration(project),
    pendingImport: null, updatedAt: new Date().toISOString() }
}
export function beginImport(project: MasteryProject, sourceKind: SourceKind): { project: MasteryProject; context: ImportContext } {
  const attempt = activeAttempt(project), generation = nextGeneration(project)
  const context: ImportContext = { projectId: project.id, attemptId: attempt.id, sourceRevision: attempt.source.revision, sourceKind, generation }
  const next = updateAttempt(project, { ...attempt, heldImport: undefined, importGeneration: generation,
    source: { ...attempt.source, paused: sourceKind === 'upload' } })
  return { project: { ...next, importGeneration: generation, pendingImport: context }, context }
}
export function tokenIsCurrent(project: MasteryProject, context: ImportContext): boolean {
  const attempt = activeAttempt(project), pending = project.pendingImport
  return !!pending && context.projectId === project.id && context.attemptId === attempt.id && context.sourceRevision === attempt.source.revision &&
    context.generation === project.importGeneration && (['projectId', 'attemptId', 'sourceRevision', 'sourceKind', 'generation'] as const).every(key => pending[key] === context[key])
}
/** Held observations remain visible after invalidation, but cannot be assigned. */
export function heldImportIsCurrent(project: MasteryProject): boolean {
  const attempt = activeAttempt(project), held = attempt.heldImport
  return !!held && held.context.projectId === project.id && held.context.attemptId === attempt.id && held.context.sourceRevision === attempt.source.revision && held.context.generation === project.importGeneration
}
export function manualEvidenceIsEligible(record: ManualEvidence, attempt: Attempt): boolean {
  return record.status === 'active' && record.attemptId === attempt.id && record.continuityRevision === attempt.continuityRevision
}
const continuityNotices = new Set([
  'Trainer identity changed; history needs review.',
  'Clock regressed; continuity needs review, chronology is uncertain.',
  'Earlier observations differ; continuity needs review.',
  'Save source changed; history needs review.',
  'Previously unreadable comparisons; continuity needs review.',
  'Trainer identity changed; assign this save to an attempt.',
])
/** Keep review notices and the latest transient messages; polling cannot exhaust persistence. */
function importDiagnostics(previous: string[] = [], additions: string[]): string[] {
  const unique = [...new Set([...previous, ...additions].reverse())].reverse()
  const notices = unique.filter(message => continuityNotices.has(message))
  const transient = unique.filter(message => !continuityNotices.has(message)).slice(-(256 - notices.length))
  return [...notices, ...transient]
}
export function reviewContinuity(attempt: Attempt, reason: string): Attempt {
  return { ...attempt, continuityRevision: attempt.continuityRevision + 1,
    manualEvidence: attempt.manualEvidence.map(e => e.status === 'active' ? { ...e, status: 'needs-review' } : e), diagnostics: importDiagnostics(attempt.diagnostics, [reason]) }
}
/** Retain only the latest known comparison values, never copy these into a snapshot. */
function rememberContinuity(previous: ContinuityBaseline, snapshot: SaveSnapshot | null): ContinuityBaseline {
  if (!snapshot) return previous
  return { ...previous,
    ...(snapshot.trainer.known ? { trainer: snapshot.trainer.value } : {}),
    ...(snapshot.playTime.known ? { playTime: snapshot.playTime.value } : {}),
    ...(snapshot.ownedDex.known ? { ownedDex: snapshot.ownedDex.value } : {}),
    ...(snapshot.badgeMask.known ? { badgeMask: snapshot.badgeMask.value } : {}),
  }
}
export function trainerChanged(previous: SaveSnapshot | null, snapshot: SaveSnapshot, baseline?: ContinuityBaseline): boolean {
  const trainer = previous?.trainer.known ? previous.trainer.value : baseline?.trainer
  return !!trainer && snapshot.trainer.known && (trainer.id !== snapshot.trainer.value.id || trainer.name !== snapshot.trainer.value.name)
}
/** Keep a setup invalid once its bound donor changes, even if a later import matches again. */
function reviewEncounterDonor(attempt: Attempt, snapshot: SaveSnapshot): Attempt {
  const start = attempt.manualEvidence.filter(record => record.key === glitchSetupKey).at(-1)
  if (!start || !manualEvidenceIsEligible(start, attempt)) return attempt
  const setup = parseGlitchSetup(start.value)
  if (setup && (glitchDonorMatches(snapshot, setup.donor) || mewContinuation(attempt, start, snapshot) !== 'none')) return attempt
  return { ...attempt, manualEvidence: attempt.manualEvidence.map(record =>
    record.id === start.id ? { ...record, status: 'needs-review' } : record),
    diagnostics: importDiagnostics(attempt.diagnostics, ['Encounter donor changed or is unreadable; start a new setup and reconfirm its observations.']) }
}
export function commitObservation(attempt: Attempt, snapshot: SaveSnapshot, messages: string[]): Attempt {
  const previous = rememberContinuity(attempt.continuityBaseline ?? {}, attempt.snapshot)
  const changedTrainer = trainerChanged(attempt.snapshot, snapshot, previous)
  let next = attempt
  const comparisons = ['trainer', 'playTime', 'ownedDex', 'badgeMask'] as const
  const missingComparison = attempt.snapshot && comparisons.some(key => !attempt.snapshot![key].known && snapshot[key].known && previous[key] === undefined)
  if (missingComparison && attempt.manualEvidence.some(record => manualEvidenceIsEligible(record, attempt))) {
    next = reviewContinuity(next, 'Previously unreadable comparisons; continuity needs review.')
  }
  if (changedTrainer) next = reviewContinuity(next, 'Trainer identity changed; history needs review.')
  // A new explicitly assigned identity starts its own comparison chronology.
  if (!changedTrainer && previous.playTime && snapshot.playTime.known) {
    const seconds = (t: { hours: number; minutes: number; seconds: number }) => t.hours * 3600 + t.minutes * 60 + t.seconds
    if (seconds(snapshot.playTime.value) < seconds(previous.playTime)) next = reviewContinuity(next, 'Clock regressed; continuity needs review, chronology is uncertain.')
  }
  const owned = snapshot.ownedDex
  const lostOwned = previous.ownedDex && owned.known && previous.ownedDex.some(id => !owned.value.includes(id))
  const lostBadge = previous.badgeMask !== undefined && snapshot.badgeMask.known && (previous.badgeMask & snapshot.badgeMask.value) !== previous.badgeMask
  if (!changedTrainer && (lostOwned || lostBadge)) next = reviewContinuity(next, 'Earlier observations differ; continuity needs review.')
  next = reviewEncounterDonor(next, snapshot)
  return { ...next, snapshot, continuityBaseline: rememberContinuity(changedTrainer ? {} : previous, snapshot), lastImportedHash: snapshot.hash, heldImport: undefined,
    source: { ...next.source, lastImportAt: snapshot.importedAt, lastError: undefined }, diagnostics: importDiagnostics(next.diagnostics, messages) }
}
export function applySnapshot(project: MasteryProject, context: ImportContext, result: ParseResult): MasteryProject {
  if (!tokenIsCurrent(project, context)) return project
  const attempt = activeAttempt(project), messages = result.issues.map(i => i.message), settled = { ...project, pendingImport: null }
  if (result.status === 'rejected') return updateAttempt(settled, { ...attempt, diagnostics: importDiagnostics(attempt.diagnostics, messages), source: { ...attempt.source, lastError: messages.join('; ') } })
  if (attempt.ignoredHashes?.includes(result.snapshot.hash)) return updateAttempt(settled, { ...attempt, diagnostics: importDiagnostics(attempt.diagnostics, ['Ignored save fingerprint.']) })
  if (context.sourceKind === 'url' && trainerChanged(attempt.snapshot, result.snapshot, attempt.continuityBaseline)) {
    return updateAttempt(settled, { ...attempt, heldImport: { context, snapshot: result.snapshot, issues: result.issues }, diagnostics: importDiagnostics(attempt.diagnostics, ['Trainer identity changed; assign this save to an attempt.']) })
  }
  return updateAttempt(settled, commitObservation(attempt, result.snapshot, messages))
}
/** The protected main/Oak attempt: the first canonical attempt. Named attempts never share its save. */
export function canonicalAttempt(project: MasteryProject): Attempt | undefined {
  return project.attempts.find(a => a.kind === 'canonical')
}
/**
 * Give the canonical attempt the private deployment's save route when the player never chose
 * one, and keep a deployment-adopted route current. A URL the player set (origin 'user', or any
 * legacy URL) is never replaced, and glitch/speedrun attempts are never touched. Snapshots,
 * marks and branches are kept; continuity guards still apply to the first import.
 */
export function adoptDeploymentSave(project: MasteryProject, saveUrl: string | undefined): MasteryProject {
  const url = saveUrl?.trim(), attempt = canonicalAttempt(project)
  if (!url || !attempt) return project
  const current = attempt.source.url?.trim()
  const adopt = !current && attempt.source.origin !== 'user'
  const follow = attempt.source.origin === 'deployment' && current !== url
  if (!adopt && !follow) return project
  const next = updateAttempt(project, { ...attempt, heldImport: undefined,
    source: { ...attempt.source, kind: 'url', url, enabled: adopt ? true : attempt.source.enabled, paused: adopt ? false : attempt.source.paused, origin: 'deployment', revision: attempt.source.revision + 1, lastError: undefined } })
  // Invalidate any pending import for the old source context.
  const pending = project.pendingImport?.attemptId === attempt.id
  return pending ? { ...next, pendingImport: null, importGeneration: nextGeneration(project) } : next
}
