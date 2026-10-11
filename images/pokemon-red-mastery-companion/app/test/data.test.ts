import flagExpectations from './fixtures/flag-repair-source-expectations.json'
import visiblePickupOracle from './fixtures/visible-pickup-source-oracle.json'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataset } from '../src/data/manifest'
import { validateDataset } from '../src/data/validate'
import { canonicalAcquisitionIsEligible, selectCanonicalAcquisition } from '../src/data/acquisitions'
import type { CanonicalAcquisition, Dataset } from '../src/model'

// Mutations: dropping/inserting IDs, allowing unsafe release audits, or ignoring references.
function control(): Dataset {
  const rule = { ...dataset.rules[0]!, prerequisites: [], cutoffs: [], branches: [], preservation: [], routeStepIds: ['control'], auditStatus: 'validated' as const, validationEvidence: ['Independently checked control fixture'] }
  return { ...dataset, areas: [], manifest: { ...dataset.manifest, runtimePrerequisites: [] }, sets: [{ ...dataset.sets[0]!, expectedPublishedIds: [rule.id] }], rules: [rule], route: [{ id: 'control', order: 0, area: 'Test', title: 'Control', instructions: ['Prepare the control.'], ruleIds: [rule.id], prerequisites: [], preserves: [] }], glitches: [] }
}
const codes = (d: Dataset, mode: 'development' | 'release' = 'release') => validateDataset(d, mode)
describe('complete sourced inventory', () => {
  it('covers precisely the three current published sets', () => {
    const counts = Object.fromEntries(['main', 'oak', 'glitch'].map(k => [k, dataset.rules.filter(r => r.setKey === k).length]))
    expect(counts).toEqual({ main: 93, oak: 133, glitch: 8 })
    expect(new Set(dataset.rules.map(r => r.id)).size).toBe(234)
    expect(dataset.sets.map(s => s.apiGameId)).toEqual([724, 16084, 11632])
    expect(codes(dataset, 'development')).toEqual([])
  })
  it('rejects an extra published rule with its affected ID', () => {
    const d = control(); d.rules.push({ ...d.rules[0]!, id: 999999 }); d.route[0]!.ruleIds.push(999999)
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unpublished-rule', ruleId: 999999 }))
  })
  it('rejects a missing declared member with its affected ID', () => {
    const d = control(); const missing = d.rules[0]!.id; d.rules = []; d.route[0]!.ruleIds = []
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'missing-rule', ruleId: missing }))
  })
  it('accepts an otherwise valid validated control', () => expect(codes(control())).toEqual([]))
  it('blocks sourced rules in release only', () => {
    const d = control(); d.rules[0]!.auditStatus = 'sourced'
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unvalidated-rule', ruleId: d.rules[0]!.id }))
    expect(codes(d, 'development')).toEqual([])
  })
  it('identifies duplicate IDs', () => {
    const d = control(); d.rules.push({ ...d.rules[0]! })
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'duplicate-rule', ruleId: d.rules[0]!.id }))
  })
  it('identifies missing URLs independently', () => {
    const d = control(); d.rules[0]!.sourceUrls = []
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'missing-source', ruleId: d.rules[0]!.id }))
  })
  it('identifies unresolved route references', () => {
    const d = control(); d.rules[0]!.routeStepIds = ['absent']
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', ruleId: d.rules[0]!.id, reference: 'absent' }))
  })
  it('identifies invalid species references', () => {
    const d = control(); d.rules[0]!.prerequisites = [{ kind: 'owned', dexNumbers: [152] }]
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', ruleId: d.rules[0]!.id, reference: 'dex:152' }))
  })
  it('identifies a missing prerequisite branch group', () => {
    const d = control(); d.rules[0]!.prerequisites = [{ kind: 'branch-owned', groupId: 'missing-group' }]
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', ruleId: d.rules[0]!.id, reference: 'branch:missing-group' }))
  })
  it('identifies method references and missing sources', () => {
    const d = control(); const method = { ...dataset.glitches[0]!, ruleId: 999999, sourceUrls: [] }; d.glitches = [method]
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', methodId: method.id, reference: 'rule:999999' }))
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'missing-source', methodId: method.id }))
  })
  it('identifies sourced glitch methods independently', () => {
    const d = control(); d.glitches = [{ ...dataset.glitches[0]!, ruleId: d.rules[0]!.id, auditStatus: 'sourced' }]
    expect(codes(d)).toContainEqual(expect.objectContaining({ code: 'unvalidated-method', methodId: d.glitches[0]!.id }))
  })
  it('leaves full release explicitly gated', () => {
    const issues = codes(dataset)
    // 124 Oak species/group knowledge records have a pinned-source + fixture audit.
    // The 93 main, 8 glitch, 8 Oak gym and Oak Champion execution records remain open.
    expect(issues.filter(i => i.code === 'unvalidated-rule')).toHaveLength(110)
    expect(issues).toContainEqual(expect.objectContaining({code:'unvalidated-rule',ruleId:165627}))
    expect(issues).toContainEqual(expect.objectContaining({code:'unvalidated-rule',ruleId:165737}))
    expect(issues.filter(i => i.code === 'unvalidated-method')).toHaveLength(8)
  })
  it('extracts real national/internal IDs, red-only wild data, evolution and flags', () => {
    expect(dataset.game.species).toHaveLength(151)
    const bulba = dataset.game.species.find(s => s.dexNumber === 1)!
    expect(bulba.internalSpeciesId).toBe(153)
    expect(bulba.evolutions).toContainEqual(expect.objectContaining({ targetDex: 2, level: 16, method: 'level' }))
    const route24 = dataset.game.encounters.filter(e => e.area === 'Route24')
    expect(route24.some(e => e.dexNumber === 43)).toBe(true)
    expect(route24.some(e => e.dexNumber === 69)).toBe(false)
    expect(dataset.game.eventFlags['EVENT_GOT_POKEDEX']).toBe(37)
    expect(dataset.game.trades).toHaveLength(9)
    expect(dataset.game.encounters.some(e => e.method === 'super-rod' && e.dexNumber === 147)).toBe(true)
  })
  it('extracts all eleven accessible optional Safari objects without progression items', () => {
    const pickups = dataset.game.pickups.filter(p => p.area.startsWith('SAFARI_ZONE_') && !p.inaccessible && p.rawItemId !== 64)
    expect(pickups).toHaveLength(11)
    expect(pickups.filter(p => p.kind === 'hidden')).toEqual([expect.objectContaining({ area: 'SAFARI_ZONE_WEST', x: 6, y: 5, rawItemId: 53 })])
    expect(dataset.game.objectFlags['TOGGLE_SAFARI_ZONE_WEST_ITEM_1']).toBeTypeOf('number')
  })
  it('gives every published rule actionable placement and evidence', () => {
    for (const r of dataset.rules) {
      expect(r.instructions.length, String(r.id)).toBeGreaterThan(0)
      expect(r.routeStepIds.length, String(r.id)).toBeGreaterThan(0)
      expect(r.evidence.length, String(r.id)).toBeGreaterThan(0)
    }
  })
})

