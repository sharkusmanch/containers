import type { MasteryProject } from '../model'
import { nextGeneration } from './project'
import { reviewGlitchSetup } from './glitch-setup'
import { migrateEvidenceKeys } from './key-migrations'

export type RestoreResult = { ok: true; project: MasteryProject } | { ok: false; error: string }
type Decoder = (value: unknown) => unknown
const invalid = (): never => { throw new Error('Invalid project schema') }
const text: Decoder = value => typeof value === 'string' && value.length <= 10000 ? value : invalid()
const bool: Decoder = value => typeof value === 'boolean' ? value : invalid()
const integer = (maximum = Number.MAX_SAFE_INTEGER - 2, minimum = 0): Decoder => value => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid()
// Bound persisted counters below the safe-integer edge, leaving restoration/Undo headroom.
const byte = integer(255), counter = integer(2 ** 48 - 1), id = integer(65535)
const timestamp: Decoder = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return invalid()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')) return invalid()
  return value
}
const choice = (...values: unknown[]): Decoder => value => values.includes(value) ? value : invalid()
const nullable = (decode: Decoder): Decoder => value => value === null ? null : decode(value)
const optional = (decode: Decoder): Decoder => value => value === undefined ? undefined : decode(value)
const list = (decode: Decoder, maximum = 10000): Decoder => value => Array.isArray(value) && value.length <= maximum ? value.map(decode) : invalid()
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
/** A whitelist also prevents accidental private fields from entering exported user data. */
const shape = (fields: Record<string, Decoder>): Decoder => value => {
  const data = object(value)
  return Object.fromEntries(Object.entries(fields).flatMap(([key, decode]) => {
    const result = decode(data[key]); return result === undefined ? [] : [[key, result]]
  }))
}
const record = (decode: Decoder): Decoder => value => {
  const data = object(value), entries = Object.entries(data)
  if (entries.length > 10000) return invalid()
  return Object.fromEntries(entries.map(([key, v]) => [key, decode(v)]))
}
const fact = (decode: Decoder): Decoder => value => {
  const data = object(value)
  if (data.known === true) return { known: true, value: decode(data.value) }
  if (data.known === false) return { known: false, reason: text(data.reason) }
  return invalid()
}
const sourceKind = choice('upload', 'url')
const setKey = choice('main', 'oak', 'glitch')
const context = shape({ projectId: text, attemptId: text, sourceRevision: counter, sourceKind, generation: counter })
const pokemonLocation: Decoder = value => {
  switch (object(value).kind) {
    case 'party': return shape({ kind: choice('party'), slot: byte })(value)
    case 'box': return shape({ kind: choice('box'), slot: byte, index: integer(11) })(value)
    case 'daycare': return { kind: 'daycare' }
    default: return invalid()
  }
}
const dexNumber = integer(151, 1)
const dexList: Decoder = value => {
  const decoded = list(dexNumber, 151)(value) as number[]
  if (new Set(decoded).size !== decoded.length) return invalid()
  return decoded
}
const numericFlags: Decoder = value => {
  if (Object.keys(object(value)).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) > 65535)) return invalid()
  return record(bool)(value)
}
const pokemon = shape({ internalSpeciesId: byte, listedSpeciesId: optional(byte), dexNumber: nullable(dexNumber), location: pokemonLocation,
  level: fact(byte), moves: fact(list(shape({ id: byte, pp: byte, ppUps: integer(3) }), 4)), special: fact(id) })
const box = shape({ index: integer(11), pokemon: list(pokemon, 20) })
const bagSlot = shape({ position: integer(255), rawItemId: byte, quantity: byte })
const snapshot = shape({
  profileId: text, hash: text, importedAt: timestamp,
  trainer: fact(shape({ name: text, id })), battleStyle: fact(choice('set', 'shift')), badgeMask: fact(byte),
  ownedDex: fact(dexList), seenDex: fact(dexList), party: fact(list(pokemon, 6)), currentBox: fact(box),
  archivedBoxes: fact(list(box, 11)), daycare: fact(nullable(pokemon)), bag: fact(list(bagSlot, 20)), pcItems: fact(list(bagSlot, 50)),
  events: fact(record(bool)), location: fact(shape({ mapId: byte, name: optional(text), x: optional(byte), y: optional(byte) })),
  playTime: fact(shape({ hours: integer(65535), minutes: byte, seconds: byte })), hallOfFame: fact(bool),
  rawCounts: optional(shape({ party: byte, currentBox: byte, currentBoxByte: byte, archivedBoxes: list(byte, 12), bag: byte, pcItems: byte, daycare: byte, hallOfFame: byte })),
  objectFlags: optional(fact(record(bool))), hiddenItemFlags: optional(fact(numericFlags)), hiddenCoinFlags: optional(fact(numericFlags)),
  tradeFlags: optional(fact(numericFlags)), statusFlags: optional(fact(record(bool))), mapScriptStates: optional(fact(list(byte, 256))), playTimeRaw: optional(list(byte, 16)),
})
const issue = shape({ code: text, message: text, section: optional(text), offset: optional(integer(32767)) })
const branches = shape({ starter: optional(choice('bulbasaur', 'charmander', 'squirtle')), fossil: optional(choice('helix', 'dome')),
  dojo: optional(choice('hitmonlee', 'hitmonchan')), eevee: optional(choice('vaporeon', 'jolteon', 'flareon')), moonstones: optional(list(id, 151)) })
