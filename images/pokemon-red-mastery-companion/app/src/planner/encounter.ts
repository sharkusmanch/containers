import type { Fact, GlitchEncounterAssessment, GlitchMethod, GlitchSetupIdentity, GlitchSetupPhase, PlanInput, PredicateAssessment } from '../model'
import { manualEvidenceIsEligible } from '../state/project'
import { firstSlotMew, glitchDonorMatches, glitchSetupKey, mewContinuation, parseGlitchSetup } from '../state/glitch-setup'
import { combine, evaluatePredicate, manualFact } from './predicates'

const unknown = (reason: string): Fact<never> => ({ known: false, reason })
const check = (readiness: PredicateAssessment['readiness'], reason: string): PredicateAssessment => ({ readiness, reasons: [reason] })
const observations = [
 ['trainer-escaped', 'Confirm escaped Route 8 Gambler before engagement'],
 ['menus-restored', 'Confirm Route 25 Youngster walked at least one tile and was defeated; menus restored'],
 ['transform-confirmed', 'Confirm Ditto transformed into this measured donor'],
 ['neutral-attack-stage', 'Confirm neutral Attack stage before Growl'],
 ['no-intervening-encounter', 'Confirm escape and no intervening encounter'],
 ['successful-growls', 'Record successful Attack fell reductions for this setup'],
 ['pc-underflow-setup', 'Confirm exact PC underflow setup and slot 100 for this encounter'],
 ['mew-caught-level-one', 'Confirm this intended encounter produced a level-one Mew caught into the party'],
 ['mew-exp-conditions', 'Confirm own untouched Mew first, a healthy finisher, one switch/two surviving participants, and wild Route 1 L2/3 Pidgey/Rattata without bonuses'],
 ['exp-award', 'Record exact one-battle EXP award for this Mew setup'],
] as const

