import { describe, expect, it } from 'vitest'
import type { MasteryProject, SaveSnapshot, ImportContext, HardcoreProgress } from '../src/model'
import { createProject, createAttempt, beginImport, applySnapshot, manualEvidenceIsEligible } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { serializeProject, restoreProject } from '../src/state/persist'

const unknown = { known: false as const, reason: 'unavailable' }
function save(hash = 'first', ids = [1, 2], hours = 10, trainer = 'RED'): SaveSnapshot {
  return { profileId: 'red-en', hash, importedAt: '2026-10-11T00:00:00.000Z', trainer: { known: true, value: { name: trainer, id: 1 } },
    battleStyle: unknown, badgeMask: { known: true, value: ids.length === 2 ? 3 : 1 }, ownedDex: { known: true, value: ids }, seenDex: unknown,
    party: { known: true, value: [] }, currentBox: unknown, archivedBoxes: unknown, daycare: unknown, bag: unknown, pcItems: unknown,
    events: unknown, location: unknown, playTime: { known: true, value: { hours, minutes: 0, seconds: 0 } }, hallOfFame: unknown }
}
function active(p: MasteryProject) { return p.attempts.find(a => a.id === p.activeAttemptId)! }
function imported(p = createProject('player'), s = save()) {
  const start = beginImport(p, 'upload'); return applySnapshot(start.project, start.context, { status: 'readable', snapshot: s, issues: [] })
}
function record(p: MasteryProject) { return reduceProject(p, { type: 'record-manual', key: 'session', value: true }) }
function url(p: MasteryProject) { return reduceProject(p, { type: 'set-source', source: { kind: 'url', url: '/save.sav', enabled: true } }) }
const feed = (setKey: HardcoreProgress['setKey'], identity = 'player'): HardcoreProgress => ({ setKey, apiGameId: { main: 724, oak: 16084, glitch: 11632 }[setKey], accountIdentity: identity, lastSuccessfulFetchAt: '2026-10-11T00:00:00.000Z', stale: false, unlocks: [{ achievementId: 1, earnedAt: '2026-10-10T00:00:00.000Z' }] })

