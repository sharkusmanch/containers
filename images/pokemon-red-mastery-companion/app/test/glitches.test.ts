import { describe, expect, it } from 'vitest'
import { planGlitches } from '../src/planner/glitches'
import { dataset } from '../src/data/manifest'
import { validateDataset } from '../src/data/validate'
import { activeAttempt, commitObservation, createProject } from '../src/state/project'
import type { AttemptKind, PlanInput } from '../src/model'
import { serializeProject, restoreProject } from '../src/state/persist'
import { known, pokemon, snapshot, unknown } from './planner-fixtures'

function input(kind: AttemptKind = 'glitch'): PlanInput {
 const project=createProject('player'), attempt=activeAttempt(project)
 attempt.kind=kind;attempt.snapshot=snapshot([],255);attempt.branches.starter='bulbasaur'
 attempt.snapshot.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp:10,ppUps:0},{id:19,pp:10,ppUps:0},{id:57,pp:10,ppUps:0}])}])
 attempt.snapshot.bag=known(Array.from({length:6},(_,i)=>({position:i+1,rawItemId:i===5?40:4+i,quantity:1})))
 attempt.snapshot.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:false,EVENT_BEAT_ROUTE_25_TRAINER_1:false})
 return {project,attempt,dataset}
}
function history(i:PlanInput,key:string,value:boolean|number|string=true) {
 i.attempt.manualEvidence.push({id:crypto.randomUUID(),attemptId:i.attempt.id,continuityRevision:0,status:'active',key,value,recordedAt:'2026-10-11T10:00:00Z'})
}
const method=(i:PlanInput,id:number)=>planGlitches(i).methods.find(m=>m.ruleId===id)!
const transport=(i:PlanInput)=>planGlitches(i).transports.find(m=>m.methodId==='ordinary-trainer-fly')!
// Mutations caught: dropping unsupported objectives, checkbox promotion, snapshot-derived awards,
// wrong starter/EXP/slot arithmetic, skipped transport trainer/PP/continuity gates, source writes.
describe('complete sourced glitch planning',()=>{
 it('keeps every objective and release blocker visible with evidence and boundaries',()=>{
  const i=input('canonical'),p=planGlitches(i)
  expect(p.methods.map(m=>m.ruleId)).toEqual([57639,57640,57641,57642,57643,57644,57645,57655])
  for(const m of p.methods){expect(m.readiness).not.toBe('ready');expect(m.auditStatus).toBe('sourced');expect(m.validationBlockers.length).toBeGreaterThan(0);expect(m.evidence.length).toBeGreaterThan(0);expect(m.sourceUrls.length).toBeGreaterThan(0)}
  expect(method(i,57639).placement).toBe('canonical')
  expect(method(i,57641).requiredAttemptKind).toBe('speedrun')
  expect(method(i,57640).requiredAttemptKind).toBe('glitch')
  expect(method(i,57642).requiredAttemptKind).toBe('glitch')
  expect(method(i,57644).placement).toBe('postgame')
  expect(method(i,57641).nextAction).toMatch(/physical|SRAM/i)
 })
 it('does not promote a sourced method via user runtime validation or manual completion',()=>{
  const i=input();for(const id of [57639,57640,57641,57642,57643,57644,57645,57655]){history(i,`method:${id}:runtime-validated`);history(i,`rule:${id}:completed`)}
  expect(planGlitches(i).methods.every(m=>m.readiness!=='ready')).toBe(true)
  expect(method(i,57642).hardcoreEarnedAt).toBeNull()
  expect(method(i,57642).transitionEvidence.known).toBe(true)
 })
 it('keeps readable guidance and feed awards independent of missing save facts',()=>{
  const i=input();i.attempt.snapshot=null;i.project.accountProgress=[{setKey:'glitch',apiGameId:11632,accountIdentity:'player',lastSuccessfulFetchAt:'now',stale:true,unlocks:[{achievementId:57642,earnedAt:'earned'}]}]
  const m=method(i,57642);expect(m.prerequisites.readiness).toBe('unknown');expect(m.instructions.length).toBeGreaterThan(0);expect(m.hardcoreEarnedAt).toBe('earned');expect(m.transitionEvidence.known).toBe(false)
  i.project.accountProgress[0]!.accountIdentity='other';expect(method(i,57642).hardcoreEarnedAt).toBeNull()
 })
 it('does not use level100, old dex151 or continuity baselines as historical transitions',()=>{
  const i=input();i.attempt.snapshot!.party=known([pokemon(151,100)]);i.attempt.snapshot!.ownedDex=known(Array.from({length:151},(_,n)=>n+1));i.attempt.continuityBaseline={ownedDex:[151]}
  for(const id of [57642,57655]){expect(method(i,id).transitionEvidence.known).toBe(false);expect(method(i,id).hardcoreEarnedAt).toBeNull()}
  expect(method(i,57655).reasons.join(' ')).toMatch(/151.*transition|transition.*151/i)
 })
 it('excludes flagged, foreign and old-revision transition records while keeping history visible',()=>{
  const i=input();history(i,'rule:57642:completed');i.attempt.manualEvidence[0]!.status='needs-review'
  expect(method(i,57642).transitionEvidence.known).toBe(false);expect(method(i,57642).manualEvidence).toHaveLength(1)
  i.attempt.manualEvidence[0]!.status='active';i.attempt.manualEvidence[0]!.attemptId='other';expect(method(i,57642).transitionEvidence.known).toBe(false)
  i.attempt.manualEvidence[0]!.attemptId=i.attempt.id;i.attempt.continuityRevision=1;expect(method(i,57642).transitionEvidence.known).toBe(false)
 })
 it('protects Safari history before malformed-map execution',()=>{
  const i=input();history(i,'protected-main-oak-complete');history(i,'glitch:safari-entry-fee');history(i,'glitch:cinnabar-access')
  expect(method(i,57644).prerequisites.readiness).toBe('unknown')
  expect(method(i,57644).reasons.join(' ')).toMatch(/safari/i)
  history(i,'protected-safari-complete',false);expect(method(i,57644).prerequisites.readiness).toBe('blocked')
 })
 it('requires actual physical isolation even for a correctly named destructive attempt',()=>{
  const i=input('speedrun');expect(method(i,57641).prerequisites.reasons.join(' ')).toMatch(/physically-isolated/)
  history(i,'glitch:physically-isolated',false);expect(method(i,57641).prerequisites.readiness).toBe('blocked')
 })
 it('keeps all eight methods as independent release blockers',()=>{
  expect(validateDataset(dataset,'development')).toEqual([])
  expect(validateDataset(dataset,'release').filter(x=>x.code==='unvalidated-method')).toHaveLength(8)
  expect(dataset.rules).toHaveLength(234)
 })
})
describe('encounter transport and observed preparation',()=>{
 it('blocks ordinary Trainer-Fly if either concrete trainer is already defeated',()=>{
  for(const flag of ['EVENT_BEAT_ROUTE_8_TRAINER_1','EVENT_BEAT_ROUTE_25_TRAINER_1']){const i=input();i.attempt.snapshot!.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:false,EVENT_BEAT_ROUTE_25_TRAINER_1:false,[flag]:true});expect(transport(i).readiness).toBe('blocked');expect(transport(i).reasons.join(' ')).toMatch(/separate|defeated/i)}
 })
 it('does not let Ditto or historical trainer flags supply Trainer-Fly eligibility',()=>{
  const i=input();i.attempt.snapshot!.events=unknown
  expect(transport(i).prerequisites.readiness).toBe('unknown')
  expect(transport(i).reservations).toHaveLength(2)
  expect(transport(i).reservations[0]!.releaseAfter).toMatch(/final planned use/)
  expect(transport(i).reservations[1]!.releaseAfter).toMatch(/battle/)
  expect(planGlitches(i).transports.find(t=>t.methodId==='pc-underflow')!.readiness).not.toBe('ready')
 })
 it('reserves trainers only when explicitly chosen and never treats two trainers as unlimited encounters',()=>{
  const i=input('canonical');expect(planGlitches(i).reservations).toEqual([])
  history(i,'glitch:transport','ordinary-trainer-fly');expect(planGlitches(i).reservations).toHaveLength(2)
  expect(transport(i).warnings.join(' ')).toMatch(/repeat|unlimited/i)
  history(i,'glitch:trainer-fly-final-use-complete');expect(planGlitches(i).reservations).toHaveLength(1)
  i.attempt.snapshot!.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:true,EVENT_BEAT_ROUTE_25_TRAINER_1:true});expect(planGlitches(i).reservations).toEqual([])
 })
 it('requires measured party Special rather than guessed level or boxed Special',()=>{
  const i=input();i.attempt.snapshot!.party=known([{...pokemon(151),special:unknown}]);i.attempt.snapshot!.currentBox=known({index:0,pokemon:[{...pokemon(151),special:known(21)}]})
  expect(method(i,57642).prerequisites.reasons.join(' ')).toMatch(/Special.*unreadable|Special.*unknown|actual party Special/i)
  expect(method(i,57642).readiness).not.toBe('ready')
  i.attempt.snapshot!.party=known([pokemon(151,100)]);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 })
 it.each([0,5])('rejects Growl PP %i when six successful reductions are required',pp=>{
  const i=input();i.attempt.snapshot!.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp,ppUps:0}])}]);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 })
 it('requires successful Growls, Transform and untouched encounter state separately',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  confirmSetup(i,57642,'successful-growls',5);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
  confirmSetup(i,57642,'successful-growls',6);expect(method(i,57642).prerequisites.reasons.join(' ')).toMatch(/transform|Transform/)
  confirmSetup(i,57642,'no-intervening-encounter',false);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 })
 it.each([['bulbasaur',1,6,'Blastoise'],['charmander',2,5,'Venusaur'],['squirtle',3,4,'Charizard']] as const)('routes %s to the correct Oak team', (starter,team,growls,name)=>{
  const i=input();i.attempt.branches.starter=starter
  expect(method(i,57645).oakRoster).toMatchObject({teamNumber:team,successfulGrowls:growls,starter:name})
  expect(method(i,57645).oakRoster!.members.map(m=>m.level)).toEqual([66,67,68,69,70])
 })
 it('keeps unknown starter provenance unknown and requires a victory against the right roster',()=>{
  const i=input();i.attempt.branches={};expect(method(i,57645).oakRoster).toBeUndefined()
  expect(method(i,57645).reasons.join(' ')).toMatch(/starter/)
  history(i,'rule:57645:completed');expect(method(i,57645).hardcoreEarnedAt).toBeNull()
 })
 it('keeps Rare Candy in actual slot six and requires quantity one, not an equivalent sorted bag',()=>{
  const i=input();history(i,'protected-main-oak-complete');history(i,'glitch:old-man-compatible');
  const m=method(i,57643);expect(m.prerequisites.readiness).toBe('ready')
  i.attempt.snapshot!.bag=known([{position:1,rawItemId:40,quantity:1}]);expect(method(i,57643).prerequisites.readiness).toBe('blocked')
  i.attempt.snapshot!.bag=known([{position:6,rawItemId:40,quantity:2}]);expect(method(i,57643).prerequisites.readiness).toBe('blocked')
  i.attempt.snapshot!.bag=unknown;expect(method(i,57643).prerequisites.readiness).toBe('unknown')
 })
 it('rejects the EXP wrap boundary and exposes exact two-participant wild awards',()=>{
  const i=input();permanent(i);startSetup(i,57642);confirmSetup(i,57642,'exp-award',54);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
  expect(method(i,57642).experienceRoute).toMatchObject({minimum:1,maximum:53,awards:[{species:'Pidgey',level:2,exp:7},{species:'Pidgey',level:3,exp:11},{species:'Rattata',level:2,exp:8},{species:'Rattata',level:3,exp:12}]})
 })
 it('requires collection provenance and builds missing species from legitimate owned flags',()=>{
  const i=input();i.attempt.snapshot!.ownedDex=known([1,1,0,152]);const m=method(i,57655)
  expect(m.collection!.ownedCount).toEqual(known(1));expect(m.collection!.missingDex.known&&m.collection!.missingDex.value).not.toContain(1)
  expect(m.collection!.targets.find(t=>t.dexNumber===94)).toMatchObject({special:14})
  expect(m.collection!.targets.find(t=>t.dexNumber===151)).toMatchObject({special:21,measured:known(true)})
  expect(m.prerequisites.reasons.join(' ')).toMatch(/own-collection/)
  i.attempt.snapshot!.ownedDex=unknown;expect(method(i,57655).collection!.missingDex.known).toBe(false)
 })
 it.each([[0,'blocked'],[1,'ready'],[53,'ready'],[54,'blocked']] as const)('checks exact EXP award %i at the real wrap boundary', (award,want)=>{
  const i=input()
  permanent(i);startSetup(i,57642);completeSetup(i,57642);confirmSetup(i,57642,'exp-award',award)
  expect(method(i,57642).prerequisites.readiness).toBe(want)
 })
 it('blocks Exp. All and distinguishes its raw item ID from unrelated items',()=>{
  const i=input();i.attempt.snapshot!.bag=known([{position:1,rawItemId:75,quantity:1}]);expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 })
 it('requires a currently measured donor for a selected missing collection species',()=>{
  const i=input();history(i,'glitch:collection-target-dex',94)
  expect(method(i,57655).prerequisites.readiness).toBe('blocked')
  i.attempt.snapshot!.party=known([{...pokemon(151),special:unknown}]);expect(method(i,57655).prerequisites.reasons.join(' ')).toMatch(/Special.*unreadable/)
 })
 it('labels validation blockers without treating satisfied trainer prerequisites as failed validations',()=>{
  const i=input();history(i,'glitch:transport','ordinary-trainer-fly')
  expect(method(i,57642).validationBlockers.join(' ')).not.toMatch(/remains undefeated/)
 })
 it('does not mutate input snapshots, ordered inventory, or manual history',()=>{
  const i=input(),before=structuredClone(i);planGlitches(i);expect(i).toEqual(before)
 })
})

