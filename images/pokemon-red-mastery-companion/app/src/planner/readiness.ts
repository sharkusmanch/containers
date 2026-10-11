import type { BranchChoices, CheckpointAssessment, Dataset, Readiness, SaveSnapshot } from '../model'

/** Current preparation only. A defeated leader cannot establish historical checkpoint compliance. */
export function evaluateOakCheckpoint(snapshot: SaveSnapshot | null, checkpointId: string, choices: BranchChoices, dataset: Dataset): CheckpointAssessment {
  const step = dataset.route.find(s => s.id === checkpointId && s.checkpoint)
  const checkpoint = step?.checkpoint
  const ownedCount = snapshot?.ownedDex.known ? { known: true as const, value: new Set(snapshot.ownedDex.value).size }
    : { known: false as const, reason: snapshot && !snapshot.ownedDex.known ? snapshot.ownedDex.reason : 'Import a supported save to observe the Dex.' }
  const result: CheckpointAssessment = { stepId: checkpointId, leader: checkpoint?.leader ?? checkpointId,
    readiness: 'unknown', ownedCount, requiredCount: checkpoint?.ownedCount ?? 0, missingDex: [], reasons: [] }
  if (!checkpoint || !step) { result.reasons.push('Unknown Oak gym checkpoint.'); return result }
  if (!snapshot) { result.reasons.push(ownedCount.known ? '' : ownedCount.reason); return result }
  let blocked = false, uncertain = false
  const require = (status: Readiness, reason: string) => {
    if (status === 'blocked') blocked = true
    if (status === 'unknown') uncertain = true
    result.reasons.push(reason)
  }
  const owned = snapshot.ownedDex.known ? new Set(snapshot.ownedDex.value) : null
  if (!owned) require('unknown', snapshot.ownedDex.known ? '' : snapshot.ownedDex.reason)
  const required = new Set(checkpoint.requiredDex)
  for (const group of checkpoint.branchGroups) {
    if (group.choiceKey) {
      const selected = group.options.find(o => o.value === choices[group.choiceKey!])
      if (!selected) require('unknown', `Record a valid ${group.choiceKey} choice for ${group.id}.`)
      else selected.dexNumbers.forEach(n => required.add(n))
    } else {
      const minimum = group.requiredAll ? group.options.length : group.minimumDistinct ?? 1
      // Misty permits any two distinct Moon Stone species; later phases require all four.
      const selected = group.id === 'moon-stones' && minimum < group.options.length ? choices.moonstones : undefined
      if (selected) {
        const valid = new Set(group.options.flatMap(o => o.dexNumbers))
        if (new Set(selected).size !== minimum || selected.some(n => !valid.has(n))) {
          require('blocked', `Choose ${minimum} distinct valid species for ${group.id}.`)
        } else selected.forEach(n => required.add(n))
      } else if (minimum === group.options.length) group.options.flatMap(o => o.dexNumbers).forEach(n => required.add(n))
      else if (owned && group.options.filter(o => o.dexNumbers.every(n => owned.has(n))).length < minimum) {
        require('blocked', `Register ${minimum} distinct alternatives from ${group.id}.`)
      }
    }
  }
  if (owned) {
    result.missingDex = [...required].filter(n => !owned.has(n)).sort((a,b) => a-b)
    if (result.missingDex.length) require('blocked', `Missing required Dex entries: ${result.missingDex.join(', ')}.`)
    if (owned.size !== checkpoint.ownedCount) require('blocked', `Canonical ${checkpoint.leader} preparation requires exactly ${checkpoint.ownedCount} registered species; observed ${owned.size}. Extra entries cannot replace required species.`)
  }
  let defeated = false
  if (!snapshot.badgeMask.known) require('unknown', snapshot.badgeMask.reason)
  else {
    defeated = (snapshot.badgeMask.value & checkpoint.badgeMask) !== 0
    const earlier = dataset.route.filter(s => s.checkpoint && s.order < step.order).reduce((mask,s) => mask | s.checkpoint!.badgeMask, 0)
    if (defeated) result.reasons.push(`${checkpoint.leader} is already defeated. This save cannot prove the earlier Oak checkpoint or battle restrictions.`)
    else if (snapshot.badgeMask.value !== earlier) require('blocked', 'Follow the canonical badge order Brock → Misty → Koga → Erika → Lt. Surge → Sabrina → Blaine → Giovanni.')
  }
  if (!snapshot.party.known) require('unknown', snapshot.party.reason)
  else {
    if (!snapshot.party.value.length) require('blocked', 'Prepare at least one party member before entering the gym.')
    for (const p of snapshot.party.value) {
      if (!p.level.known) require('unknown', `Party slot ${p.location.kind === 'party' ? p.location.slot : '?'} level: ${p.level.reason}`)
      else if (p.level.value > checkpoint.levelCap) require('blocked', `Box the level-${p.level.value} grinder before entering; entire-party cap is ${checkpoint.levelCap}.`)
      if (p.dexNumber === null) require('unknown', 'A party species is unreadable; inspect the party before entry.')
    }
  }
  if (!snapshot.battleStyle.known) require('unknown', snapshot.battleStyle.reason)
  else if (snapshot.battleStyle.value !== 'set') require('blocked', 'Select Set mode before entering the gym.')
  result.reasons.push('Do not use items in the leader battle. Record attempt-specific battle history and verify the hardcore award; current preparation does not prove execution.')
  result.readiness = defeated ? 'missed' : blocked ? 'blocked' : uncertain ? 'unknown' : 'ready'
  return result
}