describe('attempt observations and import ownership', () => {
  it('replaces earlier Dex and badges rather than unioning old observations', () => {
    const p = imported(imported(), save('earlier', [1], 1))
    expect(active(p).snapshot?.ownedDex).toEqual({ known: true, value: [1] })
    expect(active(p).snapshot?.badgeMask).toEqual({ known: true, value: 1 })
    expect(active(p).snapshot?.party).toEqual({ known: true, value: [] })
  })
  it('preserves the last good snapshot on rejected imports and records the error', () => {
    const p = imported(), start = beginImport(p, 'upload')
    const next = applySnapshot(start.project, start.context, { status: 'rejected', issues: [{ code: 'checksum', message: 'Bad checksum' }] })
    expect(active(next).snapshot).toEqual(active(p).snapshot)
    expect(active(next).diagnostics).toContain('Bad checksum')
    expect(next.pendingImport).toBeNull()
  })
  it.each(['projectId', 'attemptId', 'sourceRevision', 'sourceKind', 'generation'] as const)('rejects mismatched token %s', key => {
    const start = beginImport(createProject('player'), 'upload')
    const token = { ...start.context, [key]: key === 'sourceRevision' || key === 'generation' ? 500 : key === 'sourceKind' ? 'url' : 'other' } as ImportContext
    expect(applySnapshot(start.project, token, { status: 'readable', snapshot: save(), issues: [] })).toBe(start.project)
  })
  it.each(['url', 'upload'] as const)('newer upload supersedes older %s request', kind => {
    const first = beginImport(url(createProject('player')), kind), second = beginImport(first.project, 'upload')
    expect(applySnapshot(second.project, first.context, { status: 'readable', snapshot: save(), issues: [] })).toBe(second.project)
    expect(active(applySnapshot(second.project, second.context, { status: 'partial', snapshot: save('new'), issues: [] })).snapshot?.hash).toBe('new')
  })
  it('A to B to A cannot revive a pending token', () => {
    let p = createProject('player'); const a = p.activeAttemptId
    p = createAttempt(p, 'glitch', 'B'); const b = p.activeAttemptId
    p = reduceProject(p, { type: 'switch-attempt', attemptId: a })
    const first = beginImport(p, 'upload')
    p = reduceProject(first.project, { type: 'switch-attempt', attemptId: b })
    p = reduceProject(p, { type: 'switch-attempt', attemptId: a })
    expect(applySnapshot(p, first.context, { status: 'readable', snapshot: save(), issues: [] })).toBe(p)
  })
  it('cancellation invalidates the token without replacing facts', () => {
    const start = beginImport(imported(), 'upload'), p = reduceProject(start.project, { type: 'cancel-import', context: start.context })
    expect(applySnapshot(p, start.context, { status: 'readable', snapshot: save('late'), issues: [] })).toBe(p)
    expect(active(p).snapshot?.hash).toBe('first')
  })
  it('new named attempts inherit no source, evidence, branches or hashes', () => {
    let p = record(imported(url(createProject('player')))); p = reduceProject(p, { type: 'ignore-hash', hash: 'ignored' })
    p = createAttempt(p, 'speedrun', 'Fresh')
    expect(active(p)).toMatchObject({ name: 'Fresh', snapshot: null, manualEvidence: [], branches: {}, ignoredHashes: [], source: { kind: 'upload', enabled: false, paused: false } })
    expect(active(p).source.url).toBeUndefined(); expect(active(p).lastImportedHash).toBeUndefined()
  })
  it('ignored hashes are attempt-local and never replace the snapshot', () => {
    let p = reduceProject(imported(), { type: 'ignore-hash', hash: 'ignored' })
    const start = beginImport(p, 'upload'); p = applySnapshot(start.project, start.context, { status: 'readable', snapshot: save('ignored'), issues: [] })
    expect(active(p).snapshot?.hash).toBe('first')
    p = imported(createAttempt(p, 'glitch', 'Other'), save('ignored'))
    expect(active(p).snapshot?.hash).toBe('ignored')
  })
  it('upload pauses automatic refresh until an explicit URL refresh', () => {
    const start = beginImport(url(createProject('player')), 'upload')
    expect(active(start.project).source.paused).toBe(true)
    expect(reduceProject(start.project, { type: 'request-import', sourceKind: 'url', automatic: true })).toBe(start.project)
    const p = reduceProject(start.project, { type: 'request-import', sourceKind: 'url' })
    expect(active(p).source.paused).toBe(false); expect(p.pendingImport?.sourceKind).toBe('url')
  })
  it('source edits invalidate pending requests and mark historical evidence for review', () => {
    const start = beginImport(record(imported()), 'upload'), p = url(start.project)
    expect(active(p).source.revision).toBeGreaterThan(start.context.sourceRevision)
    expect(active(p).manualEvidence[0]?.status).toBe('needs-review')
    expect(applySnapshot(p, start.context, { status: 'readable', snapshot: save('late'), issues: [] })).toBe(p)
  })
  it('holds changed URL trainer identity for explicit assignment', () => {
    const start = beginImport(url(record(imported())), 'url')
    const p = applySnapshot(start.project, start.context, { status: 'readable', snapshot: save('other', [1], 20, 'BLUE'), issues: [] })
    expect(active(p).snapshot?.hash).toBe('first'); expect(active(p).heldImport?.snapshot.hash).toBe('other')
    const assigned = reduceProject(p, { type: 'assign-held', targetAttemptId: p.activeAttemptId })
    expect(active(assigned).snapshot?.hash).toBe('other')
    expect(active(assigned).manualEvidence[0]?.status).toBe('needs-review')
  })
  it('clock regression remains a concern rather than deleting history or asserting rollback', () => {
    const p = imported(record(imported()), save('clock', [1, 2], 1)), a = active(p), e = a.manualEvidence[0]!
    expect(a.snapshot?.hash).toBe('clock'); expect(a.manualEvidence).toHaveLength(1)
    expect(e.status).toBe('needs-review'); expect(e.continuityRevision).toBe(0)
    expect(manualEvidenceIsEligible(e, a)).toBe(false)
    expect(a.diagnostics?.join(' ')).toMatch(/clock.*review/i)
    expect(a.diagnostics?.join(' ')).not.toMatch(/rollback proven/i)
    const confirmed = active(reduceProject(p, { type: 'reconfirm-manual', evidenceId: e.id }))
    expect(confirmed.manualEvidence[0]?.continuityRevision).toBe(0)
    expect(confirmed.manualEvidence[0]?.status).toBe('archived')
    expect(manualEvidenceIsEligible(confirmed.manualEvidence.at(-1)!, confirmed)).toBe(true)
  })
  it('eligibility excludes wrong attempts, prior revisions, archived and review records', () => {
    const a = active(record(createProject('player'))), e = a.manualEvidence[0]!
    expect(manualEvidenceIsEligible(e, a)).toBe(true)
    for (const patch of [{ attemptId: 'other' }, { continuityRevision: 100 }, { status: 'archived' as const }, { status: 'needs-review' as const }]) expect(manualEvidenceIsEligible({ ...e, ...patch }, a)).toBe(false)
  })
  it('updates branch choices without attributing them to another attempt', () => {
    const p = reduceProject(createProject('player'), { type: 'set-branches', branches: { starter: 'bulbasaur', fossil: 'dome' } })
    expect(active(p).branches).toEqual({ starter: 'bulbasaur', fossil: 'dome' })
    expect(active(createAttempt(p, 'glitch', 'B')).branches).toEqual({})
  })
  it('partial RA success preserves last good failed feeds and survives attempt reset', () => {
    let p = reduceProject(createProject('player'), { type: 'hardcore-result', result: { progress: [feed('main'), feed('oak')], failures: [] } })
    p = reduceProject(p, { type: 'hardcore-result', result: { progress: [feed('glitch')], failures: [{ setKey: 'oak', reason: 'offline' }] } })
    expect(p.accountProgress.find(f => f.setKey === 'oak')).toMatchObject({ stale: true, unlocks: [{ achievementId: 1 }], unavailableReason: 'offline' })
    p = reduceProject(p, { type: 'reset-attempt' }); expect(p.accountProgress).toHaveLength(3)
  })
  it('mismatched RA account never replaces attributed progress', () => {
    let p = reduceProject(createProject('player'), { type: 'hardcore-result', result: { progress: [feed('main')], failures: [] } })
    p = reduceProject(p, { type: 'hardcore-result', result: { progress: [feed('main', 'other')], failures: [] } })
    expect(p.accountProgress[0]?.accountIdentity).toBe('player'); expect(p.accountProgress[0]?.stale).toBe(true)
  })
})

