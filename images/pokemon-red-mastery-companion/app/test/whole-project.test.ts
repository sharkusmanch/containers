import { describe, expect, it } from 'vitest'
import type { MasteryProject, SaveSnapshot } from '../src/model'
import { dataset } from '../src/data/manifest'
import membership from '../docs/evidence/membership-recheck.json'
import { validateDataset } from '../src/data/validate'
import { planRun } from '../src/planner/route'
import { planGlitches } from '../src/planner/glitches'
import { activeAttempt, applySnapshot, beginImport, createProject } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { restoreProject, serializeProject } from '../src/state/persist'
import { brock, erikaAdded, kogaAdded, known, mistyAdded, pokemon, snapshot, unknown } from './planner-fixtures'

// Independent source-audit rosters, not values obtained from planner output.
const preBrock = [...brock, 1, 2, 3]
const preMisty = [...preBrock, ...mistyAdded, 31, 34]
const preKoga = [...preMisty, ...kogaAdded, 36, 40, 134, 106]
const preErika = [...preKoga, ...erikaAdded, 138, 139]
const preSurge = [...preErika, 144]
const firstLeague = [...preSurge, 146]
const gymHistory = [108058, 108059, 108062, 108061, 108060, 108063, 108065, 108068]

function input(project: MasteryProject) { return { project, attempt: activeAttempt(project), dataset } }
function action(project: MasteryProject, id: number) {
  return planRun(input(project)).actions.find(a => a.id === `rule-${id}`)!
}
function record(project: MasteryProject, key: string, value: boolean | string = true) {
  return reduceProject(project, { type: 'record-manual', key, value })
}
function importObservation(project: MasteryProject, s: SaveSnapshot, hour: number) {
  // Synthetic observations exercise state integration; they are never capture/runtime evidence.
  s.trainer = known({ id: 1234, name: 'TEST' })
  s.playTime = known({ hours: hour, minutes: 0, seconds: 0 })
  s.hash = `scenario-${hour}`
  s.importedAt = '2026-10-11T12:00:00Z'
  const pending = beginImport(project, 'upload')
  return applySnapshot(pending.project, pending.context, { status: 'readable', snapshot: s, issues: [] })
}
function prepared(owned: number[], badges: number, level: number) {
  const s = snapshot(owned, badges)
  s.party = known([pokemon(1, level)])
  s.events = known({ EVENT_GOT_POKEBALLS_FROM_OAK: true })
  return s
}

