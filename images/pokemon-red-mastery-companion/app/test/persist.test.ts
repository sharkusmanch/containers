import { describe, expect, it } from 'vitest'
import { createProject, createAttempt, beginImport } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { serializeProject, restoreProject } from '../src/state/persist'
import type { MasteryProject } from '../src/model'
function active(p: MasteryProject) { return p.attempts.find(a => a.id === p.activeAttemptId)! }
function populated() {
  let p = reduceProject(createProject('player'), { type: 'set-branches', branches: { starter: 'squirtle', moonstones: [1, 2] } })
  p = reduceProject(p, { type: 'record-manual', key: 'observed-special', value: 123 })
  return createAttempt(p, 'glitch', 'Named')
}
describe('versioned local project persistence and recovery', () => {
  it('roundtrips named attempts and choices but invalidates saved pending tokens', () => {
    const start = beginImport(populated(), 'upload'), result = restoreProject(serializeProject(start.project))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.project.attempts).toEqual(start.project.attempts)
    expect(result.project.importGeneration).toBeGreaterThan(start.context.generation)
    expect(result.project.pendingImport).toBeNull()
    expect(result.project.accountIdentity).toBe('player')
  })
  it.each(['{', '{}', '{"version":999}', 'null'])('recovers invalid JSON/schema %s without losing live data', raw => {
    const p = populated(), result = restoreProject(raw)
    expect(result.ok).toBe(false)
    const next = reduceProject(p, { type: 'restore-project', raw })
    expect(next.attempts).toEqual(p.attempts); expect(next.id).toBe(p.id); expect(next.recoveryError).toBeTruthy()
  })
  it.each([
    (p: any) => { p.activeAttemptId = 'missing' },
    (p: any) => { p.attempts[0].manualEvidence[0].value = {} },
    (p: any) => { p.attempts[0].manualEvidence[0].continuityRevision = -1 },
    (p: any) => { p.attempts[0].branches.starter = 'pikachu' },
    (p: any) => { p.attempts[0].source.enabled = 'yes' },
    (p: any) => { p.attempts[0].snapshot = { ownedDex: { known: true, value: [151] } } },
    (p: any) => { p.attempts.push(p.attempts[0]) },
    (p: any) => { p.accountProgress = [{ setKey: 'main', apiGameId: 724, accountIdentity: 'other', stale: false, lastSuccessfulFetchAt: null, unlocks: [] }] },
    (p: any) => { p.importGeneration = Number.MAX_SAFE_INTEGER },
  ])('rejects nested prerequisite/state corruption case %#', mutate => {
    const data = JSON.parse(serializeProject(populated())); mutate(data.project)
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
  it('reset has one-step Undo with generations beyond every live/restored counter', () => {
    let p = populated(); const id = p.activeAttemptId
    p = reduceProject(p, { type: 'record-manual', key: 'done', value: true })
    const start = beginImport(p, 'upload')
    const reset = reduceProject(start.project, { type: 'reset-attempt' })
    expect(active(reset).manualEvidence).toEqual([])
    expect(active(reset).source.revision).toBeGreaterThan(active(p).source.revision)
    const inFlight = beginImport(reset, 'upload')
    const undone = reduceProject(inFlight.project, { type: 'undo-reset' })
    expect(undone.activeAttemptId).toBe(id); expect(active(undone).manualEvidence[0]?.key).toBe('done')
    expect(undone.importGeneration).toBeGreaterThan(inFlight.context.generation)
    expect(undone.pendingImport).toBeNull(); expect(undone.resetUndo).toBeUndefined()
    expect(reduceProject(undone, { type: 'undo-reset' })).toBe(undone)
  })
  it('restoration invalidates pending live tokens even when live generation is larger', () => {
    const saved = serializeProject(populated()); let live = createProject('player')
    for (let i = 0; i < 15; i++) live = beginImport(live, 'upload').project
    const restored = reduceProject(live, { type: 'restore-project', raw: saved })
    expect(restored.importGeneration).toBeGreaterThan(live.importGeneration)
    expect(restored.pendingImport).toBeNull()
  })
  it('export removes extraneous bytes/credentials and never serializes undo recursively', () => {
    const p = reduceProject(populated(), { type: 'reset-attempt' })
    const tainted = { ...p, bytes: new Uint8Array([1, 2]), secret: 'private', resetUndo: { ...p.resetUndo!, resetUndo: p } }
    const raw = serializeProject(tainted)
    expect(raw).not.toContain('secret'); expect(raw).not.toContain('bytes'); expect(raw).not.toContain('private')
    expect(restoreProject(raw).ok).toBe(true)
  })
})

function snapshotProject() {
  const p = populated(), a = active(p), unknown = { known: false as const, reason: 'unavailable' }
  a.snapshot = {
    profileId: 'red-en', hash: 'fnv1a64:0000000000000001', importedAt: '2026-10-11T00:00:00.000Z', trainer: unknown, battleStyle: unknown,
    badgeMask: { known: true, value: 0 }, ownedDex: { known: true, value: [1, 151] }, seenDex: unknown,
    party: { known: true, value: [{ internalSpeciesId: 153, dexNumber: 1, location: { kind: 'party', slot: 1 }, level: { known: true, value: 5 }, moves: { known: true, value: [{ id: 45, pp: 40, ppUps: 0 }] }, special: unknown }] },
    currentBox: unknown, archivedBoxes: unknown, daycare: { known: true, value: null },
    bag: { known: true, value: [{ position: 6, rawItemId: 40, quantity: 255 }] }, pcItems: unknown, events: { known: true, value: { EVENT_GOT_POKEDEX: false } },
    location: unknown, playTime: unknown, hallOfFame: unknown,
    hiddenItemFlags: { known: true, value: { 1: true } }, objectFlags: { known: true, value: { HS_TEST: false } }, statusFlags: { known: true, value: { 'bit-7': true } },
    rawCounts: { party: 1, currentBox: 0, currentBoxByte: 0, archivedBoxes: [], bag: 6, pcItems: 0, daycare: 0, hallOfFame: 0 }, playTimeRaw: [0, 0, 0, 0, 0]
  }
  return p
}
describe('nested observations and counter boundaries', () => {
  it('preserves partial facts, byte quantities and raw namespaces without promoting unknowns', () => {
    const p = snapshotProject(), result = restoreProject(serializeProject(p))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(active(result.project).snapshot).toEqual(active(p).snapshot)
    expect(active(result.project).snapshot?.party).toMatchObject({ known: true, value: [{ special: { known: false } }] })
    expect(active(result.project).snapshot?.bag).toMatchObject({ value: [{ position: 6, quantity: 255 }] })
  })
  it.each([
    (s: any) => { s.ownedDex.value = [0] },
    (s: any) => { s.ownedDex.value = [1, 1] },
    (s: any) => { s.party.value[0].dexNumber = 0 },
    (s: any) => { s.party.value[0].moves.value[0].ppUps = 4 },
    (s: any) => { s.party.value[0].level = { known: true, value: '100' } },
    (s: any) => { s.party.value[0].special = { known: false } },
    (s: any) => { s.events.value.EVENT_GOT_POKEDEX = 'true' },
    (s: any) => { s.hiddenItemFlags.value = { arbitrary: true } },
    (s: any) => { s.bag.value[0].quantity = 256 },
    (s: any) => { s.hallOfFame = { known: true, value: 1 } },
    (s: any) => { s.rawCounts.daycare = -1 },
    (s: any) => { s.importedAt = '2026-02-30T00:00:00.000Z' },
  ])('rejects malformed nested save facts case %#', mutate => {
    const data = JSON.parse(serializeProject(snapshotProject())); mutate(data.project.attempts[1].snapshot)
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
  it('Undo includes a high held-import generation inside the reset backup', () => {
    let p = snapshotProject(); const a = active(p)
    a.heldImport = { context: { projectId: p.id, attemptId: a.id, sourceRevision: a.source.revision, sourceKind: 'url', generation: 900 }, snapshot: a.snapshot!, issues: [] }
    p = reduceProject(p, { type: 'reset-attempt' })
    // Deliberately make the backup the only holder of the largest counter.
    p.importGeneration = 5; active(p).importGeneration = 5
    const undone = reduceProject(p, { type: 'undo-reset' })
    expect(undone.importGeneration).toBeGreaterThan(900)
  })
  it('restoration advances past high restored and attempt-local counters', () => {
    const saved = snapshotProject(); saved.importGeneration = 200; active(saved).importGeneration = 600
    const restored = reduceProject(createProject('player'), { type: 'restore-project', raw: serializeProject(saved) })
    expect(restored.importGeneration).toBeGreaterThan(600)
  })
  it('exhausted counters recover as errors without replacing the live project', () => {
    const data = JSON.parse(serializeProject(populated())); data.project.importGeneration = Number.MAX_SAFE_INTEGER - 1
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
})

describe('corrupted pending and backup metadata recovery', () => {
  it.each([
    (p: any) => { p.pendingImport.sourceKind = 'network' },
    (p: any) => { p.pendingImport.attemptId = 'another' },
    (p: any) => { p.pendingImport.sourceRevision++ },
    (p: any) => { p.pendingImport.generation-- },
    (p: any) => { p.pendingImport.projectId = 'another' },
  ])('rejects corrupt persisted token case %#', mutate => {
    const data = JSON.parse(serializeProject(beginImport(populated(), 'upload').project)); mutate(data.project)
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
  it.each([
    (p: any) => { p.resetUndo.attempt.manualEvidence[0].status = 'verified' },
    (p: any) => { p.resetUndo.attempt.source.revision = -1 },
    (p: any) => { p.resetUndo.attempt.branches.starter = 'pikachu' },
  ])('rejects corrupt Undo backup case %#', mutate => {
    let p = reduceProject(populated(), { type: 'record-manual', key: 'event', value: true })
    p = reduceProject(p, { type: 'reset-attempt' })
    const data = JSON.parse(serializeProject(p)); mutate(data.project)
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
  it('handles near-exhausted restoration as recoverable rather than throwing in reducer', () => {
    const p = populated(), data = JSON.parse(serializeProject(p)); data.project.importGeneration = Number.MAX_SAFE_INTEGER - 2
    const restored = reduceProject(p, { type: 'restore-project', raw: JSON.stringify(data) })
    expect(restored.id).toBe(p.id); expect(restored.recoveryError).toBeTruthy()
  })
})

it('rejects exports beyond the restore size bound instead of emitting unrecoverable files', () => {
  const p = populated(), a = p.attempts[0]!, record = a.manualEvidence[0]!
  a.manualEvidence = Array.from({ length: 850 }, (_, index) => ({ ...record, id: String(index), note: 'x'.repeat(10000) }))
  expect(() => serializeProject(p)).toThrow(/too large/i)
})

describe('continuity baseline persistence', () => {
  it('roundtrips validated baselines in attempts and reset Undo backups', () => {
    let p = snapshotProject(), a = active(p)
    const baseline = { trainer: { name: 'RED', id: 1 }, playTime: { hours: 10, minutes: 0, seconds: 0 }, ownedDex: [1, 2], badgeMask: 3 }
    a.continuityBaseline = baseline
    let result = restoreProject(serializeProject(p))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(active(result.project).continuityBaseline).toEqual(baseline)
    expect(active(result.project).snapshot?.trainer.known).toBe(false)
    p = reduceProject(p, { type: 'reset-attempt' })
    result = restoreProject(serializeProject(p))
    if (!result.ok) throw new Error(result.error)
    expect(result.project.resetUndo?.attempt.continuityBaseline).toEqual(baseline)
    expect(active(result.project).continuityBaseline).toBeUndefined()
  })
  it.each([
    { trainer: { name: 'RED', id: -1 } },
    { playTime: { hours: '10', minutes: 0, seconds: 0 } },
    { ownedDex: [1, 1] },
    { badgeMask: 256 },
  ])('rejects malformed continuity metadata %#', continuityBaseline => {
    const data = JSON.parse(serializeProject(snapshotProject())); data.project.attempts[1].continuityBaseline = continuityBaseline
    expect(restoreProject(JSON.stringify(data)).ok).toBe(false)
  })
})