describe('explicit evidence transitions', () => {
  it('a pending pre-reset result remains invalid after Undo', () => {
    const start = beginImport(imported(), 'upload')
    const p = reduceProject(reduceProject(start.project, { type: 'reset-attempt' }), { type: 'undo-reset' })
    expect(applySnapshot(p, start.context, { status: 'readable', snapshot: save('late'), issues: [] })).toBe(p)
    expect(active(p).snapshot?.hash).toBe('first')
  })
  it('assigns a held identity to a named attempt without altering the canonical snapshot', () => {
    let p = imported(); const canonicalId = p.activeAttemptId
    p = createAttempt(p, 'glitch', 'Other'); const targetAttemptId = p.activeAttemptId
    p = reduceProject(p, { type: 'switch-attempt', attemptId: canonicalId })
    const start = beginImport(url(p), 'url')
    p = applySnapshot(start.project, start.context, { status: 'partial', snapshot: save('other', [1], 20, 'BLUE'), issues: [] })
    p = reduceProject(p, { type: 'assign-held', targetAttemptId })
    expect(active(p).snapshot?.hash).toBe('first')
    expect(p.attempts.find(a => a.id === targetAttemptId)?.snapshot?.hash).toBe('other')
    expect(active(p).heldImport).toBeUndefined()
  })
  it('does not assign a held result after a source revision edit', () => {
    const start = beginImport(url(imported()), 'url')
    const held = applySnapshot(start.project, start.context, { status: 'readable', snapshot: save('other', [1], 20, 'BLUE'), issues: [] })
    const p = reduceProject(held, { type: 'set-source', source: { kind: 'url', url: '/different' } })
    expect(reduceProject(p, { type: 'assign-held', targetAttemptId: p.activeAttemptId })).toBe(p)
  })
  it('rejects stale failures and cancellations without clearing the newer request', () => {
    const first = beginImport(imported(), 'upload'), second = beginImport(first.project, 'upload')
    expect(reduceProject(second.project, { type: 'cancel-import', context: first.context })).toBe(second.project)
    expect(reduceProject(second.project, { type: 'import-error', context: first.context, reason: 'old failure' })).toBe(second.project)
  })
  it('unknown partial sections replace prior known sections without inventing zero', () => {
    const start = beginImport(imported(), 'upload'), partial = { ...save('partial'), ownedDex: unknown, badgeMask: unknown }
    const p = applySnapshot(start.project, start.context, { status: 'partial', snapshot: partial, issues: [{ code: 'partial', message: 'unavailable' }] })
    expect(active(p).snapshot?.ownedDex).toEqual(unknown); expect(active(p).snapshot?.badgeMask).toEqual(unknown)
  })
})

