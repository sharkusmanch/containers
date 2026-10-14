import { describe, expect, it } from 'vitest'
import { dataset } from '../src/data/manifest'
import { validateDataset } from '../src/data/validate'
import { evaluateOakCheckpoint } from '../src/planner/readiness'
import { counterProgress } from '../src/planner/areas'
import { planRun } from '../src/planner/route'
import { homeStage } from '../src/ui/home'
import { createProject } from '../src/state/project'
import { restoreProject, serializeProject } from '../src/state/persist'
import { keyMigrations, migrateEvidenceKeys, retiredMarks } from '../src/state/key-migrations'
import type { BranchChoices, PlanInput, SaveSnapshot } from '../src/model'
import { brock, erikaAdded, known, kogaAdded, mistyAdded, pokemon, snapshot } from './planner-fixtures'

const entries = dataset.areas!.flatMap(a => a.entries)
const GR = 108368, LI = 108367
const counted = (id: number) => entries.filter(e => e.ruleIds.includes(id))

// Guide (Items pages, phase 2 verification): /221 trainers per map, hand-transcribed independently of the data.
const grPerMap: Record<string, number> = {
  ViridianForest: 3, Route3: 8, MtMoon1F: 7, MtMoonB2F: 5, Route4: 1, CeruleanCity: 1, Route24: 6, Route25: 9, Route6: 6, Route11: 10,
  Route9: 8, Route10: 6, RockTunnel1F: 7, RockTunnelB1F: 8, Route8: 8, RocketHideoutB1F: 5, RocketHideoutB2F: 1, RocketHideoutB3F: 2, RocketHideoutB4F: 3,
  PokemonTower3F: 3, PokemonTower4F: 3, PokemonTower5F: 4, PokemonTower6F: 3, PokemonTower7F: 3,
  Route12: 7, Route13: 10, Route14: 10, Route15: 10, Route16: 6, Route17: 10, Route18: 3, Route21: 9,
  PokemonMansion1F: 1, PokemonMansion2F: 1, PokemonMansion3F: 1, PokemonMansionB1F: 2, Route19: 10, Route20: 10,
  VictoryRoad1F: 2, VictoryRoad2F: 5, VictoryRoad3F: 4,
}

describe('Genocide Route matches the verified /221 list', () => {
  it('lists exactly 221 counted trainers, per map as the guide does', () => {
    const list = counted(GR)
    expect(list).toHaveLength(221)
    expect(list.every(e => e.kind === 'trainer')).toBe(true)
    const perMap: Record<string, number> = {}
    for (const e of list) perMap[e.area] = (perMap[e.area] ?? 0) + 1
    expect(perMap).toEqual(grPerMap)
    expect(dataset.rules.find(r => r.id === GR)!.counter?.total).toBe(221)
  })
  it('counts the fossil Super Nerd and the Cerulean burgled-house Rocket', () => {
    for (const id of ['trainer-EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD', 'story-EVENT_BEAT_CERULEAN_ROCKET_THIEF'])
      expect(entries.find(e => e.id === id)!.ruleIds, id).toContain(GR)
  })
  it('keeps the five reported non-counting trainers as "fight anyway" without counting them', () => {
    const extras = entries.filter(e => e.uncountedFor?.includes(GR)).map(e => e.id).sort()
    expect(extras).toEqual([
      'story-EVENT_BEAT_ROUTE24_ROCKET', 'trainer-EVENT_BEAT_GAME_CORNER_ROCKET', 'trainer-EVENT_BEAT_MANSION_3_TRAINER_0',
      'trainer-EVENT_BEAT_ROUTE_8_TRAINER_6', 'trainer-EVENT_BEAT_ROUTE_9_TRAINER_6',
    ])
    for (const id of extras) {
      const e = entries.find(x => x.id === id)!
      expect(e.ruleIds).not.toContain(GR)
      expect(e.instructions.join(' ')).toMatch(/anyway|required battle/)
    }
  })
})