// Catches reordered deadlines, incorrect badge/roster boundaries, lost eligible history,
// snapshot-as-award inference, sourced-method promotion, and cross-attempt contamination.
describe('whole-project sourced mastery scenario (synthetic, no runtime claim)', () => {
  it('matches the independently refreshed published IDs while preserving runtime release blockers', () => {
    for (const set of membership.results) {
      expect(dataset.rules.filter(r => r.setKey === set.setKey).map(r => r.id).sort((a, b) => a - b))
        .toEqual(set.publishedIds)
    }
    expect(validateDataset(dataset, 'development')).toEqual([])
    const release = validateDataset(dataset, 'release')
    expect(release.filter(issue => issue.code === 'unvalidated-rule')).toHaveLength(110)
    expect(release.filter(issue => issue.code === 'unvalidated-method')).toHaveLength(8)
    expect(release.some(issue => issue.code === 'runtime-prerequisite')).toBe(true)
  })
  it('follows ordered gyms, deferred Safari, Silph, separate League clears, postgame and fresh extension', () => {
    let project = reduceProject(createProject('scenario-player'), { type: 'set-branches', branches: {
      starter: 'bulbasaur', eevee: 'vaporeon', dojo: 'hitmonlee', fossil: 'helix', moonstones: [31, 34],
    } })
    project = importObservation(project, prepared(preBrock, 0, 14), 1)
    expect(action(project, 108058).readiness).toBe('ready')
    expect(action(project, 108059).readiness).toBe('blocked')
    project = record(project, 'rule:108058:completed')
    project = importObservation(project, prepared(preMisty, 1, 21), 2)
    expect(action(project, 108059).readiness).toBe('ready')
    expect(action(project, 108058).readiness).toBe('ready') // Eligible battle history survives forward progress.
    project = record(project, 'rule:108059:completed')

    const silph = prepared(preMisty, 3, 21)
    silph.events = known(Object.fromEntries(Object.keys(dataset.game.eventFlags)
      .filter(flag => /BEAT_SILPH_CO_.*TRAINER/.test(flag)).map(flag => [flag, false])))
    silph.events.value.EVENT_BEAT_SILPH_CO_RIVAL = false
    silph.events.value.EVENT_BEAT_SILPH_CO_GIOVANNI = false
    silph.events.value.EVENT_BEAT_SILPH_CO_5F_TRAINER_0 = true
    silph.bag = known([{ position: 1, rawItemId: 48, quantity: 1 }])
    project = importObservation(project, silph, 3)
    expect(action(project, 108069).readiness).toBe('ready')
    expect(action(project, 108051).readiness).not.toBe('ready')
    project = record(project, 'rule:108069:completed')
    project = record(project, 'rule:108051:completed') // Synthetic witnessed-clear history, not inferred from boss flags.
    expect(action(project, 108050).readiness).toBe('ready')

    const safari = prepared(preKoga, 3, 43)
    safari.events = known({ EVENT_GOT_POKEBALLS_FROM_OAK: true, EVENT_GOT_HM03: true })
    safari.party = known([{ ...pokemon(131, 43), moves: known([{ id: 57, pp: 15, ppUps: 0 }]) }])
    safari.objectFlags = known(Object.fromEntries(Object.keys(dataset.game.objectFlags)
      .filter(flag => flag.startsWith('TOGGLE_SAFARI_ZONE')).map(flag => [flag, false])))
    safari.hiddenItemFlags = known({ 17: false })
    safari.bag = known([])
    project = importObservation(project, safari, 4)
    project = record(record(project, 'rule:108045:session-prepared'), 'safari:supplies-ready')
    expect(action(project, 108045).readiness).toBe('blocked')
    expect(action(project, 108062).readiness).toBe('ready')
    const deferred = planRun(input(project)).areas!.find(a => a.id === 'safari')!.entries
      .filter(e => e.entry.ruleIds.includes(108045))
    expect(deferred).toHaveLength(11)
    expect(deferred.every(e => e.completion.known && !e.completion.value)).toBe(true)
    project = record(project, 'rule:108062:completed')
    project = importObservation(project, { ...safari, badgeMask: known(19) }, 5)
    expect(action(project, 108045).readiness).toBe('ready')
    expect(action(project, 108061).readiness).toBe('blocked')
    project = record(project, 'rule:108045:completed')

    const gyms = [
      [preErika, 19, 29, 108061], [preSurge, 27, 24, 108060],
      [preSurge, 31, 43, 108063], [preSurge, 63, 47, 108065], [preSurge, 127, 50, 108068],
    ] as const
    for (const [dex, badges, cap, id] of gyms) {
      project = importObservation(project, prepared([...dex], badges, cap), 6 + gyms.findIndex(g => g[3] === id))
      expect(action(project, id).readiness, `gym ${id} at its actual cap`).toBe('ready')
      project = record(project, `rule:${id}:completed`)
    }

    project = importObservation(project, prepared(firstLeague, 255, 50), 11)
    project = record(project, 'rule:108171:session-prepared')
    expect(action(project, 108171).readiness).toBe('ready')
    expect(action(project, 165737).readiness).toBe('ready')
    project = record(project, 'rule:108171:completed')
    project = record(project, 'rule:4422:session-prepared')
    project = record(project, 'rule:108169:session-prepared')
    const redTeam = prepared(firstLeague, 255, 60)
    redTeam.party = known(Array.from({ length: 6 }, () => pokemon(23, 60)))
    project = importObservation(project, redTeam, 12)
    expect(action(project, 108169).readiness).toBe('ready')
    expect(action(project, 4422).readiness).toBe('blocked')
    const solo = { ...redTeam, party: known([pokemon(23, 60)]) }
    project = importObservation(project, solo, 13)
    expect(action(project, 4422).readiness).toBe('ready')
    expect(action(project, 108169).readiness).toBe('blocked')

    const postgame = { ...solo, ownedDex: known([...firstLeague, 150]), hallOfFame: known(true),
      events: known({ EVENT_BEAT_MEWTWO: true }), objectFlags: known({ TOGGLE_CERULEAN_CAVE_GUY: true }) }
    project = importObservation(project, postgame, 14)
    expect(action(project, 108176).readiness).toBe('unknown') // Resolution is not ordinary-ball capture history.
    expect(gymHistory.every(id => action(project, id).readiness === 'ready')).toBe(true)
    expect(planRun(input(project)).achievements.every(a => !a.hardcoreEarned)).toBe(true)
    const extendedDex = Array.from({ length: 151 }, (_, n) => n + 1)
    project = importObservation(project, { ...postgame, ownedDex: known(extendedDex), party: known([pokemon(151, 100)]) }, 15)
    project = record(project, 'method:57655:runtime-validated') // A user checkbox cannot validate a sourced method.
    const methods = planGlitches(input(project)).methods
    expect(methods.map(m => m.ruleId)).toEqual([57639, 57640, 57641, 57642, 57643, 57644, 57645, 57655])
    expect(methods.every(m => m.auditStatus === 'sourced' && m.readiness !== 'ready')).toBe(true)
    expect(methods.find(m => m.ruleId === 57655)!.transitionEvidence.known).toBe(false)
    expect(methods.find(m => m.ruleId === 57655)!.hardcoreEarnedAt).toBeNull()

    const canonicalId = project.activeAttemptId
    project = reduceProject(project, { type: 'create-attempt', kind: 'glitch', name: 'Expendable glitch attempt' })
    expect(activeAttempt(project)).toMatchObject({ snapshot: null, branches: {}, manualEvidence: [], source: { enabled: false } })
    project = reduceProject(project, { type: 'switch-attempt', attemptId: canonicalId })
    const pending = beginImport(project, 'upload')
    project = reduceProject(pending.project, { type: 'create-attempt', kind: 'speedrun', name: 'Fresh attempt' })
    project = applySnapshot(project, pending.context, { status: 'readable', snapshot: postgame, issues: [] })
    expect(activeAttempt(project)).toMatchObject({ snapshot: null, branches: {}, manualEvidence: [], source: { enabled: false } })
    expect(activeAttempt(project).source.url).toBeUndefined()
    expect(planGlitches(input(project)).methods.find(m => m.ruleId === 57641)!.readiness).not.toBe('ready')
    const restored = restoreProject(serializeProject(project))
    expect(restored.ok).toBe(true)
    if (!restored.ok) throw new Error(restored.error)
    project = reduceProject(restored.project, { type: 'switch-attempt', attemptId: canonicalId })
    expect(activeAttempt(project).snapshot?.ownedDex).toEqual(known(extendedDex))
    expect(action(project, 108058).readiness).toBe('ready')
  })

  it('retains every deadline in route order and does not silently remove already earned obligations', () => {
    const project = createProject('scenario-player')
    project.accountProgress = [{ setKey: 'main', apiGameId: 724, accountIdentity: 'scenario-player',
      stale: false, lastSuccessfulFetchAt: '2026-10-11T00:00:00Z', unlocks: [{ achievementId: 108023, earnedAt: '2025-01-01T00:00:00Z' }] }]
    const plan = planRun(input(project))
    expect(plan.achievements).toHaveLength(234)
    const index = (id: number) => plan.actions.findIndex(a => a.id === `rule-${id}`)
    for (const [before, after] of [[108023, 165609], [108029, 108030], [108138, 108030],
      [108039, 108038], [108069, 108051], [108051, 108050], [108056, 108065]] as const) {
      expect(index(before)).toBeGreaterThanOrEqual(0)
      expect(index(before)).toBeLessThan(index(after))
    }
    expect(plan.actions.map(a => a.routeStepId).filter((id, n, all) => all.indexOf(id) === n)).toEqual([
      'pallet', 'brock', 'moon', 'misty-prep', 'anne', 'misty', 'celadon', 'tower', 'safari-prep',
      'silph-rival', 'silph-clear', 'koga', 'surf-cleanup', 'erika', 'articuno', 'surge', 'sabrina',
      'cinnabar', 'blaine', 'giovanni', 'victory', 'league50', 'league-solo', 'league-red', 'postgame',
      'glitch-postgame', 'glitch-expendable', 'glitch-fresh',
    ])
    expect(action(project, 108023).readiness).toBe('unknown')
    expect(plan.reservations.some(r => r.consumingRuleId === 57643)).toBe(true)
  })

  it('keeps known missed ship/Silph/Safari cutoffs distinct from unknown historical facts', () => {
    let project = createProject()
    const s = snapshot()
    s.events = known({ EVENT_SS_ANNE_LEFT: true, EVENT_BEAT_SS_ANNE_8_TRAINER_0: false,
      EVENT_BEAT_SILPH_CO_RIVAL: false, EVENT_BEAT_SILPH_CO_2F_TRAINER_0: true, EVENT_BEAT_SILPH_CO_5F_TRAINER_0: true })
    project = importObservation(project, s, 1)
    expect(action(project, 108029).readiness).toBe('missed')
    expect(action(project, 108069).readiness).toBe('missed')
    project = record(project, 'safari:prior-pickup')
    expect(action(project, 108045).readiness).toBe('missed')
    project = reduceProject(project, { type: 'set-source', source: { kind: 'upload', enabled: false } })
    expect(activeAttempt(project).manualEvidence[0]!.status).toBe('needs-review')
    const unreadable = { ...s, events: unknown, ownedDex: unknown, badgeMask: unknown, party: unknown, bag: unknown }
    project = importObservation(project, unreadable, 2)
    for (const id of [108029, 108069, 108045, 108058, 108176]) expect(action(project, id).readiness, String(id)).toBe('unknown')
    expect(planRun(input(project)).checkpoints[0]!.ownedCount.known).toBe(false)
  })
})
