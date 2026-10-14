import type { AcquisitionMilestone, CanonicalAcquisition, CanonicalPhase, Encounter, GameData } from '../model'

const phases: CanonicalPhase[] = ['brock', 'misty', 'koga', 'erika', 'surge', 'league', 'postgame']
const milestonePhase: Record<AcquisitionMilestone, CanonicalPhase> = {
  'old-rod': 'misty', 'good-rod': 'koga', 'super-rod': 'koga', surf: 'erika', strength: 'surge',
  'moon-stone': 'misty', 'celadon-stones': 'koga',
}
export function canonicalPhaseForStep(stepId: string): CanonicalPhase | null {
  const mapping: Record<string, CanonicalPhase> = { brock: 'brock', moon: 'misty', 'misty-prep': 'misty', misty: 'misty', 'cut-cleanup': 'koga', celadon: 'koga', tower: 'koga', 'safari-prep': 'koga', 'silph-clear': 'koga', koga: 'koga', 'surf-cleanup': 'erika', erika: 'erika', articuno: 'surge', surge: 'surge', sabrina: 'surge', blaine: 'surge', giovanni: 'surge', victory: 'league', league50: 'league', postgame: 'postgame' }
  return mapping[stepId] ?? null
}
const normalizeArea = (area: string) => area.toLowerCase().replace(/[ _]/g, '')
/** Conservative canonical access, separate from factual encounter availability. Unknown areas are excluded. */
export function earliestAreaPhase(area: string): CanonicalPhase | null {
  const key = normalizeArea(area)
  const route = key.match(/^route(\d+)$/)
  if (route) {
    const n = Number(route[1])
    if ([1, 2, 22].includes(n)) return 'brock'
    if ([3, 4, 5, 6, 11, 24, 25].includes(n)) return 'misty'
    if ([7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19].includes(n)) return 'koga'
    if ([20, 21].includes(n)) return 'erika'
    if (n === 23) return 'league'
  }
  if (['oakslab', 'pallettown', 'viridiancity', 'viridianforest'].includes(key)) return 'brock'
  if (/^mtmoon(1f|b1f|b2f)$/.test(key) || ['diglettscave', 'ceruleancity', 'ceruleangym', 'vermilioncity', 'vermiliondock', 'fishablewater', 'route2tradehouse', 'route11gate2f', 'vermiliontradehouse', 'ceruleantradehouse', 'undergroundpathroute5'].includes(key)) return 'misty'
  if (/^rocktunnel(1f|b1f)$/.test(key) || /^pokemontower[3-7]f$/.test(key) || /^safarizone(center|east|north|west)$/.test(key) || ['celadoncity', 'celadonmansionroof', 'celadongamecorner', 'fuchsiacity', 'silphco7f', 'fightingdojo', 'route18gate2f'].includes(key)) return 'koga'
  if (/^pokemonmansion(1f|2f|3f|b1f)$/.test(key) || ['cinnabarisland', 'cinnabarlab', 'cinnabarlabfossilroom', 'cinnabarlabtraderoom', 'powerplant', 'searoutes'].includes(key)) return 'erika'
  // Strength-dependent Seafoam routing stays deferred until Erika has been defeated.
  if (/^seafoamislands(1f|b[1-4]f)$/.test(key)) return 'surge'
  if (/^victoryroad[1-3]f$/.test(key)) return 'league'
  if (/^ceruleancave(1f|2f|b1f)$/.test(key)) return 'postgame'
  return null
}
function areaMilestones(area: string): AcquisitionMilestone[] {
  const key = normalizeArea(area)
  if (/^seafoamislands/.test(key)) return ['surf', 'strength']
  if (/^victoryroad/.test(key)) return ['strength']
  if (/^(cinnabar|pokemonmansion)/.test(key) || ['powerplant', 'route20', 'route21', 'searoutes'].includes(key)) return ['surf']
  return []
}
function available(required: CanonicalPhase, phase: CanonicalPhase) { return phases.indexOf(required) <= phases.indexOf(phase) }
function methodMilestones(method: CanonicalAcquisition['method'], item?: number): AcquisitionMilestone[] {
  if (method === 'surf') return ['surf']
  if (method === 'old-rod' || method === 'good-rod' || method === 'super-rod') return [method]
  if (method === 'item') return item === 10 ? ['moon-stone'] : ['celadon-stones']
  return []
}
/** Effective method/travel gates shared by phase eligibility and observed runtime prerequisites. */
export function canonicalAcquisitionMilestones(path: CanonicalAcquisition): AcquisitionMilestone[] {
  const area = path.executionArea ?? path.area
  return [...new Set([...methodMilestones(path.method, path.rawItemId), ...area ? areaMilestones(area) : [], ...path.requiredMilestones])]
}
/** Recheck stored selections, including recursive evolution/trade dependencies and method gates. */
export function canonicalAcquisitionIsEligible(path: CanonicalAcquisition, phase = path.phase): boolean {
  if (!available(path.phase, phase)) return false
  if (path.area) {
    if (normalizeArea(path.area) === 'fishablewater' && !path.executionArea) return false
    const earliest = earliestAreaPhase(path.executionArea ?? path.area)
    if (!earliest || !available(earliest, phase)) return false
  } else if (path.method !== 'level' && path.method !== 'item') return false
  if (canonicalAcquisitionMilestones(path).some(m => !available(milestonePhase[m], phase))) return false
  return path.dependencies.every(dependency => canonicalAcquisitionIsEligible(dependency, phase))
}
// Guide-preferred spots (2026-10-14 alignment): best rate or easiest source within the phase.
const preferredArea: Record<number, string> = { 13: 'ViridianForest', 29: 'Route22', 35: 'MtMoonB2F', 46: 'MtMoonB2F', 54: 'CERULEAN_CITY', 72: 'ROUTE_12', 74: 'MtMoonB2F', 79: 'CELADON_CITY', 90: 'VERMILION_CITY', 113: 'SafariZoneNorth', 116: 'ROUTE_19', 120: 'ROUTE_19', 147: 'Celadon Game Corner' }
/** A dependency (evolution source or trade donor) uses its earliest executable phase. */
function earliestDependency(game: GameData, dex: number, phase: CanonicalPhase, visiting: number[]): CanonicalAcquisition | null {
  for (const candidate of phases.slice(0, phases.indexOf(phase) + 1)) {
    const found = selectCanonicalAcquisition(game, dex, candidate, visiting)
    if (found) return found
  }
  return null
}
/** Choose only executable canonical paths. Historical gifts outrank equivalent Dex-only methods. */
export function selectCanonicalAcquisition(game: GameData, targetDex: number, phase: CanonicalPhase, visiting: number[] = []): CanonicalAcquisition | null {
  if (visiting.includes(targetDex)) return null
  const ancestors = [...visiting, targetDex]
  const path = (fields: Partial<CanonicalAcquisition> & Pick<CanonicalAcquisition, 'method' | 'sourceUrl'>): CanonicalAcquisition => ({ targetDex, phase, dependencies: [], requiredMilestones: [], historyRuleIds: [], ...fields })
  // The purchased Mt. Moon Magikarp is one of six specific gift events (108052).
  if (targetDex === 129) {
    const e = game.encounters.find(e => e.dexNumber === 129 && e.method === 'purchase' && e.area === 'Route4')
    if (!e) return null
    const p = path({ method: e.method, area: e.area, level: e.level, sourceUrl: e.sourceUrl, historyRuleIds: [108052] })
    return canonicalAcquisitionIsEligible(p) ? p : null
  }
  for (const source of game.species) for (const evolution of source.evolutions) {
    if (evolution.targetDex !== targetDex || evolution.method === 'trade') continue
    const dependency = earliestDependency(game, source.dexNumber, phase, ancestors)
    if (!dependency) continue
    const p = path({ method: evolution.method, level: evolution.level, rawItemId: evolution.rawItemId, sourceDex: source.dexNumber, sourceUrl: source.sourceUrls.find(s => s.endsWith('evos_moves.asm'))!, dependencies: [dependency], requiredMilestones: methodMilestones(evolution.method, evolution.rawItemId) })
    if (canonicalAcquisitionIsEligible(p)) return p
  }
  for (const trade of game.trades.filter(t => t.receiveDex === targetDex)) {
    const dependency = earliestDependency(game, trade.giveDex, phase, ancestors)
    if (!dependency) continue
    const p = path({ method: 'trade', area: trade.area, sourceDex: trade.giveDex, sourceUrl: trade.sourceUrl, dependencies: [dependency], historyRuleIds: [108053] })
    if (canonicalAcquisitionIsEligible(p)) return p
  }
  const candidates = game.encounters.filter(e => e.dexNumber === targetDex)
  const rank = (e: Encounter) => (e.area === preferredArea[targetDex] ? -1000 : 0) + (e.method === 'purchase' ? 100 : 0) + e.level
  for (const e of candidates.sort((a, b) => rank(a) - rank(b))) {
    const p = path({ method: e.method, area: e.area, ...(normalizeArea(e.area) === 'fishablewater' ? { executionArea: e.method === 'good-rod' ? 'FUCHSIA_CITY' : 'VERMILION_CITY' } : {}), level: e.level, sourceUrl: e.sourceUrl, requiredMilestones: [...methodMilestones(e.method), ...areaMilestones(e.area)] })
    if (canonicalAcquisitionIsEligible(p)) return p
  }
  return null
}