describe('Living Itemfinder matches the /109 counter', () => {
  const generated = dataset.game.itemIds
  const name = (raw?: number) => Object.keys(generated).find(k => generated[k] === raw) ?? ''
  it('counts 109 reachable pickups and no gifts, TMs or key items', () => {
    const list = counted(LI)
    expect(list).toHaveLength(109)
    expect(list.filter(e => e.kind !== 'pickup')).toEqual([])
    expect(list.filter(e => name(e.rawItemId).startsWith('TM_'))).toEqual([])
    expect(list.filter(e => ['SILPH_SCOPE', 'LIFT_KEY', 'CARD_KEY', 'SECRET_KEY', 'GOLD_TEETH'].includes(name(e.rawItemId)))).toEqual([])
    expect(list.filter(e => e.id.startsWith('hidden-'))).toHaveLength(48) // guide: 48 hidden + 61 visible
  })
  it('keeps the 39 non-counting pickups listed as optional, with the Route 2 Cut items counted', () => {
    const optional = entries.filter(e => e.uncountedFor?.includes(LI))
    expect(optional).toHaveLength(39)
    expect(optional.every(e => e.kind === 'pickup' && !e.ruleIds.includes(LI))).toBe(true)
    for (const id of ['pickup-TOGGLE_ROUTE_2_ITEM_1', 'pickup-TOGGLE_ROUTE_2_ITEM_2', 'hidden-52', 'hidden-35'])
      expect(entries.find(e => e.id === id)!.ruleIds, id).toContain(LI)
    for (const id of ['hidden-18', 'hidden-19', 'pickup-TOGGLE_VICTORY_ROAD_2F_ITEM_2', 'pickup-TOGGLE_POKEMON_MANSION_B1F_ITEM_2'])
      expect(entries.find(e => e.id === id)!.uncountedFor, id).toContain(LI)
  })
  it('reports progress against the counter, never against extras', () => {
    const project = createProject(), attempt = project.attempts[0]!
    attempt.snapshot = snapshot()
    const input: PlanInput = { project, attempt, dataset }
    const vf = 'hidden-0'
    attempt.manualEvidence.push({ id: 'm1', attemptId: attempt.id, continuityRevision: 0, status: 'active', key: `area:${vf}`, value: true, recordedAt: '2026-10-14T00:00:00Z' })
    attempt.manualEvidence.push({ id: 'm2', attemptId: attempt.id, continuityRevision: 0, status: 'active', key: 'area:hidden-18', value: true, recordedAt: '2026-10-14T00:00:00Z' })
    const plan = planRun(input)
    const li = counterProgress(dataset.rules.find(r => r.id === LI)!, plan.areas!)!
    expect(li.total).toBe(109)
    expect(li.listed).toBe(109)
    expect(li.done).toBe(1)
    expect(li.uncounted).toBe(39)
  })
})

describe('counter validation', () => {
  it('flags a checklist that drifts from its counter', () => {
    const d = structuredClone(dataset)
    d.areas!.find(a => a.id === 'overworld')!.entries.find(e => e.id === 'trainer-EVENT_BEAT_ROUTE_9_TRAINER_6')!.ruleIds.push(GR)
    expect(validateDataset(d, 'development')).toContainEqual(expect.objectContaining({ code: 'counter-mismatch', ruleId: GR }))
    expect(validateDataset(dataset, 'development')).toEqual([])
  })
})

const choices: BranchChoices = { starter: 'bulbasaur', eevee: 'vaporeon', dojo: 'hitmonlee', fossil: 'helix', moonstones: [31, 34] }
const at122 = [...brock, 1, 2, 3, ...mistyAdded, 31, 34, ...kogaAdded, 36, 40, 134, 106, ...erikaAdded, 138, 139, 144]
const fourBadges = 1 | 2 | 16 | 8 // Brock, Misty, Koga (Soul), Erika (Rainbow)
const SURGE = 4, SABRINA = 32, BLAINE = 64