it('failed or ignored refreshes retain existing continuity diagnostics', () => {
  const reviewed = imported(record(imported()), save('clock', [1, 2], 1)), start = beginImport(reviewed, 'url')
  const rejected = applySnapshot(start.project, start.context, { status: 'rejected', issues: [{ code: 'offline', message: 'Offline' }] })
  expect(active(rejected).diagnostics?.join(' ')).toMatch(/clock.*review/i)
  const ignored = reduceProject(rejected, { type: 'ignore-hash', hash: 'ignored' }), next = beginImport(ignored, 'url')
  const result = applySnapshot(next.project, next.context, { status: 'readable', snapshot: save('ignored'), issues: [] })
  expect(active(result).diagnostics?.join(' ')).toMatch(/clock.*review/i)
})

function urlObservation(p: MasteryProject, snapshot: SaveSnapshot, partial = false) {
  const start = beginImport(p, 'url')
  return applySnapshot(start.project, start.context, { status: partial ? 'partial' : 'readable', snapshot, issues: [] })
}
function restored(p: MasteryProject) {
  const result = restoreProject(serializeProject(p))
  if (!result.ok) throw new Error(result.error)
  return result.project
}
describe('last-known continuity comparisons across partial observations', () => {
  it.each([false, true])('holds RED to unknown to BLUE URL identity, restored=%s', restore => {
    let p = record(imported(url(createProject('player'))))
    p = urlObservation(p, { ...save('unknown'), trainer: unknown }, true)
    expect(active(p).snapshot?.trainer).toEqual(unknown)
    if (restore) p = restored(p)
    p = urlObservation(p, save('blue', [1, 2], 11, 'BLUE'))
    expect(active(p).snapshot?.hash).toBe('unknown')
    expect(active(p).snapshot?.trainer).toEqual(unknown)
    expect(active(p).heldImport?.snapshot.hash).toBe('blue')
    p = reduceProject(p, { type: 'assign-held', targetAttemptId: p.activeAttemptId })
    expect(active(p).snapshot?.hash).toBe('blue')
    expect(active(p).manualEvidence[0]?.status).toBe('needs-review')
  })
  it.each(['playTime', 'ownedDex', 'badgeMask'] as const)('detects known to unknown to earlier known %s independently', section => {
    let p = record(imported(url(createProject('player'))))
    p = urlObservation(p, { ...save('partial'), [section]: unknown }, true)
    expect(active(p).snapshot?.[section]).toEqual(unknown)
    p = restored(p)
    const earlier = save('earlier')
    if (section === 'playTime') earlier.playTime = { known: true, value: { hours: 1, minutes: 0, seconds: 0 } }
    if (section === 'ownedDex') earlier.ownedDex = { known: true, value: [1] }
    if (section === 'badgeMask') earlier.badgeMask = { known: true, value: 1 }
    p = urlObservation(p, earlier)
    expect(active(p).snapshot?.hash).toBe('earlier')
    expect(active(p).manualEvidence[0]?.status).toBe('needs-review')
    expect(manualEvidenceIsEligible(active(p).manualEvidence[0]!, active(p))).toBe(false)
    expect(active(p).diagnostics?.join(' ')).toMatch(/continuity needs review/i)
  })
  it('new and reset attempts clear baselines while Undo restores them', () => {
    let p = imported(url(createProject('player')))
    p = urlObservation(p, { ...save('partial'), trainer: unknown }, true)
    const original = active(p).continuityBaseline
    expect(original?.trainer).toEqual({ name: 'RED', id: 1 })
    expect(active(createAttempt(p, 'glitch', 'Fresh')).continuityBaseline).toBeUndefined()
    const reset = reduceProject(p, { type: 'reset-attempt' })
    expect(active(reset).continuityBaseline).toBeUndefined()
    const undo = reduceProject(reset, { type: 'undo-reset' })
    expect(active(undo).continuityBaseline).toEqual(original)
    expect(active(urlObservation(undo, save('blue', [1, 2], 11, 'BLUE'))).heldImport?.snapshot.hash).toBe('blue')
    expect(active(urlObservation(reset, save('fresh-blue', [1, 2], 1, 'BLUE'))).snapshot?.hash).toBe('fresh-blue')
  })
  it('last-known metadata advances to the latest known observation and does not fill unknown facts', () => {
    let p = imported(url(createProject('player')))
    p = urlObservation(p, save('later', [1, 2, 3], 20))
    p = urlObservation(p, { ...save('partial'), trainer: unknown, playTime: unknown, ownedDex: unknown, badgeMask: unknown }, true)
    expect(active(p).continuityBaseline).toMatchObject({ trainer: { name: 'RED', id: 1 }, playTime: { hours: 20 }, ownedDex: [1, 2, 3] })
    expect(active(p).snapshot).toMatchObject({ trainer: unknown, playTime: unknown, ownedDex: unknown, badgeMask: unknown })
  })
})