/** Setup identity lives in ordinary persisted manual records; every Start creates a new record ID. */
export function encounterSetup(input: PlanInput, method: GlitchMethod, special: number | undefined, growls: number | undefined): GlitchEncounterAssessment {
 const selected = manualFact(input, 'glitch:transport')
 const transport = selected.known && typeof selected.value === 'string' ? selected.value : ''
 const starts = input.attempt.manualEvidence.filter(e => e.key === glitchSetupKey)
 const record = starts.at(-1)
 const continuation = record ? mewContinuation(input.attempt, record, input.attempt.snapshot) : 'none'
 let identity: Fact<GlitchSetupIdentity> = unknown('Start a new encounter setup with a current measured donor; prior setup history cannot certify this encounter.')
 if (record && manualEvidenceIsEligible(record, input.attempt) && typeof record.value === 'string') {
  const parsed = parseGlitchSetup(record.value)
  if (parsed && parsed.methodId === method.id && parsed.transport === transport && parsed.successfulGrowls === growls &&
      parsed.sourceRevision === input.attempt.source.revision && parsed.donor.special === special &&
      (glitchDonorMatches(input.attempt.snapshot, parsed.donor) || continuation !== 'none')) {
   identity = { known: true, value: { ...parsed, setupId: record.id, generation: starts.length } }
  }
 }

 const scope = identity.known ? `glitch:encounter:${identity.value.setupId}` : null
 const phaseFact = scope ? manualFact(input, `${scope}:phase`) : unknown('No current setup identity.')
 const phase: GlitchSetupPhase = phaseFact.known && (phaseFact.value === 'restored' || phaseFact.value === 'pending' || method.ruleId===57642&&phaseFact.value==='exp') ? phaseFact.value : 'preflight'
 const confirmationControls: GlitchEncounterAssessment['confirmationControls'] = scope ? observations
  .filter(([id]) => phase==='exp' ? ['mew-caught-level-one','mew-exp-conditions','exp-award'].includes(id) : ['mew-caught-level-one','mew-exp-conditions','exp-award'].includes(id) ? method.ruleId === 57642 : id === 'pc-underflow-setup' ? transport === 'pc-underflow' :
   id === 'trainer-escaped' || id === 'menus-restored' ? transport === 'ordinary-trainer-fly' : true)
  .map(([id, label]) => ({ id, label, key: `${scope}:${id}`,
   valueType: id === 'successful-growls' || id === 'exp-award' ? 'number' : 'boolean',
   expected: id === 'successful-growls' ? growls ?? 0 : id === 'exp-award' ? 7 : true,
   ...(id === 'exp-award' ? {minimum: 1, maximum: 53} : id === 'successful-growls' ? {minimum: 0, maximum: 6} : {}),
   observed: manualFact(input, `${scope}:${id}`) })) : []
 const requireObservation = (id: string, expected: boolean | number = true): PredicateAssessment => {
  const fact = confirmationControls.find(c => c.id === id)?.observed ?? unknown(`Confirm ${id} for this setup.`)
  return fact.known ? check(fact.value === expected ? 'ready' : 'blocked', `Setup observation ${id} must be ${expected}.`) : check('unknown', fact.reason)
 }
 const checks: PredicateAssessment[] = []
 if (phase !== 'preflight' && identity.known) checks.push(check(identity.value.preflightReadiness, 'Starting setup must have observed preflight resources; later confirmations do not repair a lost trainer or insufficient initial PP.'))
 if (!identity.known) checks.push(check('unknown', identity.reason))
 if (growls === undefined) checks.push(check('unknown', 'Record starter provenance before selecting Growl reductions.'))
 else if (phase !== 'pending' && phase !== 'exp' && growls > 0) checks.push(usableGrowl(input, growls))
 if (phase!=='exp' && transport === 'ordinary-trainer-fly') {
  checks.push(evaluatePredicate({ kind: 'move', moveId: 19 }, input), evaluatePredicate({ kind: 'badge', mask: 4, obtained: true }, input))
  checks.push(evaluatePredicate({ kind: 'event', flag: 'EVENT_BEAT_ROUTE_8_TRAINER_1', value: false }, input))
  checks.push(evaluatePredicate({ kind: 'event', flag: 'EVENT_BEAT_ROUTE_25_TRAINER_1', value: phase !== 'preflight' }, input))
  if (phase !== 'preflight') checks.push(requireObservation('trainer-escaped'), requireObservation('menus-restored'))
 } else if (phase!=='exp' && transport === 'pc-underflow') {
  checks.push(evaluatePredicate({ kind: 'manual', key: 'glitch:physically-isolated' }, input))
  if (phase === 'pending') checks.push(requireObservation('pc-underflow-setup'))
 } else if(phase!=='exp')checks.push(check('unknown', 'Select a sourced encounter transport for the setup.'))
 if (phase === 'pending') {
  checks.push(requireObservation('transform-confirmed'), requireObservation('neutral-attack-stage'),
   requireObservation('successful-growls', growls ?? 0), requireObservation('no-intervening-encounter'))
 }
 const currentMew = method.ruleId===57642 ? firstSlotMew(input.attempt.snapshot) : undefined
 if (phase==='exp') {
  checks.push(continuation==='attributed-catch'?check('ready','Attributed intended level-one Mew catch ends live donor-slot and transport resource requirements.'):
   check('unknown','Confirm the intended level-one Mew catch and completed scoped preparation before EXP continuation.'))
  checks.push(requireObservation('mew-exp-conditions'))
  if(currentMew?.known){
   const mon=currentMew.value
   checks.push(!mon?check('blocked','Put the caught Mew first for the EXP step.'):!mon.level.known?check('unknown',mon.level.reason):
    mon.level.value===1?check('ready','Current first-slot Mew is level one; retain its untouched EXP until the single battle.'):
    check('unknown','Current Mew level alone cannot prove the one-battle level1→100 transition; preserve scoped EXP and completion history.'))
  }else checks.push(check('unknown',currentMew&&!currentMew.known?currentMew.reason:'Observe current first-slot Mew.'))
 }else if(continuation==='catch-compatible')checks.push(check('unknown','Catch-compatible current party arrangement preserves history only; confirm the actual level-one Mew catch before continuing EXP.'))
 const preflightChecks: PredicateAssessment[] = []
 if (growls === undefined) preflightChecks.push(check('unknown', 'Choose the starter/method first.'))
 else if (growls > 0) preflightChecks.push(usableGrowl(input, growls))
 if (transport === 'ordinary-trainer-fly') preflightChecks.push(
  evaluatePredicate({kind:'event',flag:'EVENT_BEAT_ROUTE_8_TRAINER_1',value:false},input),
  evaluatePredicate({kind:'event',flag:'EVENT_BEAT_ROUTE_25_TRAINER_1',value:false},input),
  evaluatePredicate({kind:'move',moveId:19},input),evaluatePredicate({kind:'badge',mask:4,obtained:true},input))
 else if (transport === 'pc-underflow') preflightChecks.push(evaluatePredicate({kind:'manual',key:'glitch:physically-isolated'},input))
 else preflightChecks.push(check('unknown','Choose an encounter transport before starting.'))
 const preflight = combine(preflightChecks)
 const party = input.attempt.snapshot?.party
 const startControls = ['ordinary-trainer-fly', 'pc-underflow'].includes(transport) && special !== undefined && growls !== undefined && party?.known ? party.value.flatMap(p => {
  if (!p.special.known || p.special.value !== special || p.location.kind !== 'party') return []
  const descriptor = { methodId: method.id, transport, donor: { slot: p.location.slot, internalSpeciesId: p.internalSpeciesId, special },
   successfulGrowls: growls, sourceRevision: input.attempt.source.revision, preflightReadiness: preflight.readiness }
  return [{ label: `Start/new setup: party slot ${p.location.slot}, Special ${special}`,
   action: { key: glitchSetupKey, value: JSON.stringify(descriptor), ruleId: method.ruleId } }]
 }) : []
 return { identity, phase, continuation, ...(currentMew?{currentMew}:{}), assessment: combine(checks, 'unknown'), startControls, confirmationControls,
  phaseControls: scope ? ([['preflight', 'Return to preflight'], ['restored', 'Menus restored; prepare Ditto'], ['pending', 'Ditto setup complete; encounter pending'], ['exp', 'Caught intended level-one Mew; continue EXP step']] as const)
   .filter(([nextPhase]) => (nextPhase !== 'restored' || transport === 'ordinary-trainer-fly') && (nextPhase !== 'exp' || method.ruleId===57642))
   .map(([nextPhase, label]) => ({ phase: nextPhase, label, action: { key: `${scope}:phase`, value: nextPhase, ruleId: method.ruleId } })) : [] }
}

function usableGrowl(input: PlanInput, count: number): PredicateAssessment {
 const party = input.attempt.snapshot?.party
 if (!party?.known) return check('unknown', 'Observe a party Growl carrier and usable PP.')
 if (party.value.some(p => p.moves.known && p.moves.value.some(m => m.id === 45 && m.pp >= count))) {
  return check('ready', `Party Growl carrier has PP for ${count} successful reductions before Ditto setup.`)
 }
 return party.value.some(p => !p.moves.known) ? check('unknown', 'Growl PP is unreadable.') :
  check('blocked', `Retrieve a party Growl carrier with at least ${count} usable PP before setup; misses may need more PP.`)
}

/** A scoped observation cannot be supplied by shared legacy keys or another setup. */
export function setupObservation(encounter: GlitchEncounterAssessment, id: string): Fact<boolean | number | string> {
 return encounter.confirmationControls.find(c => c.id === id)?.observed ?? unknown(`Confirm ${id} for the current encounter setup.`)
}
