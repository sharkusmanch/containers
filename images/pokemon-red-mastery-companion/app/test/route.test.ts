import { describe, expect, it } from 'vitest'
import { planRun } from '../src/planner/route'
import { dataset } from '../src/data/manifest'
import { createProject } from '../src/state/project'
import type { PlanInput, SaveSnapshot } from '../src/model'
import { brock, known, pokemon, snapshot, unknown } from './planner-fixtures'
function input(s: SaveSnapshot | null = snapshot()): PlanInput {
 const project=createProject('example-player'); const attempt=project.attempts[0]!
 attempt.snapshot=s; attempt.branches={starter:'bulbasaur',eevee:'vaporeon',dojo:'hitmonlee',fossil:'helix'}
 return {project,attempt,dataset}
}
function confirm(i: PlanInput,key: string,value: boolean | number | string=true) {
 i.attempt.manualEvidence.push({id:key,attemptId:i.attempt.id,continuityRevision:i.attempt.continuityRevision,status:'active',key,value,recordedAt:'2026-10-11'})
}
const action=(i: PlanInput,id: number)=>planRun(i).actions.find(a=>a.id===`rule-${id}`)!
const entry=(i: PlanInput,id: string)=>planRun(i).areas!.flatMap(a=>a.entries).find(e=>e.entry.id===id)!
// Mutations caught: empty/incorrect route, unsafe early capture, count-only gyms, unknown-as-false,
// account/manual-history conflation, object-off-as-battle/capture, global scope omissions.
describe('canonical mastery route',()=>{
 it('places every main/Oak objective and all 28 stages in a deterministic plan without a save',()=>{
  const i=input(null),p=planRun(i)
  expect(new Set(p.actions.map(a=>a.routeStepId)).size).toBe(28)
  expect(p.achievements.filter(a=>dataset.rules.find(r=>r.id===a.ruleId)?.setKey!=='glitch')).toHaveLength(226)
  for(const r of dataset.rules.filter(r=>r.setKey!=='glitch'))expect(p.actions.some(a=>a.ruleIds.includes(r.id)),String(r.id)).toBe(true)
  expect(p.actions.map(a=>a.order)).toEqual([...p.actions.map(a=>a.order)].sort((a,b)=>a-b))
  expect(p.checkpoints.map(c=>c.requiredCount)).toEqual([21,47,105,121,122,122,122,122])
  expect(p.actions.filter(a=>a.readiness==='ready')).toHaveLength(0)
 })
 it('requires Parting Gift before capture/evolution and distinguishes its cutoff from buying balls',()=>{
  const s=snapshot([1]);s.bag=known([]);s.events=known({EVENT_GOT_POKEDEX:true,EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE:true,EVENT_GOT_POKEBALLS_FROM_OAK:false})
  const i=input(s)
  expect(action(i,108023).readiness).toBe('ready')
  expect(action(i,165609).readiness).toBe('blocked')
  s.bag=known([{position:1,rawItemId:4,quantity:5}]);expect(action(i,108023).readiness).toBe('blocked')
  s.ownedDex=known([1,10]);expect(action(i,108023).readiness).toBe('missed')
  s.events=known({...s.events.value,EVENT_GOT_POKEBALLS_FROM_OAK:true});expect(action(i,165609).readiness).not.toBe('missed')
  expect(action(i,108023).order).toBeLessThan(action(i,165609).order)
 })
 it('integrates exact Brock collection and party preparation without using boxed levels',()=>{
  const s=snapshot([...brock,1,2,3]);s.party=known([pokemon(1,14)]);s.currentBox=known({index:0,pokemon:[{...pokemon(3,100),location:{kind:'box',index:0,slot:1}}]})
  s.events=known({EVENT_GOT_POKEBALLS_FROM_OAK:true});const i=input(s)
  expect(planRun(i).checkpoints[0]?.readiness).toBe('ready');expect(action(i,108058).readiness).toBe('ready')
  s.party=known([pokemon(1,15)]);expect(action(i,108058).readiness).toBe('blocked')
  s.party=unknown;expect(action(i,108058).readiness).toBe('unknown')
  s.party=known([pokemon(1,14)]);s.battleStyle=unknown;expect(action(i,108058).readiness).toBe('unknown')
 })
 it('keeps current attempt safety and reservations when account-wide HC is earned',()=>{
  const i=input();i.project.accountProgress=[{setKey:'main',apiGameId:724,accountIdentity:'example-player',stale:false,lastSuccessfulFetchAt:'2026-10-11',unlocks:[{achievementId:108023,earnedAt:'2025-01-01'}]}, {setKey:'glitch',apiGameId:11632,accountIdentity:'example-player',stale:false,lastSuccessfulFetchAt:'2026-10-11',unlocks:[{achievementId:57643,earnedAt:'2025-01-01'}]}]
  const p=planRun(i);expect(p.achievements.find(a=>a.ruleId===108023)?.hardcoreEarned).toBe(true)
  expect(p.actions.some(a=>a.id==='rule-108023')).toBe(true);expect(p.reservations.some(r=>r.consumingRuleId===57643)).toBe(true)
 })
 it('leaves flagged manual requirements visible and unknown, never reading baseline facts',()=>{
  const i=input(null);confirm(i,'rule:108056:session-prepared');i.attempt.manualEvidence[0]!.status='needs-review';i.attempt.continuityBaseline={ownedDex:[...brock,1,2,3],badgeMask:255}
  expect(action(i,108056).readiness).toBe('unknown');expect(planRun(i).checkpoints[0]?.ownedCount.known).toBe(false)
 })
 it('exposes independently sourced area counts including hidden pickups, bosses and doors',()=>{
  const p=planRun(input(null));const area=(id:string)=>p.areas!.find(a=>a.id===id)!.entries
  for(const [id,trainers,items] of [['forest',3,5],['moon',12,10],['anne',16,8],['rock-tunnel',15,0],['silph',30,16],['victory',11,10]] as const){
   expect(area(id).filter(e=>e.entry.kind==='trainer'),id).toHaveLength(trainers)
   expect(area(id).filter(e=>e.entry.kind==='pickup'),id).toHaveLength(items)
  }
  expect(area('silph').filter(e=>e.entry.kind==='door')).toHaveLength(20)
  expect(area('safari').filter(e=>e.entry.ruleIds.includes(108045))).toHaveLength(11)
  expect(p.areas!.flatMap(a=>a.entries).filter(e=>e.entry.kind==='static')).toHaveLength(15)
 })
 it('never treats spawned objects, NPC hides, static resolution or mass-set gym flags as receipt/battle/capture',()=>{
  const i=input();i.attempt.snapshot!.events=known({EVENT_GOT_POTION_SAMPLE:true,EVENT_BEAT_PEWTER_GYM_TRAINER_0:true,EVENT_BEAT_BROCK:true,EVENT_BEAT_MEWTWO:true,EVENT_BEAT_SILPH_CO_GIOVANNI:true})
  i.attempt.snapshot!.objectFlags=known({TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_4:true,TOGGLE_SILPH_CO_2F_1:true});i.attempt.snapshot!.badgeMask=known(1)
  expect(entry(i,'gift-potion').completion.known).toBe(false)
  expect(entry(i,'pickup-TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_4').completion.known).toBe(false)
  expect(entry(i,'trainer-EVENT_BEAT_PEWTER_GYM_TRAINER_0').completion.known).toBe(false)
  expect(entry(i,'trainer-EVENT_BEAT_SILPH_CO_2F_TRAINER_0').completion.known).toBe(false)
  expect(action(i,108176).readiness).not.toBe('ready')
 })
 it('requires ship checklist and conversation before Cut, reporting incomplete departed obligations',()=>{
  const i=input();i.attempt.snapshot!.events=known({EVENT_SS_ANNE_LEFT:true,EVENT_BEAT_SS_ANNE_8_TRAINER_0:false})
  expect(action(i,108029).readiness).toBe('missed');expect(action(i,108138).readiness).toBe('unknown')
  expect(action(i,108030).order).toBeGreaterThan(action(i,108138).order)
 })
 it('blocks the ghost method with Scope in the bag and requires Doll and explicit method history',()=>{
  const i=input();i.attempt.snapshot!.bag=known([{position:1,rawItemId:51,quantity:1},{position:2,rawItemId:72,quantity:1}]);i.attempt.snapshot!.events=known({EVENT_BEAT_GHOST_MAROWAK:false})
  expect(action(i,108040).readiness).toBe('blocked')
  i.attempt.snapshot!.bag=known([{position:1,rawItemId:51,quantity:1}]);expect(action(i,108040).readiness).toBe('ready')
  i.attempt.snapshot!.events=known({EVENT_BEAT_GHOST_MAROWAK:true});expect(action(i,108040).readiness).toBe('unknown')
 })
 it('defers optional Safari pickups and checks Surf, space, supplies and continuity after Koga',()=>{
  const i=input();confirm(i,'rule:108045:session-prepared');confirm(i,'safari:supplies-ready')
  expect(action(i,108045).readiness).toBe('blocked')
  const s=i.attempt.snapshot!;s.badgeMask=known(19);s.party=known([{...pokemon(131),moves:known([{id:57,pp:15,ppUps:0}])}]);s.events=known({EVENT_GOT_HM03:true})
  s.objectFlags=known(Object.fromEntries(Object.keys(dataset.game.objectFlags).filter(k=>k.startsWith('TOGGLE_SAFARI_ZONE')).map(k=>[k,false])));s.hiddenItemFlags=known({17:false})
  expect(action(i,108045).readiness).toBe('ready')
  s.bag=known(Array.from({length:10},(_,n)=>({position:n+1,rawItemId:20,quantity:1})));expect(action(i,108045).readiness).toBe('blocked')
  s.bag=known([]);s.hiddenItemFlags=known({17:true});expect(action(i,108045).readiness).toBe('unknown')
  confirm(i,'safari:prior-pickup',true);expect(action(i,108045).readiness).toBe('missed')
 })
 it('routes Silph Rival before full clearance and detects excess trainers and missed battle opportunities',()=>{
  const i=input(),s=i.attempt.snapshot!;s.events=known(Object.fromEntries(Object.keys(dataset.game.eventFlags).filter(k=>/BEAT_SILPH_CO_.*TRAINER/.test(k)).map(k=>[k,false])))
  s.events.value.EVENT_BEAT_SILPH_CO_RIVAL=false;s.events.value.EVENT_BEAT_SILPH_CO_GIOVANNI=false
  s.events.value.EVENT_BEAT_SILPH_CO_5F_TRAINER_0=true;s.events.value.EVENT_BEAT_SILPH_CO_2F_TRAINER_0=true
  expect(action(i,108069).readiness).toBe('missed');expect(action(i,108051).order).toBeGreaterThan(action(i,108069).order)
  s.events.value.EVENT_BEAT_SILPH_CO_GIOVANNI=true;expect(action(i,108051).readiness).toBe('missed')
 })
 it('keeps uninterrupted quiz and League clears separate with exact parties',()=>{
  const i=input();const s=i.attempt.snapshot!;s.events=known(Object.fromEntries(Array.from({length:7},(_,n)=>[`EVENT_BEAT_CINNABAR_GYM_TRAINER_${n}`,false])));s.badgeMask=known(255)
  confirm(i,'rule:4422:session-prepared');confirm(i,'rule:108169:session-prepared');confirm(i,'rule:108170:session-prepared');confirm(i,'rule:108171:session-prepared')
  s.party=known([pokemon(23,50)]);expect(action(i,4422).readiness).toBe('ready');expect(action(i,108169).readiness).toBe('blocked')
  s.party=known(Array.from({length:6},()=>pokemon(23,50)));expect(action(i,108169).readiness).toBe('ready');expect(action(i,4422).readiness).toBe('blocked')
  s.party=known([pokemon(150,50)]);expect(action(i,4422).readiness).toBe('blocked')
  s.party=known([pokemon(23,51)]);expect(action(i,108171).readiness).toBe('blocked')
  expect(action(i,108056).instructions.join(' ')).toMatch(/Yes, No, No, No, Yes, No/i)
 })
})