describe('bounded recurring import diagnostics', () => {
  it('one ordinary failure after 10000 repeated messages remains exportable', () => {
    const p = imported(), a = active(p)
    a.diagnostics = Array.from({ length: 10000 }, () => 'Offline')
    expect(() => serializeProject(p)).not.toThrow()
    const start = beginImport(p, 'url')
    const failed = reduceProject(start.project, { type: 'import-error', context: start.context, reason: 'Offline' })
    expect(() => serializeProject(failed)).not.toThrow()
    expect(active(failed).diagnostics?.filter(message => message === 'Offline')).toHaveLength(1)
    expect(active(failed).snapshot).toEqual(a.snapshot)
  })
  it.each(['rejected', 'partial', 'ignored', 'held'] as const)('bounds %s diagnostics while retaining unresolved continuity notices', kind => {
    let p = record(imported(url(createProject('player'))))
    p = urlObservation(p, save('clock', [1, 2], 1))
    const notice = active(p).diagnostics!.find(message => /clock.*review/i.test(message))!
    active(p).diagnostics = [notice, ...Array.from({ length: 9999 }, (_, i) => `Transient issue ${i}`)]
    if (kind === 'ignored') p = reduceProject(p, { type: 'ignore-hash', hash: 'ignored' })
    const start = beginImport(p, 'url')
    if (kind === 'rejected') p = reduceProject(start.project, { type: 'import-error', context: start.context, reason: 'Offline' })
    else p = applySnapshot(start.project, start.context, { status: 'partial', snapshot: save(kind, [1, 2], 2, kind === 'held' ? 'BLUE' : 'RED'), issues: [{ code: 'partial', message: 'Latest issue' }] })
    expect(active(p).diagnostics).toContain(notice)
    expect(active(p).diagnostics!.length).toBeLessThanOrEqual(256)
    expect(active(p).manualEvidence[0]?.status).toBe('needs-review')
    expect(() => serializeProject(p)).not.toThrow()
    if (kind === 'rejected') expect(active(p).diagnostics).toContain('Offline')
    if (kind === 'partial') expect(active(p).diagnostics).toContain('Latest issue')
  })
})