function startSetup(i: PlanInput, id: number) {
 const action=method(i,id).encounter!.startControls[0]!.action
 history(i,action.key,action.value)
}
function confirmSetup(i: PlanInput, id: number, observation: string, value: boolean | number | string = true) {
 const control=method(i,id).encounter!.confirmationControls.find(c=>c.id===observation)!
 history(i,control.key,value)
}
function phaseSetup(i: PlanInput,id:number,phase:'restored'|'pending'|'exp') {
 const action=method(i,id).encounter!.phaseControls.find(c=>c.phase===phase)!.action
 history(i,action.key,action.value)
}
function permanent(i: PlanInput) {
 for(const key of ['protected-main-oak-complete','glitch:physically-isolated','glitch:ditto-access','glitch:balls-and-finisher','glitch:mew-own-untouched','glitch:oak-battle-supplies'])history(i,key)
 history(i,'glitch:transport','ordinary-trainer-fly')
}
function completeSetup(i:PlanInput,id:number) {
 confirmSetup(i,id,'trainer-escaped')
 i.attempt.snapshot!.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:false,EVENT_BEAT_ROUTE_25_TRAINER_1:true})
 confirmSetup(i,id,'menus-restored');phaseSetup(i,id,'restored')
 for(const key of ['transform-confirmed','neutral-attack-stage','no-intervening-encounter'])confirmSetup(i,id,key)
 confirmSetup(i,id,'successful-growls',6);confirmSetup(i,id,'exp-award',7);phaseSetup(i,id,'pending')
}
describe('encounter identity and ordered resource lifetime',()=>{
 it('refuses legacy unbound Transform/Growls as current encounter completion',()=>{
  const i=input();permanent(i)
  for(const key of ['transform-confirmed','neutral-attack-stage','no-intervening-encounter'])history(i,`glitch:${key}`)
  history(i,'glitch:successful-growls',6);history(i,'glitch:exp-award',7)
  expect(method(i,57642).prerequisites.readiness).not.toBe('ready')
 })
 it('does not reuse Special21 setup evidence for Special226 in the same continuity revision',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  expect(method(i,57642).encounter!.assessment.readiness).toBe('ready')
  const count=i.attempt.manualEvidence.length
  i.attempt.snapshot!.party=known([{...pokemon(151),special:known(226),moves:known([{id:45,pp:6,ppUps:0},{id:19,pp:1,ppUps:0}])}])
  expect(method(i,57642).encounter!.identity.known).toBe(false)
  expect(method(i,57645).encounter!.identity.known).toBe(false)
  startSetup(i,57645)
  const oak=method(i,57645).encounter!
  expect(oak.phase).toBe('preflight')
  expect(oak.confirmationControls.find(c=>c.id==='transform-confirmed')!.observed.known).toBe(false)
  expect(oak.confirmationControls.find(c=>c.id==='successful-growls')!.observed.known).toBe(false)
  expect(i.attempt.manualEvidence.length).toBe(count+1)
  expect(i.attempt.continuityRevision).toBe(0)
 })
 it('new setup generation for the same donor cannot reuse Transform or underflow evidence',()=>{
  const i=input();history(i,'glitch:transport','pc-underflow');startSetup(i,57642)
  confirmSetup(i,57642,'transform-confirmed');confirmSetup(i,57642,'pc-underflow-setup')
  const first=method(i,57642).encounter!.identity
  startSetup(i,57642)
  const next=method(i,57642).encounter!
  expect(next.identity.known&&first.known&&next.identity.value.generation).toBeGreaterThan(first.known?first.value.generation:0)
  for(const id of ['transform-confirmed','pc-underflow-setup'])expect(next.confirmationControls.find(c=>c.id===id)!.observed.known).toBe(false)
 })
 it('assesses preflight, restored menus and pending encounter without requiring spent trainers or PP',()=>{
  const i=input();permanent(i)
  i.attempt.snapshot!.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp:6,ppUps:0},{id:19,pp:1,ppUps:0}])}])
  startSetup(i,57642)
  expect(method(i,57642).encounter!.assessment.readiness).toBe('ready')
  confirmSetup(i,57642,'trainer-escaped');phaseSetup(i,57642,'restored')
  expect(method(i,57642).encounter!.assessment.readiness).not.toBe('ready')
  i.attempt.snapshot!.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:false,EVENT_BEAT_ROUTE_25_TRAINER_1:true})
  confirmSetup(i,57642,'menus-restored')
  expect(method(i,57642).encounter!.assessment.readiness).toBe('ready')
  for(const key of ['transform-confirmed','neutral-attack-stage','no-intervening-encounter'])confirmSetup(i,57642,key)
  confirmSetup(i,57642,'successful-growls',6);confirmSetup(i,57642,'exp-award',7)
  i.attempt.snapshot!.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp:0,ppUps:0},{id:19,pp:1,ppUps:0}])}])
  phaseSetup(i,57642,'pending')
  expect(method(i,57642).encounter!.assessment.readiness).toBe('ready')
  expect(method(i,57642).prerequisites.readiness).toBe('ready')
  expect(method(i,57642).readiness).toBe('blocked')
  confirmSetup(i,57642,'no-intervening-encounter',false)
  expect(method(i,57642).encounter!.assessment.readiness).toBe('blocked')
 })
 it('does not use unscoped legacy confirmations or reconfirmations for a new setup',()=>{
  const i=input();permanent(i)
  for(const key of ['transform-confirmed','neutral-attack-stage','no-intervening-encounter','pc-underflow-setup'])history(i,`glitch:${key}`)
  history(i,'glitch:successful-growls',6);startSetup(i,57642);phaseSetup(i,57642,'pending')
  const e=method(i,57642).encounter!
  expect(e.confirmationControls.find(c=>c.id==='transform-confirmed')!.observed.known).toBe(false)
  expect(e.assessment.readiness).not.toBe('ready')
 })
})

