import type { Fact, GlitchCollectionAssessment, GlitchMethodAssessment, GlitchPlan, GlitchTrainerReservation, GlitchTransportAssessment, PlanInput, Predicate, PredicateAssessment, Readiness } from '../model'
import { assess, combine, evaluatePredicate, flagFact, manualFact } from './predicates'
import { encounterSetup, setupObservation } from './encounter'

const check=(readiness:Readiness,reason:string):PredicateAssessment=>({readiness,reasons:[reason]})
const trainers:GlitchTrainerReservation[]=[
 {flag:'EVENT_BEAT_ROUTE_8_TRAINER_1',trainer:'Route 8 north-facing Gambler (ROUTE8_GAMBLER1)',geometry:'Map (13,9), facing north, sight range four.',releaseAfter:'Only after the final planned use, then legitimately defeat him; main all-trainers work remains outstanding meanwhile.'},
 {flag:'EVENT_BEAT_ROUTE_25_TRAINER_1',trainer:'Route 25 Youngster 2',geometry:'Map (18,5); he must walk at least one tile to the player.',releaseAfter:'Consumed by the release battle restoring menus. Do not assume unlimited repeatability.'},
]
const sourceRoot='https://github.com/pret/pokered/blob/af519899719f0754965776faac0e836a3b906e6d/'
function transports(input:PlanInput):GlitchTransportAssessment[] {
 const checks=trainers.map(t=>assess(invert(flagFact(input,'events',t.flag)),`${t.trainer} remains undefeated.`,`${t.trainer} is defeated; ordinary Trainer-Fly is lost. Defer transport validation or use a separately stored attempt.`))
 checks.push(evaluatePredicate({kind:'move',moveId:19},input),evaluatePredicate({kind:'badge',mask:4,obtained:true},input))
 const prerequisites=combine(checks)
 return [
  {methodId:'ordinary-trainer-fly',prerequisites,...combine([prerequisites,check('blocked','Sourced Trainer-Fly geometry and encounter transport need target-core/RA validation; Ditto supplies Special only.')]),auditStatus:'sourced',reservations:trainers,
   instructions:['Prepare Fly and both undefeated trainers. Stand beyond Route 8 Gambler’s north-facing sight line, step into it and open Start before engagement completes, then Fly away.', 'Have Route 25 Youngster 2 walk at least one tile to you, defeat him to restore menus, then find Ditto. Observe Transform into the measured donor, apply the selected successful Growls, and escape.', 'Return to Route 8 without another encounter. Close the triggered menu to begin the forced battle. Runtime geometry remains pending; this option reserves no trainer on the default canonical all-trainers route.'],
   warnings:['Two reservations do not prove unlimited or arbitrary repeated encounters for a 151 collection.', 'The release trainer is consumed; release the escaped trainer only after final planned use and then defeat him legitimately.'],sourceUrls:['data/maps/objects/Route8.asm','scripts/Route8.asm','data/maps/objects/Route25.asm','home/trainers.asm'].map(p=>sourceRoot+p)},
  {methodId:'pc-underflow',prerequisites:combine([evaluatePredicate({kind:'manual',key:'glitch:physically-isolated'},input),check('unknown','Start a method-bound encounter setup before confirming the exact PC-underflow state.')]),...check('blocked','Trainer-free PC underflow crosses inventory into unrelated memory. Precise boundaries, absolute slot numbering and repeated-use safety are unvalidated; use physically separate SRAM or defer.'),auditStatus:'sourced',reservations:[],
   instructions:['In a separately stored controlled attempt, obtain a disposable ×255 stack by MissingNo duplication. Arrange PC A×1, B×1, C×255; record original distinct-slot count N.', 'Have Route 15 Ditto copy the measured donor, apply the chosen successful Growls if needed, then escape. Reach Cerulean PC without another encounter.', 'Toss B then A. Toss 255 from slot one N−2 times until only two items are selectable. Toss 253 from first slot; swap slots one and two twice. First quantity becomes zero and the menu can exceed 50 slots.', 'Identify absolute PC slot 100, associated with Route 24 script byte. Toss 255 to leave quantity one. Exit PC, open/close Start, then enter Route 24 north of Cerulean. Validate the exact slot and memory boundary before execution; do not modify other out-of-range items.'],
   warnings:['Source documents resetting slot 100 for reuse; repeatability has not been demonstrated on the target core.', 'Never discard key items, use random glitch items, edit save files or restore an earlier player save as recovery.'],sourceUrls:['https://pastebin.com/SPYqSQSL',sourceRoot+'engine/items/inventory.asm',sourceRoot+'scripts/Route24.asm']},
 ]
}
function invert(f:Fact<boolean>):Fact<boolean>{return f.known?{known:true,value:!f.value}:f}
function measured(input:PlanInput,value:number):Fact<boolean> {
 const party=input.attempt.snapshot?.party
 if(!party?.known)return {known:false,reason:'Observe actual party Special stats.'}
 if(party.value.some(p=>p.special.known&&p.special.value===value))return {known:true,value:true}
 return party.value.some(p=>!p.special.known)?{known:false,reason:'Actual party Special stats are unreadable.'}:{known:true,value:false}
}
function collection(input:PlanInput,targets:NonNullable<PlanInput['dataset']['glitches'][number]['collectionTargets']>):GlitchCollectionAssessment {
 const owned=input.attempt.snapshot?.ownedDex
 const legitimate=owned?.known?[...new Set(owned.value.filter(n=>Number.isInteger(n)&&n>=1&&n<=151))]:null
 const unknown={known:false as const,reason:owned&&!owned.known?owned.reason:'Observe legitimate owned Dex IDs 1–151.'}
 const missing=legitimate?Array.from({length:151},(_,i)=>i+1).filter(n=>!legitimate.includes(n)):null
 return {ownedCount:legitimate?{known:true,value:legitimate.length}:unknown,missingDex:missing?{known:true,value:missing}:unknown,
  targets:targets.map(t=>({...t,missing:missing?{known:true,value:missing.includes(t.dexNumber)}:unknown,measured:measured(input,t.special)}))}
}
/** Sourced guidance remains usable. Only independent dataset validation can permit execution readiness. */
export function planGlitches(input:PlanInput):GlitchPlan {
 const transportOptions=transports(input),selected=manualFact(input,'glitch:transport'),snapshot=input.attempt.snapshot
 const predicate=(p:Predicate)=>evaluatePredicate(p,input)
 const methods:GlitchMethodAssessment[]=input.dataset.glitches.map(m=>{
  const transientKeys = new Set(['glitch:transform-confirmed', 'glitch:neutral-attack-stage', 'glitch:no-intervening-encounter'])
  let checks=m.prerequisites.filter(p=>!(p.kind==='manual'&&transientKeys.has(p.key))).map(predicate)
  const unsafeUnderflow=m.transport==='pc-underflow'
  const requiredAttemptKind=m.ruleId===57641?'speedrun':m.ruleId===57639?'canonical':unsafeUnderflow||m.ruleId===57640||m.ruleId===57644?'glitch':input.attempt.kind==='glitch'?'glitch':'canonical'
  const oakRoster=m.oakRosters?.[input.attempt.branches.starter??'']
  if(m.ruleId===57641){
   const trainer=snapshot?.trainer
   checks.push(!trainer?.known?check('unknown','Observe player RED and trainer ID 25794 in the fresh attempt.'):check(trainer.value.name==='RED'&&trainer.value.id===25794?'ready':'blocked','Fresh route requires player RED and trainer ID 25794 (0x64C2).'))
  }
  const collectionStatus=m.collectionTargets?collection(input,m.collectionTargets):undefined
  const selectedTarget=manualFact(input,'glitch:collection-target-dex')
  const target=collectionStatus&&selectedTarget.known?collectionStatus.targets.find(t=>t.dexNumber===selectedTarget.value):undefined
  const growls=m.ruleId===57655?0:typeof m.successfulGrowls==='number'?m.successfulGrowls:input.attempt.branches.starter?m.successfulGrowls?.[input.attempt.branches.starter]:undefined
  const encounter=unsafeUnderflow?encounterSetup(input,m,target?.special??m.measuredSpecial[0],growls):undefined
  if(m.ruleId===57642&&encounter?.phase==='exp'){
   // The catch consumed party capacity/balls and ended donor/Growl/Ditto preparation.
   // Current own-Mew/finisher/participation conditions come from scoped EXP controls instead.
   checks=m.prerequisites.filter(p=>!(p.kind==='special'||p.kind==='move'&&p.moveId===45||p.kind==='party-size'||
    p.kind==='manual'&&(transientKeys.has(p.key)||['glitch:ditto-access','glitch:balls-and-finisher','glitch:mew-own-untouched'].includes(p.key)))).map(predicate)
   checks.push(predicate({kind:'party-size',minimum:2,maximum:6}))
  }
  if(input.attempt.kind!==requiredAttemptKind)checks.push(check('blocked',`Use a named ${requiredAttemptKind} attempt${unsafeUnderflow?'; no validated canonical encounter transport fits after all-trainer clearance':''}.`))
  if(encounter)checks.push(encounter.assessment)
  if(m.ruleId===57642&&encounter){
   const exp=setupObservation(encounter,'exp-award')
   checks.push(exp.known?check(typeof exp.value==='number'&&Number.isInteger(exp.value)&&exp.value>=1&&exp.value<=53?'ready':'blocked','Require exactly 1–53 EXP in one battle; 54 wraps to zero and fails the route.'):check('unknown','Observe exact 1–53 EXP award for this setup with two surviving participants, no trade/trainer bonus or Exp. All.'))
  }
  if(collectionStatus){
   if(!target)checks.push(check('unknown','Select a sourced missing-species Special target; use ordinary acquisition/evolution for the remaining legitimate Dex entries.'))
   else checks.push(assess(target.measured,`Measured current party Special ${target.special} for Dex ${target.dexNumber}.`,`Measure actual party Special ${target.special} for Dex ${target.dexNumber}; no guessed or boxed donor stats.`))
  }
  if(collectionStatus?.ownedCount.known&&collectionStatus.ownedCount.value===151)checks.push(check('unknown','Existing 151 flags are collection status, not the below151→151 unlock transition. Confirm own prior-start and final-acquisition history.'))
  const prerequisites=combine(checks,'unknown')
  const validationBlockers=[...(m.validationBlockers??[])]
  if(m.auditStatus!=='validated'||!m.validationEvidence?.length)validationBlockers.push('Dataset method has source evidence only; a user runtime-validated checkbox cannot replace independent target-core/RA validation.')
  if(unsafeUnderflow){const chosen=selected.known?transportOptions.find(t=>t.methodId===selected.value):undefined;validationBlockers.push(chosen?`Chosen ${chosen.methodId} encounter transport is sourced only and lacks target-core/RA validation.`:'Validated encounter transport remains unavailable.')}
  const result=combine([prerequisites,...validationBlockers.map(r=>check('blocked',r))])
  const transition=manualFact(input,`rule:${m.ruleId}:completed`)
  const transitionEvidence:Fact<boolean>=transition.known&&typeof transition.value==='boolean'?{known:true,value:transition.value}:{known:false,reason:'No eligible attempt-specific observed transition history; current snapshots and account unlocks cannot supply it.'}
  const feed=input.project.accountProgress.find(p=>p.setKey==='glitch'&&p.apiGameId===input.dataset.sets.find(s=>s.key==='glitch')?.apiGameId&&p.accountIdentity!==null&&p.accountIdentity===input.project.accountIdentity)
  const hardcoreEarnedAt=feed?.unlocks.find(u=>u.achievementId===m.ruleId)?.earnedAt??null
  const requiresPhysicalIsolation=unsafeUnderflow||m.ruleId===57640||m.ruleId===57641||m.ruleId===57644
  return {methodId:m.id,ruleId:m.ruleId,...result,instructions:[...m.instructions],auditStatus:m.auditStatus,prerequisites,validationBlockers,sourceUrls:m.sourceUrls,evidence:m.evidence,placement:m.attemptPolicy.placement,requiredAttemptKind,requiresPhysicalIsolation,
   nextAction:requiresPhysicalIsolation?`Create/select a named ${requiredAttemptKind} attempt with physically separate emulator SRAM; app names alone do not isolate saves. Defer execution until validation blockers are resolved.`:validationBlockers.length?'Retain prerequisites and source instructions; defer execution until target-core/RA validation.':'Review current prerequisite reasons before proceeding.',recoveryBoundary:m.recoveryBoundary,requiresMeasuredSpecial:!!m.measuredSpecial.length||m.ruleId===57655,
   measuredDonors:snapshot?.party.known?snapshot.party.value.flatMap(p=>p.special.known&&p.location.kind==='party'?[{slot:p.location.slot,special:p.special.value,internalSpeciesId:p.internalSpeciesId,importedAt:snapshot.importedAt}]:[]):[],
   transitionEvidence,hardcoreEarnedAt,manualEvidence:input.attempt.manualEvidence.filter(e=>e.ruleId===m.ruleId||e.key.startsWith(`rule:${m.ruleId}:`)||e.key.startsWith(`method:${m.ruleId}:`)||e.key.startsWith('glitch:')||e.key.startsWith('protected-')),
   ...(encounter?{encounter}:{}),...(oakRoster?{oakRoster}:{}),...(m.experienceRoute?{experienceRoute:m.experienceRoute}:{}),...(collectionStatus?{collection:collectionStatus}:{})}
 })
 // Reservations are opt-in; current defeated flags or eligible final-use history release them.
 const finalUse=manualFact(input,'glitch:trainer-fly-final-use-complete')
 const reservations=selected.known&&selected.value==='ordinary-trainer-fly'?trainers.filter((t,index)=>{
  const flag=flagFact(input,'events',t.flag)
  return !(flag.known&&flag.value)&&!(index===0&&finalUse.known&&finalUse.value===true)
 }):[]
 return {methods,transports:transportOptions,reservations,diagnostics:['All eight chosen procedures remain sourced; target-core and RA hardcore validation are Task9 release gates.', 'Save facts, eligible attempt history and account-wide hardcore timestamps remain independent. Original imported bytes are never written.', 'Complete protected main/Oak and Safari objectives before inventory or encounter-script corruption. Physical emulator SRAM isolation must be configured outside this read-only companion.',...input.project.accountProgress.filter(p=>p.setKey==='glitch'&&p.stale).map(p=>`Glitch hardcore feed is stale; last successful fetch ${p.lastSuccessfulFetchAt??'never'}.`)]}
}
