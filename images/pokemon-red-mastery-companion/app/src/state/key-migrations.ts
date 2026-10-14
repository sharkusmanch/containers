import type { Attempt, ManualEvidence, MasteryProject } from '../model'

/**
 * Manual-mark keys whose objective changed. A key with a replacement is renamed in place (same record,
 * value, status and history). A key without one is kept untouched and listed under "Marks no longer
 * used", so a player's marks are never dropped silently. Area entry IDs are stable and never listed here.
 */
export interface KeyMigration { key: string; replacement?: string; reason: string }
export const keyMigrations: KeyMigration[] = [
  {
    key: 'glitch:cinnabar-access',
    reason: 'Ruining the Neighborhood now uses the Pallet Town Glitch City (Fly only); Cinnabar access is no longer part of the method.',
  },
  {
    key: 'glitch:rival-name',
    reason: 'Speedrun? no longer requires the rival name JOHN: the names do not matter for the casual save-corruption routes.',
  },
  {
    key: 'hideout:clear-before-giovanni',
    reason: 'Raiding the Vault counts Giovanni and the Silph Scope too, so clearing the Hideout before Giovanni is no longer a condition.',
  },
]
const lookup = () => new Map(keyMigrations.map(m => [m.key, m]))

function migrateRecords(records: ManualEvidence[]): ManualEvidence[] {
  const byKey = lookup()
  return records.map(record => {
    const replacement = byKey.get(record.key)?.replacement
    return replacement ? { ...record, key: replacement } : record
  })
}
function migrateAttempt(attempt: Attempt): Attempt {
  const manualEvidence = migrateRecords(attempt.manualEvidence)
  return manualEvidence.every((r, i) => r === attempt.manualEvidence[i]) ? attempt : { ...attempt, manualEvidence }
}
/** Pure and idempotent: replacement keys are never themselves migrated. */
export function migrateEvidenceKeys(project: MasteryProject): MasteryProject {
  const attempts = project.attempts.map(migrateAttempt)
  const resetUndo = project.resetUndo ? { ...project.resetUndo, attempt: migrateAttempt(project.resetUndo.attempt) } : undefined
  const changed = attempts.some((a, i) => a !== project.attempts[i]) || resetUndo?.attempt !== project.resetUndo?.attempt
  return changed ? { ...project, attempts, ...(resetUndo ? { resetUndo } : {}) } : project
}
/** Marks kept for a retired objective, with the reason it no longer counts. */
export function retiredMarks(attempt: Attempt): { record: ManualEvidence; reason: string }[] {
  const byKey = lookup()
  return attempt.manualEvidence.flatMap(record => {
    const migration = byKey.get(record.key)
    return migration && !migration.replacement ? [{ record, reason: migration.reason }] : []
  })
}