describe('setup lifetime across real imports and persistence',()=>{
 it('invalidates imported donor drift permanently while preserving history and forward PP changes',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  const forward=structuredClone(i.attempt.snapshot!);forward.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp:0,ppUps:0},{id:19,pp:1,ppUps:0}])}])
  i.attempt=commitObservation(i.attempt,forward,[])
  expect(method(i,57642).encounter!.identity.known).toBe(true)
  const changed=structuredClone(forward);changed.party=known([{...pokemon(151),special:known(226),moves:known([{id:45,pp:0,ppUps:0},{id:19,pp:1,ppUps:0}])}])
  i.attempt=commitObservation(i.attempt,changed,[])
  expect(method(i,57642).encounter!.identity.known).toBe(false)
  i.attempt=commitObservation(i.attempt,forward,[])
  expect(method(i,57642).encounter!.identity.known).toBe(false)
  expect(i.attempt.manualEvidence.some(e=>e.key==='glitch:encounter-setup'&&e.status==='needs-review')).toBe(true)
 })
 it('restoring a backup preserves setup history but requires a new current encounter',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  i.attempt.snapshot!.importedAt='2026-10-11T10:00:00Z'
  const restored=restoreProject(serializeProject(i.project))
  expect(restored.ok).toBe(true)
  if(!restored.ok)return
  const next={...i,project:restored.project,attempt:activeAttempt(restored.project)}
  expect(method(next,57642).encounter!.identity.known).toBe(false)
  expect(method(next,57642).encounter!.assessment.readiness).not.toBe('ready')
  expect(next.attempt.manualEvidence.some(e=>e.key.includes('transform-confirmed'))).toBe(true)
  startSetup(next,57642)
  expect(method(next,57642).encounter!.confirmationControls.find(c=>c.id==='transform-confirmed')!.observed.known).toBe(false)
 })
})

