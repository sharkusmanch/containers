/** Regenerate audited acquisition selections and their original instructions; factual data is untouched. */
import { readFileSync, writeFileSync } from 'node:fs'
import { selectCanonicalAcquisition, canonicalPhaseForStep } from '../src/data/acquisitions.ts'
import type { AchievementRule, CanonicalAcquisition, GameData } from '../src/model.ts'
const game: GameData = JSON.parse(readFileSync('src/data/pokered.generated.json', 'utf8'))
const rules: AchievementRule[] = JSON.parse(readFileSync('src/data/rules.curated.json', 'utf8'))
const skip = new Set([165627,165654,165713,165730,165732,165733,165734,165735,165737])
const name = (dex: number) => game.species.find(s => s.dexNumber === dex)!.name
const itemName = (id: number) => Object.keys(game.itemIds).find(k => game.itemIds[k] === id)!.replaceAll('_', ' ').toLowerCase()
function sources(path: CanonicalAcquisition): string[] { return [path.sourceUrl, ...path.dependencies.flatMap(sources)] }
function instruction(path: CanonicalAcquisition): string {
  if (path.method === 'level') return `Register ${name(path.sourceDex!)}, then train a held instance to level ${path.level} and evolve it into ${name(path.targetDex)}. Box over-cap grinders before entering the gym.`
  if (path.method === 'item') return `Register ${name(path.sourceDex!)}, then use a ${itemName(path.rawItemId!)} to obtain ${name(path.targetDex)}. Obtain the stone during this phase and retain any separately required trade donor.`
  if (path.method === 'trade') return `Register ${name(path.sourceDex!)} and retain a donor instance, then exchange it for ${name(path.targetDex)} at ${path.area}. Register and preserve each required donor before its exchange; record the particular NPC trade.`
  if (path.targetDex === 129) return 'Buy the level-5 Magikarp from the seller in the Route 4 Pokémon Center beside Mt. Moon. This particular purchase is required for the six-gift objective; fishing a Magikarp does not substitute for its acquisition history.'
  const rod = path.method === 'super-rod' ? 'Obtain the Super Rod from the Route 12 fishing house first. ' : path.method === 'good-rod' ? 'Obtain the Good Rod in Fuchsia first. ' : ''
  const leader = ({ brock: 'Brock', misty: 'Misty', koga: 'Koga', erika: 'Erika', surge: 'Lt. Surge', league: 'League', postgame: 'postgame' })[path.phase]
  const deferral = path.area?.toLowerCase().replaceAll('_','').startsWith('safarizone') ? ' Leave optional Safari pickups untouched until the later sweep.' : ''
  return `${rod}Obtain ${name(path.targetDex)} at ${path.executionArea ?? path.area} by ${path.method.replaceAll('-', ' ')} (source level ${path.level}) before the ${leader} checkpoint. Verify its registered Dex entry.${deferral}`
}
for (const rule of rules) {
  if (rule.setKey !== 'oak' || skip.has(rule.id)) continue
  const phase = canonicalPhaseForStep(rule.routeStepIds[0]!)
  if (!phase) throw new Error(`Unmapped acquisition phase for ${rule.id}`)
  const targets = rule.id === 165738 ? [150] : rule.branches.length ? [...new Set(rule.branches.flatMap(g => g.options.flatMap(o => o.dexNumbers)))] : rule.prerequisites.flatMap(p => p.kind === 'owned' ? p.dexNumbers : [])
  if (!targets.length) throw new Error(`No acquisition targets for ${rule.id}`)
  rule.acquisitions = targets.map(target => {
    const selection = selectCanonicalAcquisition(game, target, phase)
    if (!selection) throw new Error(`No eligible path for ${rule.id} Dex ${target} before ${phase}`)
    return selection
  })
  rule.sourceUrls = [...new Set([`https://retroachievements.org/achievement/${rule.id}`, 'https://github.com/RetroAchievements/guides/wiki/Pokemon-Red-Version-%28Game-Boy%29', ...rule.acquisitions.flatMap(sources)])]
  // Keep branch/session narrative; replace all fixed-species guidance from audited selections.
  if (!rule.branches.length && rule.id !== 165738) {
    rule.instructions = rule.acquisitions.map(instruction)
    rule.objective = `Register ${name(targets[0]!)} through a source accessible before the ${phase} checkpoint.`
  }
}
const summaries: Record<number,string> = { 108025: 'Collect Mt. Moon’s pickups, defeat its trainers, and choose one fossil.', 108052: 'Receive all six particular gift Pokémon, including the purchased Mt. Moon Magikarp.', 165728: 'Revive the selected Mt. Moon fossil at Cinnabar before Erika.' }
for (const rule of rules) if (summaries[rule.id]) rule.objective = summaries[rule.id]!
writeFileSync('src/data/rules.curated.json', JSON.stringify(rules, null, 2) + '\n')
console.log(`Audited all ${rules.filter(r => r.acquisitions?.length).length} Oak acquisition rules, including every branch alternative.`)
