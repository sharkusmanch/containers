import { manualControlsForRule, manualDescriptor } from './display'
import type { AchievementAssessment, AchievementRule, AreaEntryAssessment, PlanInput, PlannedAction, Predicate, PredicateAssessment, Reservation, RunPlan } from '../model'
import { manualEvidenceIsEligible } from '../state/project'
import { planAcquisitions } from './acquisition'
import { evaluateOakCheckpoint } from './readiness'
import { assessAreas } from './areas'
import { assess, combine, evaluatePredicate, flagFact, manualFact } from './predicates'
const check=(readiness:PredicateAssessment['readiness'],reason:string):PredicateAssessment=>({readiness,reasons:[reason]})
const storyEvents:Record<number,string>={108021:'EVENT_GOT_TOWN_MAP',108022:'EVENT_GOT_POKEDEX',108023:'EVENT_GOT_POKEBALLS_FROM_OAK',108027:'EVENT_GOT_ITEMFINDER',108028:'EVENT_GOT_HM05',108030:'EVENT_GOT_HM01',108036:'EVENT_GOT_HM02',4418:'EVENT_GOT_POKE_FLUTE',108044:'EVENT_GOT_EXP_ALL',108046:'EVENT_GOT_HM03',108048:'EVENT_GOT_HM04',108049:'EVENT_GOT_BICYCLE',108050:'EVENT_GOT_MASTER_BALL'}
const historyKey=(id:number)=>`rule:${id}:completed`
function confirmed(input:PlanInput,key:string){const f=manualFact(input,key);return f.known&&f.value===true}
function reviewedHistory(input:PlanInput,id:number){return input.attempt.manualEvidence.some(e=>e.key===historyKey(id)&&!manualEvidenceIsEligible(e,input.attempt))}
function sourceComplete(input:PlanInput,id:number){const flag=storyEvents[id];if(!flag)return false;const f=flagFact(input,'events',flag);return f.known&&f.value}
export function eligibleCompletion(input:PlanInput,id:number){return confirmed(input,historyKey(id))||sourceComplete(input,id)}
function ruleTargets(rule:AchievementRule,input:PlanInput):number[]{
 const branch=rule.branches.find(g=>g.choiceKey)
 if(branch?.choiceKey){const selected=branch.options.find(o=>o.value===input.attempt.branches[branch.choiceKey!]);if(!selected)return [];return (rule.acquisitions??[]).filter(a=>selected.dexNumbers.includes(a.targetDex)).map(a=>a.targetDex)}
 // Misty's choice is explicit or observed; avoid allocating all four stones before the two-entry checkpoint.
 const moon=rule.branches.find(g=>g.id==='moon-stones')
 if(moon?.minimumDistinct===2){const chosen=input.attempt.branches.moonstones;if(chosen)return chosen;const dex=input.attempt.snapshot?.ownedDex;return moon.options.flatMap(o=>o.dexNumbers).filter(n=>dex?.known&&dex.value.includes(n))}
 return (rule.acquisitions??[]).map(a=>a.targetDex)
}
/** Canonical plan: immutable observations, explicit unknowns, and all retained source stages. */
export function planRun(input: PlanInput): RunPlan {
 const {dataset,attempt,project}=input,s=attempt.snapshot
 const areas=assessAreas(input),entries=areas.flatMap(a=>a.entries)
 const checkpoints=dataset.route.filter(r=>r.checkpoint).sort((a,b)=>a.order-b.order).map(r=>{
  const c=evaluateOakCheckpoint(s,r.id,attempt.branches,dataset)
  if(c.readiness==='missed')return {...c,readiness:'unknown' as const,reasons:[...c.reasons,'Past opportunity alone does not prove historical failure; review attempt-specific checkpoint evidence.']}
  return c
 })
 const oakRules=dataset.route.flatMap(step=>step.ruleIds.map(id=>dataset.rules.find(r=>r.id===id))).filter((r):r is AchievementRule=>!!r&&r.setKey==='oak')
 const acquisitions=planAcquisitions(s,[...new Set(oakRules.flatMap(r=>ruleTargets(r,input)))],dataset)
 const predicate=(p:Predicate,r?:AchievementRule)=>evaluatePredicate(p,input,r)
 const event=(flag:string)=>flagFact(input,'events',flag)
 const isEvent=(flag:string)=>{const f=event(flag);return f.known&&f.value}
 let currentRule:AchievementRule|undefined
 let controls:ReturnType<typeof manualControlsForRule>=[]
 const manual=(key:string)=>{if(currentRule&&!controls.some(c=>c.key===key))controls.push(manualDescriptor(key,true,dataset.rules.find(r=>key.startsWith(`rule:${r.id}:`))??currentRule));return predicate({kind:'manual',key,expected:true})}
 const areaEntries=(id:string,kind?:string)=>areas.find(a=>a.id===id)?.entries.filter(e=>!kind||e.entry.kind===kind)??[]
 const checklist=(list:AreaEntryAssessment[])=>combine(list.map(e=>assess(e.completion,`${e.entry.title}: recorded ${e.evidence} evidence.`,`Still required: ${e.entry.area} — ${e.entry.title}.`)),'unknown')
 const ruleEntries=(id:number)=>entries.filter(e=>e.entry.ruleIds.includes(id))
 const giftGate=()=>sourceComplete(input,108023)||confirmed(input,historyKey(108023))?check('ready','Oak’s initial gift is recorded in this attempt.')
  :assess(event('EVENT_GOT_POKEBALLS_FROM_OAK'),'Oak gift received.','Obtain Oak’s five-ball gift before catching another species or evolving.')
 const historyAfter=(id:number,message:string)=>check(reviewedHistory(input,id)?'unknown':'missed',message+' Current-attempt history is required; account awards do not prove it.')
 const assessments:AchievementAssessment[]=[]
 const byId=new Map<number,PredicateAssessment>()
 for(const rule of dataset.rules){
  currentRule=rule;controls=manualControlsForRule(rule)
  const checks:PredicateAssessment[]=[];const done=eligibleCompletion(input,rule.id)
  const preparation=rule.prerequisites.map(p=>predicate(p,rule))
  let custom:PredicateAssessment|undefined
  if(rule.setKey==='glitch')custom=check('unknown','Glitch method planning and target-core validation are separate; see the glitch planner before execution.')
  else if(done)custom=check('ready','Current-attempt completion is recorded separately from the account hardcore award. Retain the instructions for review.')
  else {
   checks.push(...preparation)
   const cp=checkpoints.find(c=>dataset.route.find(t=>t.id===c.stepId)?.checkpoint?.ruleIds.includes(rule.id))
   if(cp)custom=reviewedHistory(input,rule.id)&&cp.readiness==='missed'?check('unknown','Earlier gym confirmation needs continuity review; current save cannot prove the battle history.'):cp
   if(rule.setKey==='oak'&&rule.acquisitions?.length&&rule.id!==165606){
    checks.push(giftGate())
    const targets=ruleTargets(rule,input)
    if(!targets.length)checks.push(check('unknown','Record the branch selection before planning its acquisitions.'))
    for(const dex of targets){const a=acquisitions.targets.find(t=>t.dexNumber===dex);if(a&&!(a.registered.known&&a.registered.value))checks.push(...a.paths.map(p=>({readiness:p.readiness,reasons:p.reasons}))) }
   }
   switch(rule.id){
   case 108023:
    checks.push(predicate({kind:'event',flag:'EVENT_GOT_POKEDEX',value:true}))
    if(s?.ownedDex.known&&new Set(s.ownedDex.value).size>1)custom=event('EVENT_GOT_POKEBALLS_FROM_OAK').known?historyAfter(rule.id,'The initial gift window is closed after an additional registration.'):check('unknown','Additional species registered, but gift receipt event is unreadable; review early history.')
    break
   case 108020:checks.push(checklist(ruleEntries(rule.id)));break
   case 4409:checks.push(giftGate(),predicate({kind:'party-size',minimum:6,maximum:6}));break
   case 108024:case 108025:case 108037:case 108041:case 108066:case 108140:case 108052:case 108053:case 108174:
    checks.push(checklist(ruleEntries(rule.id)));break
   case 108027:checks.push(predicate({kind:'owned-count',minimum:30}));break
   case 108028:checks.push(predicate({kind:'owned-count',minimum:10}));break
   case 108044:checks.push(predicate({kind:'owned-count',minimum:50}));break
   case 108029:
    checks.push(checklist(areaEntries('anne').filter(e=>e.entry.kind==='trainer'||e.entry.kind==='pickup')))
    if(isEvent('EVENT_SS_ANNE_LEFT'))custom=areaEntries('anne').some(e=>(e.entry.kind==='trainer'||e.entry.kind==='pickup')&&e.completion.known&&!e.completion.value)?historyAfter(rule.id,'Ship departed with an observed incomplete optional checklist.'):check('unknown','Ship departed; unavailable checklist fields cannot establish past completion or failure.')
    break
   case 108138:
    checks.push(manual(historyKey(rule.id)))
    if(isEvent('EVENT_SS_ANNE_LEFT'))custom=check('unknown','Ship departed; no persistent conversation flag proves whether the passenger was spoken to. Review attempt-specific history.')
    break
   case 108030:
    checks.push(checklist(areaEntries('anne').filter(e=>e.entry.kind==='trainer'||e.entry.kind==='pickup')),manual(historyKey(108138)))
    break
   case 108039:
    checks.push(checklist(areaEntries('hideout').filter(e=>e.entry.ruleIds.includes(108039))))
    if(isEvent('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI'))custom=check('unknown','Giovanni is defeated; current pickup flags cannot establish the pre-Giovanni clearance ordering.')
    break
   case 108038:
    checks.push(manual('hideout:clear-before-giovanni'))
    break
   case 108040:
    checks.push(predicate({kind:'event',flag:'EVENT_BEAT_GHOST_MAROWAK',value:false}),predicate({kind:'item',rawItemId:51,minimum:1}),predicate({kind:'not',predicate:{kind:'item',rawItemId:72,minimum:1}}))
    if(isEvent('EVENT_BEAT_GHOST_MAROWAK'))custom=check('unknown','Ghost is resolved; its event cannot distinguish Doll use with Scope boxed. Review method history.')
    break
   case 108045:{
    checks.push(predicate({kind:'badge',mask:16,obtained:true}),predicate({kind:'event',flag:'EVENT_GOT_HM03',value:true}),predicate({kind:'move',moveId:57}),manual('safari:supplies-ready'))
    checks.push(s?.bag.known?check(s.bag.value.length<=9?'ready':'blocked','Reserve eleven free bag slots for the optional Safari sweep (HM03/Teeth collected earlier).'):check('unknown','Observe bag space for eleven optional Safari pickups.'))
    const optional=ruleEntries(108045)
    if(confirmed(input,'safari:prior-pickup'))custom=historyAfter(rule.id,'An optional Safari pickup was taken outside the intended single hunt.')
    else if(optional.some(e=>e.observed.known&&e.observed.value))checks.push(check('unknown','An optional Safari object is already collected; flags cannot prove whether it belongs to the same uninterrupted hunt.'))
    else if(optional.some(e=>!e.observed.known))checks.push(check('unknown','Observe all eleven optional pickup flags before starting the protected hunt.'))
    break
   }
   case 108047:
    checks.push(manual('safari:supplies-ready'),s?.currentBox.known?check(s.currentBox.value.pokemon.length<=10?'ready':'blocked','Keep at least ten slots in the active box for the ten-catch hunt.'):check('unknown','Observe active-box capacity before the ten-catch hunt.'));break
   case 108069:{
    const trainers=areaEntries('silph','trainer');const n=trainers.filter(e=>e.observed.known&&e.observed.value).length
    if(isEvent('EVENT_BEAT_SILPH_CO_RIVAL'))custom=check('unknown','Rival defeated; current trainer flags cannot reconstruct the count at arrival. Confirm arrival with at most one other victory.')
    else if(n>1)custom=event('EVENT_BEAT_SILPH_CO_RIVAL').known?historyAfter(rule.id,`${n} Silph trainers already defeated before unrecorded Rival arrival; maximum is one.`):check('unknown','Rival state unavailable; current excess trainer victories cannot establish the historical arrival count.')
    else checks.push(trainers.some(e=>!e.observed.known)?check('unknown','Observe all 30 trainer events before Rival arrival.'):check('ready',`${n} ordinary Silph trainers defeated; leave every trainer except the 5F lower guard untouched.`),predicate({kind:'item',rawItemId:48,minimum:1}))
    break
   }
   case 108051:{
    checks.push(manual(historyKey(108069)),checklist(ruleEntries(108051)))
    if(isEvent('EVENT_BEAT_SILPH_CO_GIOVANNI')&&areaEntries('silph','trainer').some(e=>e.completion.known&&!e.completion.value))custom=historyAfter(rule.id,'Giovanni removed an undefeated Silph trainer; later NPC hide flags do not rescue the battle.')
    else if(isEvent('EVENT_BEAT_SILPH_CO_GIOVANNI'))checks.push(check('unknown','Review the complete pre-Giovanni clearance history; late state cannot prove its order.'))
    break
   }
   case 108050:checks.push(manual(historyKey(108051)));break
   case 108056:{
    const trainers=areaEntries('gyms','trainer').filter(e=>e.entry.area==='CinnabarGym')
    if(trainers.some(e=>e.observed.known&&e.observed.value)||isEvent('EVENT_BEAT_BLAINE'))custom=combine([...preparation,check('unknown','Cinnabar trainer/leader flags are already set; they do not establish whether the quiz session succeeded beforehand.')])
    else if(trainers.some(e=>!e.observed.known))checks.push(check('unknown','Observe all seven Cinnabar trainer flags before the six quizzes.'))
    break
   }
   case 4422:case 108169:case 108170:case 108171:
    checks.push(predicate({kind:'badge',mask:255,obtained:true}),predicate({kind:'party-size',minimum:1,maximum:6}));break
   case 4410:case 165737:{
    const champion=dataset.rules.find(r=>r.id===165737)!
    checks.push(...champion.prerequisites.map(p=>predicate(p,champion)),predicate({kind:'badge',mask:255,obtained:true}))
    if(s?.ownedDex.known&&new Set(s.ownedDex.value).size!==123)checks.push(check('blocked','Enter the first canonical League clear with exactly the chosen 123-species collection.'))
    break
   }
   case 4421:case 108176:case 165738:{
    const champion=dataset.rules.find(r=>r.id===165737)!
    checks.push(...champion.prerequisites.map(p=>predicate(p,champion)),predicate({kind:'badge',mask:255,obtained:true}))
    const target=acquisitions.targets.find(t=>t.dexNumber===150)
    if(target)checks.push(...target.paths.map(p=>({readiness:p.readiness,reasons:p.reasons})))
    if(isEvent('EVENT_BEAT_MEWTWO'))custom=check('unknown','Mewtwo encounter resolved; confirm actual capture and non-Master-Ball method. Resolution alone cannot prove them.')
    break
   }
   case 4425:{
    const champion=dataset.rules.find(r=>r.id===165737)!
    checks.push(...champion.prerequisites.map(p=>predicate(p,champion)),predicate({kind:'owned',dexNumbers:[150]}))
    break
   }
   case 108141:checks.push(predicate({kind:'owned',dexNumbers:[23,24,43,44,45,56,57,58,59,123,125]}));break
   case 108175:
    checks.push(assess(flagFact(input,'objectFlags','TOGGLE_CERULEAN_CAVE_GUY'),'Cerulean Cave access observed.','Become Champion for Cave access.'),manual('cave:supplies-ready'))
    checks.push(s?.currentBox.known?check(s.currentBox.value.pokemon.length===0?'ready':'blocked','Select an empty active box before the fifteen-species Cave session.'):check('unknown','Observe empty active box before Cave session.'));break
   case 108365:case 108367:case 108368:
    checks.push(checklist(ruleEntries(rule.id)),check('unknown','Physical source checklist is available; final guide/trigger inclusion and historical exclusions require verification. This is not a decoded RA completion predicate.'));break
   }
   if(!checks.length&&!custom)checks.push(manual(`rule:${rule.id}:prepared`))
  }
  let result=custom??combine(checks,'unknown')
  if(!done)for(const cutoff of rule.cutoffs){
   if(predicate(cutoff.when,rule).readiness==='ready'){
    if(cutoff.when.kind==='badge')result=check('unknown','Leader defeated; current state cannot prove historical Oak collection or restricted battle compliance.')
    else if(cutoff.id==='ss-anne-departed')result=check('unknown','Departure is recorded; confirm the obligation history rather than inferring failure from departure alone.')
    else result=historyAfter(rule.id,cutoff.message)
   }
  }
  if(!rule.attemptPolicy.allowedKinds.includes(attempt.kind)&&rule.setKey!=='glitch')result=combine([result,check('blocked','Keep main/Oak work in the protected canonical attempt.')])
  if(!s&&!done)result=check('unknown','Import a supported save or record eligible attempt-specific history; all source instructions remain available.')
  const feed=project.accountProgress.find(p=>p.setKey===rule.setKey&&p.accountIdentity!==null&&p.accountIdentity===project.accountIdentity&&p.apiGameId===dataset.sets.find(t=>t.key===rule.setKey)?.apiGameId)
  const unlock=feed?.unlocks.find(u=>u.achievementId===rule.id)
  assessments.push({ruleId:rule.id,manualControls:controls,...result,hardcoreEarned:!!unlock,...(unlock?{earnedAt:unlock.earnedAt}:{}),manualEvidence:attempt.manualEvidence.filter(e=>e.ruleId===rule.id||e.key.startsWith(`rule:${rule.id}:`))})
  byId.set(rule.id,result)
 }
 const actions:PlannedAction[]=[]
 for(const step of [...dataset.route].sort((a,b)=>a.order-b.order)){
  const cp=step.id==='cinnabar'?byId.get(108056):checkpoints.find(c=>c.stepId===step.id)
  actions.push({id:`stage-${step.id}`,routeStepId:step.id,ruleIds:step.ruleIds,title:step.title,instructions:step.instructions,order:step.order*1000,readiness:cp?.readiness??'unknown',reasons:cp?.reasons??['Ordered route stage; inspect the concrete actions and deadline checklist below.']})
  // Within a stage, irreversible actions come after their prerequisite obligations.
  const priority=(id:number)=>step.id==='pallet'?({108020:0,108022:1,108021:2,108023:3}[id]??10):step.id==='anne'?({108138:0,108029:1,108027:2,108030:99}[id]??10):10
  const ids=[...step.ruleIds].sort((a,b)=>priority(a)-priority(b))
  // Celadon Rocket clearance precedes Giovanni; Silph clearance precedes its final Giovanni battle.
  for(const [prerequisite,consumer] of [[108039,108038],[108051,108050]] as const){
   const before=ids.indexOf(prerequisite),after=ids.indexOf(consumer)
   if(after>=0&&before>after){ids.splice(before,1);ids.splice(after,0,prerequisite)}
  }
  for(const [n,id] of ids.entries()){
   const rule=dataset.rules.find(r=>r.id===id);if(!rule)continue
   const result=byId.get(id)!
   const paths=ruleTargets(rule,input).flatMap(d=>acquisitions.targets.find(t=>t.dexNumber===d)?.paths??[])
   actions.push({id:`rule-${id}`,routeStepId:step.id,ruleIds:[id],title:rule.title,instructions:[...rule.instructions,...paths.flatMap(p=>p.instructions)],order:step.order*1000+n+1,...result})
  }
 }
 const reservations:Reservation[]=[]
 const obligations=[...dataset.route.flatMap(r=>r.preserves),...dataset.rules.flatMap(r=>r.preservation)]
 for(const o of obligations){
  if(reservations.some(r=>r.id===o.id)||eligibleCompletion(input,o.releaseAfterRuleId))continue
  reservations.push({id:o.id,consumingRuleId:o.consumingRuleId,releaseAfterRuleId:o.releaseAfterRuleId,description:o.description,readiness:o.predicate?predicate(o.predicate).readiness:'unknown'})
 }
 for(const [id,consumer,description] of [
  ['moon-stones',165711,'Reserve the four pre-Koga Moon Stones for four distinct evolutions: two Mt. Moon, Route 2 and Rocket Hideout. Do not spend a second stone on an already registered branch.'],
  ['doll',108040,'Keep one Poké Doll and box Silph Scope before the Tower ghost; retain the Doll until this method is confirmed.'],
  ['league50-team',108171,'Keep a viable party at level 50 or below until its first League entry; box Oak grinders and preserve birds before overleveling.'],
  ['branch-choices',4425,'Retain the selected fossil and record starter, fossil, Eevee and Dojo choices; register donors before evolution or trade.'],
  ['bird-catches',4420,'Preserve Articuno, Zapdos and Moltres for capture; resolution is not capture.'],
  ['mewtwo-capture',108176,'Preserve Mewtwo for capture without Master Ball after the canonical 123 species; do not KO it.'],
  ['snorlax-capture',4419,'Preserve at least one Snorlax for capture; register it before resolving both stationary encounters.'],
 ] as const){
  const owned=s?.ownedDex.known?s.ownedDex.value:[]
  const moonDone=id==='moon-stones'&&[31,34,36,40].every(n=>owned.includes(n))
  if(!moonDone&&!eligibleCompletion(input,consumer))reservations.push({id,consumingRuleId:consumer,releaseAfterRuleId:consumer,description,readiness:'unknown'})
 }
 for(const e of areaEntries('trades'))if(!(e.completion.known&&e.completion.value))reservations.push({id:`donor-${e.entry.id}`,consumingRuleId:108053,releaseAfterRuleId:108053,description:`Retain a donor instance for ${e.entry.title} at ${e.entry.area}; register it first.`,readiness:e.completion.known?'blocked':'unknown'})
 return {actions,checkpoints,achievements:assessments,reservations,areas,acquisitions,diagnostics:[...(attempt.diagnostics??[]),...dataset.manifest.runtimePrerequisites.filter(p=>p.status==='pending').map(p=>`${p.id}: ${p.description}`),'Current flags, manual history and account-wide hardcore awards are independent. Physical source mappings do not validate session triggers.',...project.accountProgress.filter(p=>p.stale).map(p=>`${p.setKey} hardcore progress is stale; last successful fetch: ${p.lastSuccessfulFetchAt??'never'}.`)]}
}