it('cannot bypass missing preflight resources by selecting pending and claiming later observations',()=>{
 const i=input();permanent(i)
 i.attempt.snapshot!.events=known({EVENT_BEAT_ROUTE_8_TRAINER_1:false,EVENT_BEAT_ROUTE_25_TRAINER_1:true})
 i.attempt.snapshot!.party=known([{...pokemon(151),special:known(21),moves:known([{id:45,pp:0,ppUps:0},{id:19,pp:1,ppUps:0}])}])
 startSetup(i,57642);completeSetup(i,57642)
 expect(method(i,57642).encounter!.assessment.readiness).toBe('blocked')
})

it('exposes labelled numeric EXP controls with the supported award range',()=>{
 const i=input();permanent(i);startSetup(i,57642)
 expect(method(i,57642).encounter!.confirmationControls.find(c=>c.id==='exp-award')).toMatchObject({valueType:'number',minimum:1,maximum:53,expected:7})
})

function caughtMewAndMovedDonor(i: PlanInput) {
 const previous=i.attempt.snapshot!, donor=previous.party.known?previous.party.value[0]!:pokemon(1)
 return {...previous,party:known([
  {...pokemon(151,1),internalSpeciesId:21,special:known(6),location:{kind:'party' as const,slot:1}},
  {...donor,location:{kind:'party' as const,slot:2},moves:known([{id:45,pp:0,ppUps:0},{id:19,pp:1,ppUps:0}])}
 ])}
}
describe('Mew catch and EXP continuation',()=>{
 it('retains catch confirmation and EXP controls after catch/reorder in one forward import',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  expect(method(i,57642).encounter!.assessment.readiness).toBe('ready')
  const setup=method(i,57642).encounter!.identity
  i.attempt=commitObservation(i.attempt,caughtMewAndMovedDonor(i),[])
  expect(method(i,57642).encounter!.identity.known).toBe(true)
  expect(method(i,57642).encounter!.assessment.readiness).not.toBe('ready')
  confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
  confirmSetup(i,57642,'mew-exp-conditions');confirmSetup(i,57642,'exp-award',7)
  const result=method(i,57642)
  expect(result.encounter!.phase).toBe('exp')
  expect(result.encounter!.identity).toEqual(setup)
  expect(result.encounter!.assessment.readiness).toBe('ready')
  expect(result.prerequisites.readiness).toBe('ready')
  expect(result.encounter!.currentMew.known&&result.encounter!.currentMew.value?.level).toEqual(known(1))
  expect(result.readiness).toBe('blocked');expect(result.hardcoreEarnedAt).toBeNull()
 })
 it('allows attributed catch boundary before the next save import, requiring no intermediate save',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
  i.attempt=commitObservation(i.attempt,caughtMewAndMovedDonor(i),[])
  confirmSetup(i,57642,'mew-exp-conditions');confirmSetup(i,57642,'exp-award',7)
  expect(method(i,57642).encounter!.phase).toBe('exp')
  expect(method(i,57642).prerequisites.readiness).toBe('ready')
 })
 it('does not let an EXP phase selection or a compatible Mew snapshot supply the catch observation',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  phaseSetup(i,57642,'exp')
  i.attempt=commitObservation(i.attempt,caughtMewAndMovedDonor(i),[])
  expect(method(i,57642).encounter!.assessment.readiness).not.toBe('ready')
  expect(method(i,57642).transitionEvidence.known).toBe(false)
 })
 it('new encounter starts and restored backups cannot reuse the EXP continuation',()=>{
  const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
  confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
  i.attempt.snapshot=caughtMewAndMovedDonor(i)
  i.project.attempts=[i.attempt];i.attempt.snapshot.importedAt='2026-10-11T10:00:00Z'
  const restored=restoreProject(serializeProject(i.project));expect(restored.ok).toBe(true)
  if(restored.ok)expect(method({...i,project:restored.project,attempt:activeAttempt(restored.project)},57642).encounter!.identity.known).toBe(false)
  startSetup(i,57642)
  expect(method(i,57642).encounter!.phase).toBe('preflight')
  expect(method(i,57642).encounter!.confirmationControls.find(c=>c.id==='mew-caught-level-one')!.observed.known).toBe(false)
 })
})