it('marks legacy history for review when comparison values were already lost before the upgrade', () => {
  const p = record(imported(url(createProject('player'))))
  // Old version1 exports did not retain a baseline after all four fields became unknown.
  active(p).snapshot = { ...save('legacy-partial'), trainer: unknown, playTime: unknown, ownedDex: unknown, badgeMask: unknown }
  active(p).continuityBaseline = undefined
  const legacy = restored(p)
  const next = urlObservation(legacy, save('readable-again', [1], 1, 'BLUE'))
  expect(active(next).manualEvidence[0]?.status).toBe('needs-review')
  expect(manualEvidenceIsEligible(active(next).manualEvidence[0]!, active(next))).toBe(false)
  expect(active(next).diagnostics?.join(' ')).toMatch(/unreadable.*review/i)
})

function encounterSave(special = 21, pp = 6, releaseDefeated = false): SaveSnapshot {
 return { ...save(), party: { known: true, value: [{ internalSpeciesId: 21, dexNumber: 151,
  location: { kind: 'party', slot: 1 }, level: { known: true, value: 7 }, special: { known: true, value: special },
  moves: { known: true, value: [{ id: 45, pp, ppUps: 0 }] } }] },
  events: { known: true, value: { EVENT_BEAT_ROUTE_25_TRAINER_1: releaseDefeated } } }
}
function startedEncounter() {
 return reduceProject(imported(createProject('player'), encounterSave()), { type: 'record-manual', key: 'glitch:encounter-setup',
  value: JSON.stringify({ methodId: 'candidate-57642', transport: 'ordinary-trainer-fly', successfulGrowls: 6,
   sourceRevision: 0, preflightReadiness: 'ready', donor: { slot: 1, internalSpeciesId: 21, special: 21 } }) })
}
describe('imported encounter donor binding',()=>{
 it('preserves an active setup across spent PP and the consumed menu-release trainer',()=>{
  const before=startedEncounter(),after=imported(before,encounterSave(21,0,true))
  expect(active(after).manualEvidence[0]!.status).toBe('active')
  expect(active(after).continuityRevision).toBe(active(before).continuityRevision)
 })
 it.each(['changed','unreadable'] as const)('marks %s donor setup for review without erasing older history',kind=>{
  const before=startedEncounter(),changed=encounterSave(226)
  if(kind==='unreadable')changed.party=unknown
  const after=imported(before,changed)
  expect(active(after).manualEvidence[0]!.status).toBe('needs-review')
  expect(active(after).manualEvidence[0]!.value).toBe(active(before).manualEvidence[0]!.value)
  expect(active(imported(after,encounterSave())).manualEvidence[0]!.status).toBe('needs-review')
 })
 it('restores ordinary completion history while invalidating pending setup starts',()=>{
  let before=startedEncounter()
  before=reduceProject(before,{type:'record-manual',key:'rule:57642:completed',value:true})
  const result=restoreProject(serializeProject(before));expect(result.ok).toBe(true)
  if(!result.ok)return
  expect(active(result.project).manualEvidence[0]!.status).toBe('needs-review')
  expect(active(result.project).manualEvidence[1]!.status).toBe('active')
 })
})

