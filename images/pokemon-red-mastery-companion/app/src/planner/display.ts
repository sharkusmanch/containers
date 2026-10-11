/** Display-only descriptors live beside the predicates that consume them. */
import type {
  AchievementRule,
  ManualControl,
  PlanInput,
  Predicate,
  SaveSnapshot,
} from '../model'
const labels: Record<string, string> = {
  'safari:supplies-ready':
    'Safari funding, remaining steps, balls and storage are ready',
  'safari:prior-pickup':
    'An optional Safari pickup was taken outside this protected hunt',
  'hideout:clear-before-giovanni':
    'Hideout clearance was completed before Giovanni',
  'cave:supplies-ready': 'Cave catch session supplies and storage are ready',
  'protected-main-oak-complete':
    'Protected main and Oak work is complete in its original history',
  'protected-safari-complete':
    'Protected Safari sessions are complete in their original history',
  'glitch:physically-isolated':
    'I configured physically separate emulator save storage for this attempt',
  'glitch:celadon-access': 'Celadon Hotel is accessible',
  'glitch:fresh-start': 'This is a fresh, separate speedrun',
  'glitch:rival-name': 'Rival name is JOHN',
  'glitch:ditto-access': 'Ditto is accessible for this setup',
  'glitch:balls-and-finisher':
    'Capture supplies and a healthy finisher are ready',
  'glitch:mew-own-untouched': 'Mew is my own and untouched by extra experience',
  'glitch:old-man-compatible':
    'The encoded player-name encounter has been observed compatible',
  'glitch:safari-entry-fee': 'Safari entry fee of ¥500 is available',
  'glitch:cinnabar-access': 'Cinnabar is accessible',
  'glitch:oak-battle-supplies':
    'Supplies for the exact Professor Oak roster are ready',
  'glitch:own-collection': 'This is my own legitimate collection',
  'glitch:collection-start-below151':
    'This collection began below 151 registered species',
  'glitch:balls-and-storage':
    'Balls and storage are ready for the collection route',
  'glitch:transport': 'Selected encounter transport',
  'glitch:trainer-fly-final-use-complete':
    'The final planned Trainer-Fly use is complete',
  'glitch:collection-target-dex': 'Selected collection target (Dex number)',
}
const scopedOnly = new Set([
  'glitch:transform-confirmed',
  'glitch:neutral-attack-stage',
  'glitch:no-intervening-encounter',
  'glitch:successful-growls',
  'glitch:pc-underflow-ready',
  'glitch:exp-award',
])
export function manualDescriptor(
  key: string,
  expected: boolean | number | string = true,
  rule?: AchievementRule,
): ManualControl {
  const evidence = rule?.evidence.find(
    (e) => e.kind === 'manual' && e.key === key,
  )
  const label =
    labels[key] ??
    (key.endsWith(':session-prepared')
      ? `Session preparation: ${rule?.title}`
      : key.endsWith(':prepared')
        ? `Preparation reviewed: ${rule?.title}`
        : `Observed completion: ${rule?.title ?? 'attempt obligation'}${evidence?.description ? '. ' + evidence.description : ''}`)
  return {
    key,
    label,
    expected,
    valueType: typeof expected as ManualControl['valueType'],
    scope: key.startsWith('glitch:')
      ? 'Current attempt preparation'
      : 'Attempt-specific history',
    ruleId: rule?.id,
  }
}
export function manualControlsForRule(rule: AchievementRule): ManualControl[] {
  const controls: ManualControl[] = []
  const add = (
    key: string,
    value: boolean | number | string = true,
    failure?: string,
  ) => {
    // The route still accepts both historical Safari keys; offer one control.
    if (key === 'safari-optional-taken-before-sweep') key = 'safari:prior-pickup'
    if (scopedOnly.has(key)) return
    const existing = controls.findIndex((c) => c.key === key)
    if (existing >= 0 && !failure) return
    const descriptor = manualDescriptor(key, value, rule)
    if (failure)
      descriptor.label = `Failure observation: ${failure} (record ${String(value)})`
    if (existing >= 0) controls[existing] = descriptor
    else controls.push(descriptor)
  }
  const walk = (p: Predicate, failure?: string) => {
    if (p.kind === 'manual') add(p.key, p.expected ?? true, failure)
    if ('predicates' in p) p.predicates.forEach((child) => walk(child, failure))
    if ('predicate' in p) walk(p.predicate, failure)
  }
  rule.prerequisites.forEach((p) => walk(p))
  rule.evidence
    .filter((e) => e.kind === 'manual' && e.key)
    .forEach((e) => add(e.key!))
  rule.cutoffs.forEach((cutoff) => walk(cutoff.when, cutoff.message))
  add(`rule:${rule.id}:completed`)
  if (rule.id === 108045) add('safari:prior-pickup')
  return controls
}
/** A suggestion only: users can always choose every source stage. No historical completion claim. */
export function suggestedStage({ attempt, dataset }: PlanInput): string {
  if (attempt.kind === 'speedrun') return 'glitch-fresh'
  if (attempt.kind === 'glitch') return 'glitch-expendable'
  const s = attempt.snapshot
  if (!s) return 'pallet'
  if (
    s.events.known &&
    !s.events.value.EVENT_GOT_POKEBALLS_FROM_OAK &&
    s.ownedDex.known &&
    s.ownedDex.value.length <= 1
  )
    return 'pallet'
  const map = s.location.known ? s.location.value.name : undefined
  const entry = map
    ? dataset.areas?.flatMap((a) => a.entries).find((e) => e.area === map)
    : undefined
  if (entry) return entry.routeStepId
  if (s.badgeMask.known)
    return (
      dataset.route.find(
        (r) =>
          r.checkpoint &&
          !(s.badgeMask.known && s.badgeMask.value & r.checkpoint.badgeMask),
      )?.id ?? 'postgame'
    )
  return 'pallet'
}
export function heldSummary(s: SaveSnapshot | null, dex: number): string {
  if (!s) return 'Currently held: unknown — no save imported.'
  const held = [
    ...(s.party.known ? s.party.value : []),
    ...(s.currentBox.known ? s.currentBox.value.pokemon : []),
    ...(s.archivedBoxes.known
      ? s.archivedBoxes.value
          .filter(
            (b) => !s.currentBox.known || b.index !== s.currentBox.value.index,
          )
          .flatMap((b) => b.pokemon)
      : []),
    ...(s.daycare.known && s.daycare.value ? [s.daycare.value] : []),
  ]
  const count = held.filter((p) => p.dexNumber === dex).length
  const uncertain =
    [s.party, s.currentBox, s.archivedBoxes, s.daycare].some((f) => !f.known) ||
    held.some((p) => p.dexNumber === null)
  return `Currently held: ${count ? `${count} observed` : uncertain ? 'unknown' : 'none observed'}${uncertain ? ' · some storage is unknown' : ''}`
}