it('ends consumed encounter resource predicates while retaining actual Mew EXP preparation',()=>{
 const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
 confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
 const latest=caughtMewAndMovedDonor(i)
 const donor=latest.party.known?latest.party.value[1]!:pokemon(1)
 latest.party=known([{...pokemon(151,1),internalSpeciesId:21,special:known(6)},...Array.from({length:5},(_,n)=>({...pokemon(n+2),location:{kind:'party' as const,slot:n+2}}))])
 latest.currentBox=known({index:0,pokemon:[{...donor,location:{kind:'box',index:0,slot:1}}]})
 i.attempt=commitObservation(i.attempt,latest,[])
 confirmSetup(i,57642,'mew-exp-conditions');confirmSetup(i,57642,'exp-award',7)
 expect(method(i,57642).prerequisites.readiness).toBe('ready')
 i.attempt.snapshot!.bag=known([{position:1,rawItemId:75,quantity:1}])
 expect(method(i,57642).prerequisites.readiness).toBe('blocked')
})

it('keeps EXP controls after the level100 snapshot while leaving the actual transition unproven',()=>{
 const i=input();permanent(i);startSetup(i,57642);completeSetup(i,57642)
 confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
 i.attempt=commitObservation(i.attempt,caughtMewAndMovedDonor(i),[])
 confirmSetup(i,57642,'mew-exp-conditions')
 const after=structuredClone(i.attempt.snapshot!)
 if(after.party.known)after.party.value[0]!.level=known(100)
 i.attempt=commitObservation(i.attempt,after,[])
 confirmSetup(i,57642,'exp-award',7)
 expect(method(i,57642).encounter!.identity.known).toBe(true)
 expect(method(i,57642).encounter!.phase).toBe('exp')
 expect(method(i,57642).encounter!.assessment.readiness).toBe('unknown')
 expect(method(i,57642).transitionEvidence.known).toBe(false)
 expect(method(i,57642).hardcoreEarnedAt).toBeNull()
})

it.each(['ordinary-trainer-fly','pc-underflow'])('retains attempt and physical isolation boundaries during %s EXP continuation',transport=>{
 const i=input();permanent(i);history(i,'glitch:transport',transport);startSetup(i,57642)
 if(transport==='ordinary-trainer-fly')completeSetup(i,57642)
 else {
  for(const key of ['pc-underflow-setup','transform-confirmed','neutral-attack-stage','no-intervening-encounter'])confirmSetup(i,57642,key)
  confirmSetup(i,57642,'successful-growls',6);phaseSetup(i,57642,'pending')
 }
 confirmSetup(i,57642,'mew-caught-level-one');phaseSetup(i,57642,'exp')
 i.attempt=commitObservation(i.attempt,caughtMewAndMovedDonor(i),[])
 confirmSetup(i,57642,'mew-exp-conditions');confirmSetup(i,57642,'exp-award',7)
 i.attempt.kind='canonical'
 expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 i.attempt.kind='glitch'
 history(i,'glitch:physically-isolated',false)
 expect(method(i,57642).prerequisites.readiness).toBe('blocked')
 expect(method(i,57642).prerequisites.reasons.join(' ')).toMatch(/physically-isolated/)
})