describe('history and finite resource guards',()=>{
 it('evaluates explicit method-failure cutoffs only from eligible attempt history',()=>{
  const i=input(),s=i.attempt.snapshot!;s.bag=known([{position:1,rawItemId:51,quantity:1}]);s.events=known({EVENT_BEAT_GHOST_MAROWAK:false})
  confirm(i,'ghost-defeated-without-doll');expect(action(i,108040).readiness).toBe('missed')
  i.attempt.manualEvidence[0]!.status='needs-review';expect(action(i,108040).readiness).not.toBe('missed')
 })
 it('does not release Mewtwo or Snorlax capture reservations after the three birds alone',()=>{
  const i=input();confirm(i,'rule:4420:completed')
  const descriptions=planRun(i).reservations.map(r=>r.description).join(' ')
  expect(descriptions).toContain('Mewtwo');expect(descriptions).toContain('Snorlax')
 })
 it('retains per-donor reservations until that actual NPC exchange and includes all 50 field disks',()=>{
  const i=input(),p=planRun(i),all=p.areas!.flatMap(a=>a.entries)
  expect(p.reservations.filter(r=>r.id.startsWith('donor-'))).toHaveLength(9)
  expect(new Set(all.filter(e=>e.entry.ruleIds.includes(108365)).map(e=>e.entry.rawItemId))).toHaveLength(50)
  i.attempt.snapshot!.tradeFlags=known({0:true});expect(planRun(i).reservations.filter(r=>r.id.startsWith('donor-'))).toHaveLength(8)
  i.attempt.snapshot!.ownedDex=known([31,34,36,40]);expect(planRun(i).reservations.some(r=>r.id==='moon-stones')).toBe(false)
 })
 it('keeps historical gym proof separate from current preparation after a legal later party',()=>{
  const i=input(snapshot([...brock,1,2,3],1));confirm(i,'rule:108058:completed');expect(action(i,108058).readiness).toBe('ready')
  i.attempt.manualEvidence[0]!.status='needs-review';expect(action(i,108058).readiness).toBe('unknown')
  expect(action(i,108058).instructions.join(' ')).toMatch(/battle item/)
 })
 it('does not turn a species registration into a Safari capture or League session',()=>{
  const i=input(snapshot([113,115,123,128],255));i.attempt.snapshot!.hallOfFame=known(true)
  expect(action(i,618978).readiness).toBe('unknown');expect(action(i,108170).readiness).toBe('unknown')
 })
 it('preserves frozen current snapshots and gives missing acquisition resources with future guidance',()=>{
  const s=snapshot([1]),i=input(s);s.events=known({EVENT_GOT_POKEBALLS_FROM_OAK:true});s.bag=known([])
  const before=JSON.stringify(i);const p=planRun(i)
  expect(JSON.stringify(i)).toBe(before)
  expect(p.acquisitions!.targets.find(t=>t.dexNumber===10)?.paths[0]?.readiness).toBe('blocked')
  expect(p.actions.find(a=>a.id==='rule-165609')!.instructions.join(' ')).toMatch(/Catch/)
  expect(p.acquisitions!.targets.find(t=>t.dexNumber===3)?.heldInstances).toEqual([])
 })
 it('requires the non-Mewtwo canonical 123 species rather than accepting arbitrary counts for Mewtwo',()=>{
  const i=input(snapshot(Array.from({length:123},(_,n)=>n+1),255));i.attempt.snapshot!.objectFlags=known({TOGGLE_CERULEAN_CAVE_GUY:true})
  expect(action(i,4421).readiness).toBe('blocked')
  expect(action(i,4421).reasons.join(' ')).toMatch(/canonical|required|Register/)
 })
})