it('requires labelled new-setup controls instead of copying an old start through generic reconfirm',()=>{
 const before=startedEncounter(),oldStart=active(before).manualEvidence[0]!
 const restored=restoreProject(serializeProject(before));expect(restored.ok).toBe(true)
 if(!restored.ok)return
 const next=reduceProject(restored.project,{type:'reconfirm-manual',evidenceId:oldStart.id})
 expect(active(next).manualEvidence).toHaveLength(1)
 expect(active(next).manualEvidence[0]!.status).toBe('needs-review')
})

it('Undo of an app reset cannot resurrect a live pending encounter from its attempt backup',()=>{
 const before=startedEncounter()
 const next=reduceProject(reduceProject(before,{type:'reset-attempt'}),{type:'undo-reset'})
 expect(active(next).manualEvidence[0]!.status).toBe('needs-review')
})

function completedEncounterBeforeCatch() {
 let project=startedEncounter()
 const start=active(project).manualEvidence[0]!,scope=`glitch:encounter:${start.id}`
 for(const key of ['trainer-escaped','menus-restored','transform-confirmed','neutral-attack-stage','no-intervening-encounter']){
  project=reduceProject(project,{type:'record-manual',key:`${scope}:${key}`,value:true})
 }
 project=reduceProject(project,{type:'record-manual',key:`${scope}:successful-growls`,value:6})
 return reduceProject(project,{type:'record-manual',key:`${scope}:phase`,value:'pending'})
}
function catchAndReorderSave() {
 const snapshot=encounterSave(21,0,true),donor=snapshot.party.known?snapshot.party.value[0]!:null
 if(!donor)throw new Error('Fixture donor missing')
 snapshot.party={known:true,value:[{...donor,special:{known:true,value:6},level:{known:true,value:1}},
  {...donor,location:{kind:'party',slot:2}}]}
 return snapshot
}
describe('imported Mew continuation boundary',()=>{
 it('keeps only an eligible confirmation opportunity after catch/reorder in one import',()=>{
  const before=completedEncounterBeforeCatch(),after=imported(before,catchAndReorderSave())
  expect(active(after).manualEvidence[0]!.status).toBe('active')
  expect(active(after).manualEvidence.some(e=>e.key.endsWith(':mew-caught-level-one'))).toBe(false)
 })
 it('retains attributed completed catch after the donor is rearranged or boxed',()=>{
  let before=completedEncounterBeforeCatch()
  const scope=`glitch:encounter:${active(before).manualEvidence[0]!.id}`
  before=reduceProject(before,{type:'record-manual',key:`${scope}:mew-caught-level-one`,value:true})
  before=reduceProject(before,{type:'record-manual',key:`${scope}:phase`,value:'exp'})
  const after=imported(before,catchAndReorderSave())
  expect(active(after).manualEvidence[0]!.status).toBe('active')
  const restored=restoreProject(serializeProject(after));expect(restored.ok).toBe(true)
  if(restored.ok)expect(active(restored.project).manualEvidence[0]!.status).toBe('needs-review')
 })
 it('reviews unrelated donor drift even with an old level-one Mew present',()=>{
  const before=completedEncounterBeforeCatch(),snapshot=catchAndReorderSave()
  if(snapshot.party.known)snapshot.party.value[1]!.special={known:true,value:226}
  const after=imported(before,snapshot)
  expect(active(after).manualEvidence[0]!.status).toBe('needs-review')
 })
})