describe('Badges V–VII are order-free after Erika and Articuno', () => {
  it.each([
    ['surge', fourBadges], ['surge', fourBadges | SABRINA], ['surge', fourBadges | BLAINE | SABRINA],
    ['sabrina', fourBadges], ['sabrina', fourBadges | BLAINE], ['blaine', fourBadges], ['blaine', fourBadges | SABRINA | SURGE],
  ] as const)('%s is ready with badges %i', (leader, badges) => {
    const r = evaluateOakCheckpoint(snapshot(at122, badges), leader, choices, dataset)
    expect(r.readiness, r.reasons.join(' ')).toBe('ready')
  })
  it('still requires Erika first and keeps Giovanni last', () => {
    expect(evaluateOakCheckpoint(snapshot(at122, 1 | 2 | 16), 'sabrina', choices, dataset).readiness).toBe('blocked')
    expect(evaluateOakCheckpoint(snapshot(at122, fourBadges | SURGE | SABRINA), 'giovanni', choices, dataset).readiness).toBe('blocked')
    expect(evaluateOakCheckpoint(snapshot(at122, fourBadges | SURGE | SABRINA | BLAINE), 'giovanni', choices, dataset).readiness).toBe('ready')
    expect(evaluateOakCheckpoint(snapshot(at122, fourBadges | 128), 'surge', choices, dataset).readiness).toBe('blocked')
  })
  it('does not route past an unbeaten Surge or Sabrina when Blaine was beaten first', () => {
    const project = createProject(), attempt = project.attempts[0]!
    attempt.branches = choices
    const s: SaveSnapshot = snapshot(at122, fourBadges | BLAINE)
    attempt.snapshot = s
    const input: PlanInput = { project, attempt, dataset }
    // Articuno's own achievement is unconfirmed without a mark or hardcore unlock, so home may stop there first.
    expect(['articuno', 'surge']).toContain(homeStage(input, planRun(input)))
    attempt.manualEvidence.push({ id: 'art', attemptId: attempt.id, continuityRevision: 0, status: 'active', key: 'rule:165731:completed', value: true, recordedAt: '2026-10-14T00:00:00Z' })
    expect(homeStage(input, planRun(input))).toBe('surge')
    attempt.snapshot = snapshot(at122, fourBadges | BLAINE | SURGE)
    expect(homeStage(input, planRun(input))).toBe('sabrina')
  })
  it('does not pass an unbeaten earlier leader after out-of-order badges', () => {
    const project = createProject(), attempt = project.attempts[0]!
    attempt.branches = choices
    attempt.snapshot = snapshot(at122, 1 | 2 | 16 | SURGE)
    const input: PlanInput = { project, attempt, dataset }
    expect(homeStage(input, planRun(input))).toBe('surf-cleanup') // the stage after Koga, before the gap at Erika
    attempt.snapshot = snapshot([...brock, 1, 2, 3], 1 | 16)
    attempt.snapshot.events = known({ EVENT_GOT_POKEBALLS_FROM_OAK: true })
    expect(homeStage(input, planRun(input))).toBe('moon') // Koga early does not skip the Misty phase
  })
  it('recommends Surge first in route order', () => {
    const ids = dataset.route.filter(s => s.checkpoint?.orderGroup).sort((a, b) => a.order - b.order).map(s => s.id)
    expect(ids).toEqual(['surge', 'sabrina', 'blaine'])
    for (const id of ['sabrina', 'cinnabar']) expect(dataset.route.find(s => s.id === id)!.afterStepIds).toEqual(['articuno'])
  })
})

describe('stored marks survive objective changes', () => {
  function stored(key: string) {
    const project = createProject(), attempt = project.attempts[0]!
    attempt.manualEvidence.push({ id: 'keep-me', attemptId: attempt.id, continuityRevision: 0, status: 'active', key, value: true, recordedAt: '2026-10-14T00:00:00.000Z' })
    return serializeProject(project)
  }
  it('keeps a retired mark and lists it as no longer used', () => {
    const restored = restoreProject(stored('glitch:cinnabar-access'))
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    const attempt = restored.project.attempts[0]!
    expect(attempt.manualEvidence.map(e => e.key)).toEqual(['glitch:cinnabar-access'])
    expect(retiredMarks(attempt).map(m => m.record.id)).toEqual(['keep-me'])
  })
  it('renames a migrated key in place without losing value or status', () => {
    keyMigrations.push({ key: 'test:old', replacement: 'test:new', reason: 'test' })
    try {
      const restored = restoreProject(stored('test:old'))
      expect(restored.ok && restored.project.attempts[0]!.manualEvidence[0]).toMatchObject({ id: 'keep-me', key: 'test:new', value: true, status: 'active' })
      if (restored.ok) expect(migrateEvidenceKeys(restored.project)).toBe(restored.project)
    } finally { keyMigrations.pop() }
  })
  it('leaves area marks untouched: checklist entry IDs did not change', () => {
    for (const id of ['story-EVENT_BEAT_CERULEAN_ROCKET_THIEF', 'trainer-EVENT_BEAT_ROUTE_9_TRAINER_6', 'hidden-18', 'trainer-EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD'])
      expect(entries.find(e => e.id === id)?.manualKey).toBe(`area:${id}`)
  })
})