describe('late snapshot uncertainty',()=>{
 it('reports historical gym compliance unknown after a badge instead of asserting a failed checkpoint',()=>{
  const i=input(snapshot([...brock,1,2,3],1))
  expect(action(i,108058).readiness).toBe('unknown')
  expect(planRun(i).checkpoints[0]!.readiness).toBe('unknown')
 })
 it('requires a genuinely unmet ship entry to call it missed; unknown flags remain unknown',()=>{
  const i=input();i.attempt.snapshot!.events=known({EVENT_SS_ANNE_LEFT:true})
  expect(action(i,108029).readiness).toBe('unknown');expect(action(i,108138).readiness).toBe('unknown')
 })
 it('requires observed Rival absence before excess current Silph victories establish a missed arrival',()=>{
  const i=input();i.attempt.snapshot!.events=known({EVENT_BEAT_SILPH_CO_2F_TRAINER_0:true,EVENT_BEAT_SILPH_CO_2F_TRAINER_1:true})
  expect(action(i,108069).readiness).toBe('unknown')
 })
 it('cannot infer an already-missed quiz from flags that may have been set after a successful quiz',()=>{
  const i=input();i.attempt.snapshot!.events=known({EVENT_BEAT_CINNABAR_GYM_TRAINER_0:true})
  expect(action(i,108056).readiness).toBe('unknown')
 })
})

