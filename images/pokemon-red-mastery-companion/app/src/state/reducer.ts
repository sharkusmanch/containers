import type { AttemptKind, BranchChoices, HardcoreRefreshResult, ImportContext, MasteryProject, ParseResult, SaveSource, SourceKind } from '../model'
import { activeAttempt, heldImportIsCurrent, applySnapshot, beginImport, commitObservation, createAttempt, nextGeneration, reviewContinuity, tokenIsCurrent, updateAttempt } from './project'
import { restoreProject } from './persist'
import { glitchSetupKey, reviewGlitchSetup } from './glitch-setup'

export type ProjectAction =
  | { type: 'set-account-identity'; identity: string }
  | { type: 'create-attempt'; kind: AttemptKind; name: string }
  | { type: 'switch-attempt'; attemptId: string }
  | { type: 'set-branches'; branches: BranchChoices }
  | { type: 'record-manual'; key: string; value: boolean | number | string; ruleId?: number; note?: string }
  | { type: 'reconfirm-manual'; evidenceId: string }
  | { type: 'archive-manual'; evidenceId: string }
  | { type: 'set-source'; source: Pick<SaveSource, 'kind' | 'url' | 'enabled' | 'label'> }
  | { type: 'pause-source'; paused: boolean }
  | { type: 'set-source-enabled'; enabled: boolean }
  | { type: 'request-import'; sourceKind: SourceKind; automatic?: boolean }
  | { type: 'import-result'; context: ImportContext; result: ParseResult }
  | { type: 'import-error'; context: ImportContext; reason: string }
  | { type: 'cancel-import'; context: ImportContext }
  | { type: 'ignore-hash'; hash: string }
  | { type: 'assign-held'; targetAttemptId: string }
  | { type: 'discard-held' }
  | { type: 'hardcore-result'; result: HardcoreRefreshResult }
  | { type: 'reset-attempt' }
  | { type: 'undo-reset' }
  | { type: 'restore-project'; raw: string }