const evidenceValue: Decoder = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'boolean' ? value : text(value)
const evidence = shape({ id: text, attemptId: text, continuityRevision: counter, status: choice('active', 'needs-review', 'archived'), key: text,
  value: evidenceValue, recordedAt: timestamp, ruleId: optional(counter), note: optional(text) })
const continuityBaseline = shape({ trainer: optional(shape({ name: text, id })),
  playTime: optional(shape({ hours: integer(65535), minutes: byte, seconds: byte })), ownedDex: optional(dexList), badgeMask: optional(byte) })
const attempt = shape({ id: text, name: text, kind: choice('canonical', 'glitch', 'speedrun'), continuityRevision: counter, continuityBaseline: optional(continuityBaseline),
  source: shape({ kind: sourceKind, url: optional(text), revision: counter, label: optional(text), lastImportAt: optional(timestamp), lastError: optional(text), enabled: optional(bool), paused: optional(bool), origin: optional(choice('deployment', 'user')) }),
  snapshot: nullable(snapshot), manualEvidence: list(evidence), branches, createdAt: timestamp, importGeneration: optional(counter), diagnostics: optional(list(text)),
  lastImportedHash: optional(text), ignoredHashes: optional(list(text)), heldImport: optional(shape({ context, snapshot, issues: list(issue) })),
})
const feed = shape({ setKey, apiGameId: counter, accountIdentity: nullable(text), lastSuccessfulFetchAt: nullable(timestamp), stale: bool,
  unlocks: list(shape({ achievementId: counter, earnedAt: timestamp })), unavailableReason: optional(text) })
const project = shape({ id: text, version: choice(1), accountIdentity: nullable(text), activeAttemptId: text, attempts: list(attempt, 100),
  importGeneration: counter, accountProgress: list(feed, 3), createdAt: timestamp, updatedAt: timestamp, pendingImport: optional(nullable(context)),
  resetUndo: optional(shape({ attempt, importGeneration: counter })), recoveryError: optional(text),
})
function validateProject(value: unknown): MasteryProject {
  const p = project(value) as MasteryProject
  const attemptIds = p.attempts.map(a => a.id)
  if (!attemptIds.includes(p.activeAttemptId) || new Set(attemptIds).size !== attemptIds.length) invalid()
  for (const a of [...p.attempts, ...(p.resetUndo ? [p.resetUndo.attempt] : [])]) {
    const ids = a.manualEvidence.map(e => e.id)
    if (new Set(ids).size !== ids.length || a.manualEvidence.some(e => e.attemptId !== a.id || e.continuityRevision > a.continuityRevision)) invalid()
    const held = a.heldImport?.context
    if (held && (held.projectId !== p.id || held.attemptId !== a.id || held.sourceRevision !== a.source.revision || held.sourceKind !== 'url')) invalid()
  }
  if (p.resetUndo && !attemptIds.includes(p.resetUndo.attempt.id)) invalid()
  if (new Set(p.accountProgress.map(f => f.setKey)).size !== p.accountProgress.length) invalid()
  for (const f of p.accountProgress) {
    if (f.accountIdentity !== p.accountIdentity || f.apiGameId !== { main: 724, oak: 16084, glitch: 11632 }[f.setKey] ||
        new Set(f.unlocks.map(u => u.achievementId)).size !== f.unlocks.length) invalid()
  }
  const token = p.pendingImport, active = p.attempts.find(a => a.id === p.activeAttemptId)!
  if (token && (token.projectId !== p.id || token.attemptId !== active.id || token.sourceRevision !== active.source.revision || token.generation !== p.importGeneration)) invalid()
  // Ensure the following restoration increment is itself a safe integer.
  nextGeneration(p)
  return p
}
export function serializeProject(value: MasteryProject): string {
  const raw = JSON.stringify({ format: 'pokemon-red-mastery', version: 1, project: validateProject(value) })
  if (raw.length > 8_000_000) throw new Error('Project is too large')
  return raw
}
export function restoreProject(raw: string): RestoreResult {
  try {
    if (raw.length > 8_000_000) throw new Error('Project is too large')
    const data = object(JSON.parse(raw))
    if (data.format !== 'pokemon-red-mastery' || data.version !== 1) throw new Error('Unsupported project format or version')
    // Renamed objective keys follow their marks; retired keys stay visible (key-migrations.ts).
    const p = migrateEvidenceKeys(validateProject(data.project))
    return { ok: true, project: { ...p, importGeneration: nextGeneration(p), pendingImport: null,
      attempts: p.attempts.map(a => ({ ...reviewGlitchSetup(a), heldImport: undefined })),
      resetUndo: p.resetUndo ? { ...p.resetUndo, attempt: { ...reviewGlitchSetup(p.resetUndo.attempt), heldImport: undefined } } : undefined } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not restore project' }
  }
}