describe('guide rulings in the planner', () => {
  function plan(s: SaveSnapshot, extra: (i: PlanInput) => void = () => {}) {
    const project = createProject('player'), attempt = project.attempts[0]!
    attempt.branches = { ...choices }
    attempt.snapshot = s
    const input: PlanInput = { project, attempt, dataset }
    extra(input)
    return planRun(input)
  }
  const ach = (p: ReturnType<typeof planRun>, id: number) => p.achievements.find(a => a.ruleId === id)!
  it('closes Parting Gift when Brock falls before Oak’s balls (ruling 26)', () => {
    const s = snapshot([1], 1); s.events = { known: true, value: { EVENT_GOT_POKEDEX: true, EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE: false, EVENT_GOT_POKEBALLS_FROM_OAK: false } }
    expect(ach(plan(s), 108023).readiness).toBe('missed')
  })
  it('keeps Parting Gift open when the Rival was beaten before Brock (pret OaksLab/PewterGym)', () => {
    const s = snapshot([1], 1); s.events = { known: true, value: { EVENT_GOT_POKEDEX: true, EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE: true, EVENT_GOT_POKEBALLS_FROM_OAK: false } }
    s.bag = known([])
    expect(ach(plan(s), 108023).readiness).not.toBe('missed')
  })
  it('records badge achievements from the leader’s defeat; they are not missable', () => {
    const s = snapshot([...brock, 1, 2, 3], 1); s.events = { known: true, value: { EVENT_BEAT_BROCK: true, EVENT_GOT_POKEBALLS_FROM_OAK: true } }
    const p = plan(s)
    expect(ach(p, 4401).readiness).toBe('ready')
    expect(dataset.rules.filter(r => r.id >= 4401 && r.id <= 4408).every(r => r.cutoffs.length === 0)).toBe(true)
  })
  it('marks a phase species unknown once its leader falls, unless the hardcore unlock is known', () => {
    const s = snapshot([...brock, 1, 2, 3], 1); s.events = { known: true, value: { EVENT_GOT_POKEBALLS_FROM_OAK: true } }
    expect(ach(plan(s), 165615).readiness).toBe('unknown')
    const earned = plan(s, i => { i.project.accountProgress = [{ setKey: 'oak', apiGameId: 16084, accountIdentity: 'player', lastSuccessfulFetchAt: '2026-10-14T00:00:00.000Z', stale: false, unlocks: [{ achievementId: 165615, earnedAt: '2026-10-14T00:00:00.000Z' }] }] })
    expect(ach(earned, 165615).readiness).not.toBe('unknown')
    expect(ach(earned, 165615).hardcoreEarned).toBe(true)
  })
  it('flags a static that was resolved without a catch', () => {
    const s = snapshot([], 255); s.events = { known: true, value: { EVENT_BEAT_ROUTE12_SNORLAX: true, EVENT_BEAT_ROUTE16_SNORLAX: true, EVENT_BEAT_ZAPDOS: true } }
    const p = plan(s)
    expect(ach(p, 4419).readiness).toBe('missed')
    expect(ach(p, 4420).readiness).toBe('missed')
  })
  it('advises a one-level margin at the cap without blocking (ruling 32)', () => {
    const s = snapshot(at122, fourBadges); s.party = known([pokemon(1, 24)])
    const r = evaluateOakCheckpoint(s, 'surge', choices, dataset)
    expect(r.readiness).toBe('ready')
    expect(r.reasons.join(' ')).toMatch(/23 or lower/)
  })
  it('asks for Moon Stone species one at a time (Moonstone I–IV, ruling 22)', () => {
    const mins = [165652, 165653, 165710, 165711].map(id => dataset.rules.find(r => r.id === id)!.branches.find(b => b.id === 'moon-stones')!.minimumDistinct)
    expect(mins).toEqual([1, 2, 3, 4])
  })
  it('treats more than 123 before Mewtwo as an unproven risk and fewer as not ready', () => {
    const over = ach(plan(snapshot([...at122, 146, 151], 255)), 165738)
    expect(over.reasons.join(' ')).toMatch(/exact 123.*unproven/)
    expect(ach(plan(snapshot(at122, 255)), 165738).readiness).toBe('blocked')
  })
  it('places the guide’s phase moves', () => {
    const step = (id: number) => dataset.rules.find(r => r.id === id)!.routeStepIds[0]
    expect(step(108028)).toBe('cut-cleanup')
    expect(step(108034)).toBe('league-target')
    expect(step(108183)).toBe('postgame')
    for (const id of [108052, 108053, 108141, 108054]) expect(step(id)).toBe('surf-cleanup')
    expect(dataset.rules.find(r => r.id === 108172)!.instructions.join(' ')).toMatch(/TM35/)
  })
})