export function reduceProject(project: MasteryProject, action: ProjectAction): MasteryProject {
  const attempt = activeAttempt(project)
  switch (action.type) {
    case 'set-account-identity': {
      const identity = action.identity.trim() || null
      return identity === project.accountIdentity ? project : { ...project, accountIdentity: identity, accountProgress: [], updatedAt: new Date().toISOString() }
    }
    case 'create-attempt': return createAttempt(project, action.kind, action.name)
    case 'switch-attempt':
      if (!project.attempts.some(a => a.id === action.attemptId)) return project
      return { ...project, activeAttemptId: action.attemptId, pendingImport: null, importGeneration: nextGeneration(project), updatedAt: new Date().toISOString() }
    case 'set-branches': return updateAttempt(project, { ...attempt, branches: { ...attempt.branches, ...action.branches } })
    case 'record-manual':
      return updateAttempt(project, { ...attempt, manualEvidence: [...attempt.manualEvidence, { id: crypto.randomUUID(), attemptId: attempt.id,
        continuityRevision: attempt.continuityRevision, status: 'active', key: action.key, value: action.value, ruleId: action.ruleId, note: action.note, recordedAt: new Date().toISOString() }] })
    case 'reconfirm-manual': {
      const record = attempt.manualEvidence.find(e => e.id === action.evidenceId)
      if (!record || record.attemptId !== attempt.id || record.status === 'archived' || record.key === glitchSetupKey) return project
      return updateAttempt(project, { ...attempt, manualEvidence: [...attempt.manualEvidence.map(e => e.id === record.id ? { ...e, status: 'archived' as const } : e),
        { ...record, id: crypto.randomUUID(), continuityRevision: attempt.continuityRevision, status: 'active', recordedAt: new Date().toISOString() }] })
    }
    case 'archive-manual': return updateAttempt(project, { ...attempt, manualEvidence: attempt.manualEvidence.map(e => e.id === action.evidenceId ? { ...e, status: 'archived' } : e) })
        case 'set-source': {
      // Same address and kind: no new source, so no continuity review. Re-saving an address makes it the player's own;
      // saving settings with no address before and after changes nothing about the source (origin untouched).
      const sameUrl = (action.source.url?.trim() || undefined) === (attempt.source.url?.trim() || undefined)
      if (sameUrl && action.source.kind === attempt.source.kind)
        return updateAttempt(project, { ...attempt, source: { ...attempt.source, label: action.source.label, enabled: action.source.enabled ?? false, paused: false,
          ...(attempt.source.url ? { origin: 'user' as const } : {}) } })
      const next = reviewContinuity(attempt, 'Save source changed; history needs review.')
      return { ...updateAttempt(project, { ...next, heldImport: undefined, source: { ...action.source, revision: attempt.source.revision + 1, enabled: action.source.enabled ?? false, paused: false, origin: 'user' } }),
        pendingImport: null, importGeneration: nextGeneration(project) }
    }
            // Automatic reload toggle: same source, same origin; turning it on also resumes after an upload pause.
    case 'set-source-enabled': return updateAttempt(project, { ...attempt, source: { ...attempt.source, enabled: action.enabled, paused: false } })
    case 'pause-source': return { ...updateAttempt(project, { ...attempt, source: { ...attempt.source, paused: action.paused }, heldImport: undefined }), pendingImport: null, importGeneration: nextGeneration(project) }
    case 'request-import':
      if (action.sourceKind === 'url' && (!attempt.source.url || action.automatic && (!attempt.source.enabled || attempt.source.paused || project.pendingImport?.sourceKind === 'upload'))) return project
      return beginImport(project, action.sourceKind).project
    case 'import-result': return applySnapshot(project, action.context, action.result)
    case 'import-error': return applySnapshot(project, action.context, { status: 'rejected', issues: [{ code: 'source-error', message: action.reason }] })
    case 'cancel-import':
      if (!tokenIsCurrent(project, action.context)) return project
      return { ...project, pendingImport: null, importGeneration: nextGeneration(project) }
    case 'ignore-hash': return updateAttempt(project, { ...attempt, ignoredHashes: [...new Set([...(attempt.ignoredHashes ?? []), action.hash])] })
    case 'assign-held': {
      const held = attempt.heldImport, target = project.attempts.find(a => a.id === action.targetAttemptId)
      if (!held || !target || !heldImportIsCurrent(project)) return project
      let next = updateAttempt(project, { ...attempt, heldImport: undefined })
      next = updateAttempt(next, commitObservation(target, held.snapshot, held.issues.map(i => i.message)))
      return { ...next, pendingImport: null, importGeneration: nextGeneration(project) }
    }
    case 'discard-held': return { ...updateAttempt(project, { ...attempt, heldImport: undefined }), pendingImport: null, importGeneration: nextGeneration(project) }
    case 'hardcore-result': {
      const progress = new Map(project.accountProgress.map(feed => [feed.setKey, feed]))
      const failures = [...action.result.failures]
      for (const feed of action.result.progress) {
        if (feed.accountIdentity !== project.accountIdentity || !feed.accountIdentity) failures.push({ setKey: feed.setKey, reason: 'Account identity unavailable or mismatched.' })
        else progress.set(feed.setKey, feed)
      }
      for (const failure of failures) {
        const prior = progress.get(failure.setKey)
        progress.set(failure.setKey, prior ? { ...prior, stale: true, unavailableReason: failure.reason } : {
          setKey: failure.setKey, apiGameId: { main: 724, oak: 16084, glitch: 11632 }[failure.setKey], accountIdentity: project.accountIdentity,
          lastSuccessfulFetchAt: null, stale: true, unavailableReason: failure.reason, unlocks: [] })
      }
      return { ...project, accountProgress: [...progress.values()], updatedAt: new Date().toISOString() }
    }
    case 'reset-attempt': {
      const generation = nextGeneration(project)
      return { ...updateAttempt(project, { ...attempt, continuityRevision: attempt.continuityRevision + 1,
        source: { kind: 'upload', enabled: false, paused: false, revision: attempt.source.revision + 1 }, snapshot: null, continuityBaseline: undefined,
        manualEvidence: [], branches: {}, ignoredHashes: [], lastImportedHash: undefined, heldImport: undefined, diagnostics: [], importGeneration: generation }),
        pendingImport: null, importGeneration: generation, resetUndo: { attempt, importGeneration: project.importGeneration } }
    }
    case 'undo-reset': {
      const backup = project.resetUndo
      if (!backup || !project.attempts.some(a => a.id === backup.attempt.id)) return project
      return { ...updateAttempt(project, { ...reviewGlitchSetup(backup.attempt), heldImport: undefined }), pendingImport: null, importGeneration: nextGeneration(project), resetUndo: undefined }
    }
    case 'restore-project': {
      const restored = restoreProject(action.raw)
      if (!restored.ok) return { ...project, recoveryError: restored.error }
      return { ...restored.project, importGeneration: nextGeneration(project, restored.project), pendingImport: null, recoveryError: undefined }
    }
  }
}