// Mutations: removing phase gates, preferring inaccessible trades/water, or losing gift history.
describe('canonical acquisition audit', () => {
  it.each([
    [165623, 29, 'grass', 'Route22', 3],
    [165658, 54, 'super-rod', 'CERULEAN_CITY', 15],
    [165665, 72, 'super-rod', 'ROUTE_12', 5],
    [165667, 79, 'super-rod', 'CELADON_CITY', 15],
    [165671, 90, 'super-rod', 'VERMILION_CITY', 15],
    [165690, 116, 'super-rod', 'ROUTE_19', 15],
    [165694, 120, 'super-rod', 'ROUTE_19', 15],
  ])('selects a reachable source for Oak rule %i', (id, targetDex, method, area, level) => {
    const rule = dataset.rules.find(r => r.id === id)!
    const expected = expect.objectContaining({ targetDex, method, area, level })
    expect(rule.acquisitions).toEqual([expected])
    expect(selectCanonicalAcquisition(dataset.game, targetDex, id < 165627 ? 'brock' : 'koga')).toEqual(expected)
  })
  it('buys the required Mt. Moon Magikarp instead of substituting fishing history', () => {
    const rule = dataset.rules.find(r => r.id === 165644)!
    expect(rule.acquisitions).toEqual([expect.objectContaining({ targetDex: 129, method: 'purchase', area: 'Route4', historyRuleIds: [108052] })])
    expect(selectCanonicalAcquisition(dataset.game, 129, 'misty')).toEqual(expect.objectContaining({ method: 'purchase', area: 'Route4', historyRuleIds: [108052] }))
    expect(selectCanonicalAcquisition(dataset.game, 129, 'brock')).toBeNull()
    expect(rule.sourceUrls).toContain('https://github.com/pret/pokered/blob/af519899719f0754965776faac0e836a3b906e6d/scripts/MtMoonPokecenter.asm')
  })
  it('includes every single/alternative Oak acquisition in a structured phase audit', () => {
    const omitted = [165627,165654,165713,165730,165732,165733,165734,165735,165737]
    const audited = dataset.rules.filter(r => r.setKey === 'oak' && !omitted.includes(r.id))
    expect(audited).toHaveLength(124)
    function checkSource(path: CanonicalAcquisition): void {
      expect(canonicalAcquisitionIsEligible(path), `Inaccessible Dex ${path.targetDex}`).toBe(true)
      if (path.method === 'level' || path.method === 'item') {
        expect(dataset.game.species.find(s => s.dexNumber === path.sourceDex)?.evolutions).toContainEqual(expect.objectContaining({ targetDex: path.targetDex, method: path.method }))
      } else if (path.method === 'trade') {
        expect(dataset.game.trades).toContainEqual(expect.objectContaining({ giveDex: path.sourceDex, receiveDex: path.targetDex, area: path.area, sourceUrl: path.sourceUrl }))
      } else {
        expect(dataset.game.encounters).toContainEqual(expect.objectContaining({ dexNumber: path.targetDex, method: path.method, area: path.area, level: path.level, sourceUrl: path.sourceUrl }))
      }
      path.dependencies.forEach(checkSource)
    }
    for (const rule of audited) {
      expect(rule.acquisitions?.length, `Missing audit for ${rule.id}`).toBeGreaterThan(0)
      const phase = rule.id < 165627 ? 'brock' : rule.id < 165654 ? 'misty' : rule.id < 165713 ? 'koga' : rule.id < 165730 ? 'erika' : rule.id === 165731 ? 'surge' : rule.id === 165736 ? 'league' : 'postgame'
      for (const path of rule.acquisitions!) { expect(path.phase, String(rule.id)).toBe(phase); checkSource(path) }
    }
    expect(validateDataset(dataset, 'development')).toEqual([])
  })
  it('rejects a factual but phase-inaccessible acquisition independently of prose', () => {
    const d = control(); d.rules[0]!.acquisitions = [{ targetDex: 72, phase: 'koga', method: 'surf', area: 'Route21', level: 5, sourceUrl: dataset.game.encounters.find(e => e.dexNumber === 72 && e.area === 'Route21')!.sourceUrl, dependencies: [], requiredMilestones: ['surf'], historyRuleIds: [] }]
    expect(codes(d, 'development')).toContainEqual(expect.objectContaining({ code: 'inaccessible-acquisition', ruleId: d.rules[0]!.id }))
  })
  it('preserves complete objective summaries containing Mt. Moon', () => {
    for (const id of [108025,108052,165728]) expect(dataset.rules.find(r => r.id === id)!.objective).not.toMatch(/Mt\.$/)
  })
})
const factualSource = process.env.POKERED_SOURCE ?? '/tmp/pokemon-red-source'
it.skipIf(!existsSync(join(factualSource, '.git')))('links acquisition sources that exist at the pinned commit and actually give the two early gifts', () => {
  expect(execFileSync('git',['-C',factualSource,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe('af519899719f0754965776faac0e836a3b906e6d')
  const visit = (path: CanonicalAcquisition) => {
    const file = path.sourceUrl.split('/af519899719f0754965776faac0e836a3b906e6d/')[1]!
    expect(existsSync(join(factualSource,file)),file).toBe(true)
    path.dependencies.forEach(visit)
  }
  dataset.rules.filter(r=>r.setKey==='oak').flatMap(r=>r.acquisitions ?? []).forEach(visit)
  for (const [dex, symbol, level] of [[129,'MAGIKARP',5],[133,'EEVEE',25]] as const) {
    const encounter=dataset.game.encounters.find(e=>e.dexNumber===dex && ['gift','purchase'].includes(e.method) && e.area!=='Celadon Game Corner')!
    const file=encounter.sourceUrl.split('/af519899719f0754965776faac0e836a3b906e6d/')[1]!
    expect(readFileSync(join(factualSource,file),'utf8')).toMatch(new RegExp(`lb bc, ${symbol}, ${level}\\s+call GivePokemon`))
  }
})
it.skipIf(!existsSync(join(factualSource, '.git')))('rejects modified source content at the pinned HEAD before writing output', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'red-extractor-dirty-'))
  try {
    const source = join(temporary, 'source'); const output = join(temporary, 'facts.json')
    execFileSync('git', ['clone', '--quiet', '--shared', factualSource, source])
    appendFileSync(join(source, 'constants/pokemon_constants.asm'), '\n; deliberately dirty source fixture\n')
    const result = spawnSync(process.execPath, ['scripts/extract-pokered.ts', source, output], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/dirty source tree/i)
    expect(existsSync(output)).toBe(false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

// Expectations independently audited from pinned ASM, not derived by the extractor under test.
describe('source-ordinal extraction repairs', () => {
  it('matches all 104 independently audited visible pickup/source/toggle tuples', () => {
    const visible = dataset.game.pickups.filter(p => p.kind === 'visible')
    expect(visible).toHaveLength(104)
    expect(visiblePickupOracle).toHaveLength(104)
    expect(new Set(visiblePickupOracle.map(p => p.objectFlag)).size).toBe(104)
    for (const expected of visiblePickupOracle) {
      const matches = visible.filter(p => p.area === expected.area && p.x === expected.x && p.y === expected.y)
      expect(matches, `${expected.sourceFile}:${expected.sourceLine}`).toHaveLength(1)
      expect(matches[0]).toMatchObject({ rawItemId: expected.rawItemId, objectFlag: expected.objectFlag, sourceUrl: `https://github.com/pret/pokered/blob/${flagExpectations.sourceCommit}/${expected.sourceFile}` })
      expect(dataset.game.itemIds[expected.itemSymbol]).toBe(expected.rawItemId)
      expect(dataset.game.objectFlags[expected.objectFlag]).toBe(expected.objectFlagIndex)
    }
  })
  it.each(flagExpectations.events)('reads the exact source event index for $symbol', ({ symbol, index }) => {
    expect(dataset.game.eventFlags[symbol]).toBe(index)
  })
  it.each(flagExpectations.pickups)('preserves the toggle ordinal for $area ($x,$y)', ({ area, x, y, flag, index }) => {
    const pickup = dataset.game.pickups.find(p => p.kind === 'visible' && p.area === area && p.x === x && p.y === y)!
    expect(pickup.objectFlag).toBe(flag)
    expect(dataset.game.objectFlags[flag]).toBe(index)
  })
})

it.skipIf(!existsSync(join(factualSource, '.git')))('preserves unused hidden ordinals while excluding their pickups from obtainable game facts', () => {
  const temporary=mkdtempSync(join(tmpdir(),'red-hidden-access-'))
  try {
    const output=join(temporary,'facts.json')
    execFileSync(process.execPath,['scripts/extract-pokered.ts',factualSource,output])
    const generated=JSON.parse(readFileSync(output,'utf8')) as Dataset['game']
    for(const facts of [generated,dataset.game]) {
      const hidden=facts.pickups.filter(p=>p.kind==='hidden')
      expect(hidden).toHaveLength(54)
      expect(hidden.find(p=>p.hiddenFlagIndex===34)).toMatchObject({area:'UNUSED_MAP_6F',x:14,y:11,inaccessible:true})
      expect(hidden.find(p=>p.hiddenFlagIndex===16)).toMatchObject({area:'SAFARI_ZONE_GATE',inaccessible:true})
      expect(hidden.find(p=>p.hiddenFlagIndex===35)).toMatchObject({area:'VIRIDIAN_CITY',x:14,y:4,inaccessible:false})
      expect(hidden.filter(p=>!p.inaccessible)).toHaveLength(52)
    }
  } finally {rmSync(temporary,{recursive:true,force:true})}
})