it('cannot prepare an irreversible ghost method when the current ghost-resolution fact is unreadable',()=>{
 const i=input();i.attempt.snapshot!.bag=known([{position:1,rawItemId:51,quantity:1}]);i.attempt.snapshot!.events=unknown
 expect(action(i,108040).readiness).toBe('unknown')
})

describe('clearance deadlines and exact pickup evidence',()=>{
 it.each([[108039,108038],[108051,108050]] as const)('emits clearance %i before consuming story action %i', (before,after)=>{
  const actions=planRun(input(null)).actions
  const clearance=actions.findIndex(a=>a.id===`rule-${before}`),story=actions.findIndex(a=>a.id===`rule-${after}`)
  expect(clearance).toBeGreaterThanOrEqual(0)
  expect(clearance).toBeLessThan(story)
  expect(actions[clearance]!.order).toBeLessThan(actions[story]!.order)
 })
 it('assesses Viridian Revive receipt from its exact flag while preserving unknowns',()=>{
  const i=input(),s=i.attempt.snapshot!
  s.objectFlags=known({TOGGLE_VIRIDIAN_GYM_ITEM:false})
  expect(action(i,108066).readiness).toBe('blocked')
  s.objectFlags=known({TOGGLE_VIRIDIAN_GYM_ITEM:true})
  expect(action(i,108066).readiness).toBe('ready')
  s.objectFlags=unknown
  expect(action(i,108066).readiness).toBe('unknown')
  s.objectFlags=known({})
  expect(action(i,108066).readiness).toBe('unknown')
 })
})

