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
const leaderName: Record<string, string> = { brock: 'Brock', misty: 'Misty', koga: 'Koga', erika: 'Erika', surge: 'the first of Lt. Surge, Sabrina and Blaine', league: 'the first League clear', postgame: 'the postgame' }
// Guide notes appended per species (2026-10-14 guide alignment): spares, release rules and special access.
const extra: Record<number, string> = {
  32: ' Catch two more Nidoran♂ as trade spares: one for the SPOT trade (Nidoran♀) and one to raise into Nidorino for the TERRY trade (Nidorina).',
  21: ' Catch a second Spearow for the Farfetch’d trade in Vermilion.',
  63: ' Catch three Abra: one for the Mr. Mime trade and two to raise as Kadabra (one reaches Psychic at Lv38 for Koga, one is held at Lv27–28 with Psybeam for Erika). It teleports on turn one, so throw at once.',
  50: ' Catch a spare Diglett and keep it at Lv23 or lower, unevolved: it learns Dig at Lv19 and carries the Surge battle.',
  48: ' Catch a second Venonat for the Tangela trade in the Cinnabar Lab.',
  58: ' Catch a spare Growlithe, keep it at Lv28 or lower and give it a Fire Stone for an Erika B-team Arcanine.',
  77: ' Catch a second Ponyta for the Seel trade.',
  92: ' Catch it on Tower 3F–5F with the Silph Scope in the bag, then deposit the Scope before the 6F ghost.',
  104: ' Catch it on Tower 3F–5F with the Silph Scope in the bag, then deposit the Scope before the 6F ghost.',
  133: ' It is the only Eevee: never release it before its stone evolution registers.',
  142: ' Revive the Old Amber (Pewter Museum back entrance, needs Cut) at the Cinnabar Lab; reach Cinnabar by Surfing south from Pallet Town (Route 21).',
  143: ' Wake it with the Poké Flute (Route 12 or Route 16).',
  147: ' The Game Corner prize is the easiest Dratini; a Super Rod in the Safari Zone works too.',
}
function instruction(path: CanonicalAcquisition): string {
  const leader = leaderName[path.phase]
  const add = extra[path.targetDex] ?? ''
  if (path.method === 'level') return `Register ${name(path.sourceDex!)}, then train a held instance to level ${path.level} and evolve it into ${name(path.targetDex)}. Box over-cap grinders before entering the gym.${add}`
  if (path.method === 'item') return `Register ${name(path.sourceDex!)}, then use a ${itemName(path.rawItemId!)} to obtain ${name(path.targetDex)}. Obtain the stone during this phase and retain any separately required trade donor.${add}`
  if (path.method === 'trade') return `Register ${name(path.sourceDex!)} and retain a donor instance, then exchange it for ${name(path.targetDex)} at ${path.area}. Register and preserve each required donor before its exchange; record the particular NPC trade.${add}`
  if (path.targetDex === 129) return 'Buy the level-5 Magikarp from the seller in the Route 4 Pokémon Center beside Mt. Moon. This particular purchase is required for the six-gift objective; fishing a Magikarp does not substitute for its acquisition history.'
  const rod = path.method === 'super-rod' ? 'Obtain the Super Rod from the Route 12 fishing house first. ' : path.method === 'good-rod' ? 'Obtain the Good Rod in Fuchsia first. ' : ''
  const deferral = path.area?.toLowerCase().replaceAll('_','').startsWith('safarizone') ? ' Leave optional Safari pickups untouched until the later sweep.' : ''
  const statics = path.method === 'static' ? ' Save in front of it; never run from it and never knock it out.' : ''
  return `${rod}Obtain ${name(path.targetDex)} at ${path.executionArea ?? path.area} by ${path.method.replaceAll('-', ' ')} (source level ${path.level}) before ${leader}. Verify its registered Dex entry.${deferral}${statics}${add}`
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
    rule.objective = `Register ${name(targets[0]!)} before ${leaderName[phase]}.`
  }
}
const summaries: Record<number,string> = { 108025: 'Collect Mt. Moon’s pickups, defeat its trainers, and choose one fossil.', 108052: 'Receive all six particular gift Pokémon, including the purchased Mt. Moon Magikarp.', 165728: 'Revive the selected Mt. Moon fossil at Cinnabar before Erika.' }
for (const rule of rules) if (summaries[rule.id]) rule.objective = summaries[rule.id]!
writeFileSync('src/data/rules.curated.json', JSON.stringify(rules, null, 2) + '\n')
console.log(`Audited all ${rules.filter(r => r.acquisitions?.length).length} Oak acquisition rules, including every branch alternative.`)
