import type { AcquisitionPath, AcquisitionPlan, CanonicalAcquisition, CanonicalPhase, Dataset, PokemonObservation, Readiness, SaveSnapshot } from '../model'
import { canonicalAcquisitionIsEligible, canonicalAcquisitionMilestones, selectCanonicalAcquisition } from '../data/acquisitions'

/** Infer only the observed current canonical phase, never from historical attempt metadata. */
function currentPhase(snapshot: SaveSnapshot | null): CanonicalPhase | null {
  if (!snapshot?.badgeMask.known) return null
  const b = snapshot.badgeMask.value
  if (!(b & 1)) return 'brock'
  if (!(b & 2)) return 'misty'
  if (!(b & 16)) return 'koga'
  if (!(b & 8)) return 'erika'
  if (b !== 255) return 'surge'
  // HallOfFame.asm clears the Champion event. The blocker toggle establishes current Cave access.
  if (snapshot.hallOfFame.known && snapshot.hallOfFame.value) return 'postgame'
  if (!snapshot.objectFlags?.known || snapshot.objectFlags.value.TOGGLE_CERULEAN_CAVE_GUY === undefined) return null
  return snapshot.objectFlags.value.TOGGLE_CERULEAN_CAVE_GUY ? 'postgame' : 'league'
}
const tradeIndices: Record<number, number> = { 30:0, 122:1, 86:3, 83:4, 108:5, 124:6, 101:7, 114:8, 29:9 }