describe('Cinnabar quiz entry preparation', () => {
 it('blocks over-cap or Shift entry and leaves unreadable party/style unknown before quizzes', () => {
  const s = snapshot(), i = input(s)
  s.events = known({ EVENT_BEAT_BLAINE: false, ...Object.fromEntries(Array.from({length:7}, (_, n) => [`EVENT_BEAT_CINNABAR_GYM_TRAINER_${n}`, false])) })
  confirm(i, 'rule:108056:session-prepared')
  s.party = known([pokemon(1, 48)])
  expect(action(i, 108056).readiness).toBe('blocked')
  expect(planRun(i).actions.find((a) => a.id === 'stage-cinnabar')?.readiness).toBe('blocked')
  s.party = unknown
  expect(action(i, 108056).readiness).toBe('unknown')
  s.party = known([pokemon(1, 47)])
  s.battleStyle = unknown
  expect(action(i, 108056).readiness).toBe('unknown')
  s.battleStyle = known('shift')
  expect(action(i, 108056).readiness).toBe('blocked')
  s.battleStyle = known('set')
  expect(action(i, 108056).readiness).toBe('ready')
  s.events.value.EVENT_BEAT_CINNABAR_GYM_TRAINER_0 = true
  expect(action(i, 108056).readiness).toBe('unknown')
  s.party = known([pokemon(1, 48)])
  expect(action(i, 108056).readiness).toBe('blocked')
  s.events.value.EVENT_BEAT_CINNABAR_GYM_TRAINER_0 = false
  s.party = known([{...pokemon(1, 47), level: unknown}])
  expect(action(i, 108056).readiness).toBe('unknown')
  s.party = known([{...pokemon(1, 47), dexNumber: null}])
  expect(action(i, 108056).readiness).toBe('unknown')
  expect(action(i, 108056).instructions[0]).toMatch(/before.*gym music/i)
  expect(action(i, 108056).instructions[0]).toMatch(/47.*Set/)
  expect(action(i, 108056).order).toBeLessThan(action(i, 108065).order)
 })
})