/** One explainable canonical path per target, in caller order; no grinding-optimality claim. */
export function planAcquisitions(snapshot: SaveSnapshot | null, target: number[], dataset: Dataset): AcquisitionPlan {
  const plan: AcquisitionPlan = { targets: [], alreadyRegistered: [], missingResources: [], diagnostics: [] }
  const phase = currentPhase(snapshot)
  const held: PokemonObservation[] = []
  let storageUnknown = !snapshot
  if (snapshot) {
    for (const [section,fact] of [['party',snapshot.party],['currentBox',snapshot.currentBox],['archivedBoxes',snapshot.archivedBoxes],['daycare',snapshot.daycare]] as const) {
      if (!fact.known) { storageUnknown = true; plan.diagnostics.push(`${section}: ${fact.reason}`) }
    }
    if (snapshot.party.known) held.push(...snapshot.party.value)
    if (snapshot.currentBox.known) held.push(...snapshot.currentBox.value.pokemon)
    if (snapshot.archivedBoxes.known) for (const box of snapshot.archivedBoxes.value) {
      if (!snapshot.currentBox.known || box.index !== snapshot.currentBox.value.index) held.push(...box.pokemon)
    }
    if (snapshot.daycare.known && snapshot.daycare.value) held.push(snapshot.daycare.value)
    if (held.some(p => p.dexNumber === null)) { storageUnknown = true; plan.diagnostics.push('A held Pokémon species is unreadable; missing instances remain unknown.') }
  }
  if (!phase) plan.diagnostics.push(snapshot && !snapshot.badgeMask.known ? snapshot.badgeMask.reason : 'Canonical phase cannot be established; observe progression and current Cave access.')
  const quantities = new Map<number,number>()
  let itemsUnknown = !snapshot
  if (snapshot) for (const fact of [snapshot.bag,snapshot.pcItems]) {
    if (!fact.known) { itemsUnknown = true; plan.diagnostics.push(fact.reason) }
    else for (const item of fact.value) quantities.set(item.rawItemId,(quantities.get(item.rawItemId) ?? 0)+item.quantity)
  }
  const consumed = new Set<PokemonObservation>()
  // Evolution consumes the old-species donor but retains its observed field moves and ownership.
  const tradedAway = new Set<PokemonObservation>()
  const name = (dex: number) => dataset.game.species.find(s => s.dexNumber === dex)?.name ?? `Dex #${dex}`
  const itemName = (id: number) => (Object.entries(dataset.game.itemIds).find(([key,value]) => value === id && !key.startsWith('ITEM_'))?.[0] ?? `item #${id}`).toLowerCase().replace(/(^|_)(\w)/g,(_,sep:string,c:string) => `${sep ? ' ' : ''}${c.toUpperCase()}`)
  const instructions = (path: CanonicalAcquisition): string[] => {
    if (held.some(p => p.dexNumber === path.targetDex && !consumed.has(p))) return []
    const dependency = path.dependencies.flatMap(instructions)
    const area = path.executionArea ?? path.area
    if (path.method === 'level') return [...dependency,`Register ${name(path.sourceDex!)} first, then train a held instance to level ${path.level} (or its next level if already above that) and evolve into ${name(path.targetDex)}. Retrieve daycare Pokémon first; box over-cap grinders before gyms.`]
    if (path.method === 'item') return [...dependency,`Use one ${itemName(path.rawItemId!)} on a held ${name(path.sourceDex!)} to obtain ${name(path.targetDex)}. Register the donor first.`]
    if (path.method === 'trade') return [...dependency,`Register and retain a held ${name(path.sourceDex!)}; exchange it for ${name(path.targetDex)} at ${area}. This consumes that donor and this NPC trade is one-time.`]
    const action = path.method === 'gift' ? 'Receive' : path.method === 'purchase' ? 'Purchase' : 'Catch'
    return [...dependency,`${action} ${name(path.targetDex)} at ${area} (${path.method}, level ${path.level}).`, ...path.historyRuleIds.map(id => `Preserve method-specific history for achievement ${id}; Dex registration alone does not prove that history.`)]
  }
  for (const dexNumber of new Set(target)) {
    const registered = snapshot?.ownedDex.known ? { known:true as const,value:snapshot.ownedDex.value.includes(dexNumber) }
      : { known:false as const,reason:snapshot && !snapshot.ownedDex.known ? snapshot.ownedDex.reason : 'Dex unavailable until a supported save is imported.' }
    if (registered.known && registered.value) plan.alreadyRegistered.push(dexNumber)
    const entry = { dexNumber, registered, heldInstances: held.filter(p => p.dexNumber === dexNumber), paths: [] as AcquisitionPath[], missingResources: [] as string[] }
    plan.targets.push(entry)
    if (registered.known && registered.value && entry.heldInstances.length) continue
    const roots = dataset.rules.filter(r => r.setKey === 'oak').flatMap(r => r.acquisitions ?? []).filter(p => p.targetDex === dexNumber)
    const selected = phase ? roots.find(p => canonicalAcquisitionIsEligible(p,phase)) ?? selectCanonicalAcquisition(dataset.game,dexNumber,phase)
      : roots[0] ?? selectCanonicalAcquisition(dataset.game,dexNumber,'postgame')
    if (!selected) {
      entry.paths.push({ targetDex:dexNumber,method:'unavailable',readiness:phase ? 'blocked' : 'unknown',reasons:[`No documented Pokémon Red acquisition is accessible in ${phase ?? 'the unknown current phase'}. Version-exclusive or trade-evolution species need separate documented methods.`],instructions:[] })
      continue
    }
    const path: AcquisitionPath = { targetDex:dexNumber,method:selected.method === 'level' || selected.method === 'item' ? 'evolve'
      : ['grass','surf','old-rod','good-rod','super-rod'].includes(selected.method) ? 'catch' : selected.method as AcquisitionPath['method'],
      sourceDex:selected.sourceDex,area:selected.executionArea ?? selected.area,level:selected.level,rawItemId:selected.rawItemId,
      readiness:'ready',reasons:[],instructions:instructions(selected) }
    entry.paths.push(path)
    let blocked = false, uncertain = !phase
    const need = (status: Readiness, reason: string) => { blocked ||= status === 'blocked'; uncertain ||= status === 'unknown'; path.reasons.push(reason); entry.missingResources.push(reason) }
    if (!phase) need('unknown','Observe the badge progression before executing this phase-dependent path.')
    if (dexNumber === 150 && !(registered.known && registered.value)) {
      if (!snapshot?.ownedDex.known) need('unknown','Observe the 123 earlier Dex registrations before catching Mewtwo.')
      else if (new Set(snapshot.ownedDex.value.filter(n => n !== 150)).size < 123) need('blocked','Register the 123 earlier canonical species before catching Mewtwo; its own entry cannot substitute for them.')
    }
    const reserveItems: number[] = []
    const requireItem = (id: number, consume = false) => {
      if ((quantities.get(id) ?? 0) > 0) { if (consume) reserveItems.push(id); path.instructions.push(`Retrieve ${itemName(id)} from PC storage if necessary.`) }
      else need(itemsUnknown ? 'unknown' : 'blocked', `${itemName(id)} ${itemsUnknown ? 'availability is unknown' : 'is needed; obtain another before execution'}.`)
    }
    const source = selected.sourceDex === undefined ? undefined : held.find(p => p.dexNumber === selected.sourceDex && !consumed.has(p))
    if (selected.sourceDex !== undefined) {
      if (!source) need(storageUnknown ? 'unknown' : 'blocked', `Held ${name(selected.sourceDex)} ${storageUnknown ? 'availability is unknown' : 'is needed; registration is not trade/evolution fodder'}.`)
      else {
        if (source.location.kind !== 'party') path.instructions.push(`Retrieve the ${source.location.kind === 'daycare' ? 'daycare' : 'boxed'} ${name(selected.sourceDex)} before execution.`)
        if (selected.method === 'level' && !source.level.known) need('unknown', `Current ${name(selected.sourceDex)} level is unknown: ${source.level.reason}`)
      }
    }
    if (selected.method === 'item') requireItem(selected.rawItemId!,true)
    if (selected.area?.startsWith('PokemonTower')) requireItem(72)
    if (dexNumber === 143 && selected.method === 'static') requireItem(73)
    for (const milestone of canonicalAcquisitionMilestones(selected)) {
      const rod = { 'old-rod':76,'good-rod':77,'super-rod':78 }[milestone as 'old-rod' | 'good-rod' | 'super-rod']
      if (rod) requireItem(rod)
      if (milestone === 'surf' || milestone === 'strength') {
        requireItem(milestone === 'surf' ? 198 : 199)
        const move = milestone === 'surf' ? 57 : 70
        const available = held.filter(p => !tradedAway.has(p))
        if (!available.some(p => p.moves.known && p.moves.value.some(m => m.id === move))) need(storageUnknown || available.some(p => !p.moves.known) ? 'unknown' : 'blocked', `A retrieved ${milestone} carrier is required before entering ${path.area}; earlier trades cannot supply their traded-away donor.`)
      }
    }
    if (['grass','surf','old-rod','good-rod','super-rod','static'].includes(selected.method)) {
      const safari = /^safarizone/.test((path.area ?? '').toLowerCase().replace(/[ _]/g,''))
      if (safari) need('unknown','Safari entry funding and the hunt-provided Safari Ball supply are not observed; confirm those prerequisites before catching.')
      else {
        const ball = [4,3,2,1].find(id => (quantities.get(id) ?? 0) > 0)
        if (ball === undefined) need(itemsUnknown ? 'unknown' : 'blocked','Poké Balls are required for catching; earlier planned catches reserve their minimum supply.')
        else {
          reserveItems.push(ball)
          path.instructions.push(`Reserve at least one ${itemName(ball)} for this catch, retrieving it from PC storage if necessary. A single throw does not guarantee success; bring additional capture supplies.`)
        }
      }
    }
    if (selected.method === 'trade') {
      const flag = snapshot?.tradeFlags
      const index = tradeIndices[dexNumber]
      if (!flag?.known || index === undefined || flag.value[index] === undefined) need('unknown','This NPC trade’s unused state is not observed.')
      else if (flag.value[index]) need('blocked','This one-time NPC trade has already been used.')
    }
    if (selected.method === 'gift' || selected.method === 'purchase' || selected.method === 'static') {
      // One-time gift/static availability and money/coins are separate from registered Dex facts.
      need('unknown',`Confirm remaining ${selected.method} availability${selected.method === 'purchase' ? ' and sufficient money/coins' : ''}; registration alone does not establish this resource.`)
      if (selected.method === 'gift' && [138,140,142].includes(dexNumber)) requireItem({138:42,140:41,142:31}[dexNumber]!)
      if (selected.method === 'gift' && [106,107].includes(dexNumber) && snapshot?.events.known && (snapshot.events.value.EVENT_GOT_HITMONLEE || snapshot.events.value.EVENT_GOT_HITMONCHAN)) need('blocked','The one-time Dojo fighter has already been chosen.')
      if (selected.method === 'gift' && [1,4,7].includes(dexNumber) && snapshot?.statusFlags?.known && snapshot.statusFlags.value['wStatusFlags4:3']) need('blocked','The one-time starter has already been chosen.')
      if (selected.method === 'gift' && dexNumber === 131 && snapshot?.statusFlags?.known && snapshot.statusFlags.value['wStatusFlags4:0']) need('blocked','The one-time Lapras has already been received.')
      if (dexNumber === 129 && selected.method === 'purchase' && snapshot?.events.known && snapshot.events.value.EVENT_BOUGHT_MAGIKARP) need('blocked','The Mt. Moon seller’s Magikarp has already been purchased. Recapture a Magikarp with an accessible rod; it cannot replace the seller’s gift history.')
    }
    path.readiness = blocked ? 'blocked' : uncertain ? 'unknown' : 'ready'
    if (!blocked && !uncertain && !(registered.known && registered.value)) {
      if (source) {
        consumed.add(source)
        if (selected.method === 'trade') tradedAway.add(source)
      }
      for (const id of reserveItems) quantities.set(id,quantities.get(id)!-1)
    }
    plan.missingResources.push(...entry.missingResources)
  }
  plan.missingResources = [...new Set(plan.missingResources)]
  plan.diagnostics = [...new Set(plan.diagnostics)]
  return plan
}
