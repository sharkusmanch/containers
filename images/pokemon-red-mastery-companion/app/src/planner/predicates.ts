import type { AchievementRule, Fact, FlagNamespace, PlanInput, PokemonObservation, Predicate, PredicateAssessment, Readiness } from '../model'
import { manualEvidenceIsEligible } from '../state/project'
export const unknownFact = (reason: string): Fact<boolean> => ({ known:false, reason })
export function flagFact(input: PlanInput, namespace: FlagNamespace, key: string): Fact<boolean> {
 const fact = input.attempt.snapshot?.[namespace]
 if (!fact?.known) return unknownFact(fact && !fact.known ? fact.reason : `Observe ${namespace} before assessing ${key}.`)
 const value = (fact.value as Record<string,boolean>)[key]
 return value === undefined ? unknownFact(`${key} is unavailable in ${namespace}.`) : { known:true,value }
}
export function manualFact(input: PlanInput, key: string): Fact<boolean | number | string> {
 const record = input.attempt.manualEvidence.filter(e=>e.key===key && manualEvidenceIsEligible(e,input.attempt)).at(-1)
 return record ? {known:true,value:record.value} : {known:false,reason:`Confirm ${key} in this attempt; absent or flagged history is unknown.`}
}
export function combine(checks: PredicateAssessment[], empty: Readiness = 'ready'): PredicateAssessment {
 const status: Readiness = checks.some(c=>c.readiness==='missed') ? 'missed' : checks.some(c=>c.readiness==='blocked') ? 'blocked' : checks.some(c=>c.readiness==='unknown') ? 'unknown' : checks.length ? 'ready' : empty
 return {readiness:status,reasons:[...new Set(checks.flatMap(c=>c.reasons))]}
}
export function assess(fact: Fact<boolean>, yes: string, no = yes): PredicateAssessment {
 return fact.known ? {readiness:fact.value?'ready':'blocked',reasons:[fact.value?yes:no]} : {readiness:'unknown',reasons:[fact.reason]}
}
/** Current held instances only; the active archived box is superseded by its live copy. */
export function heldPokemon(input: PlanInput): { pokemon: PokemonObservation[]; unknown: boolean } {
 const s=input.attempt.snapshot;if(!s)return {pokemon:[],unknown:true}
 const pokemon: PokemonObservation[]=[];let unknown=false
 if(s.party.known)pokemon.push(...s.party.value);else unknown=true
 if(s.currentBox.known)pokemon.push(...s.currentBox.value.pokemon);else unknown=true
 if(s.archivedBoxes.known){for(const b of s.archivedBoxes.value)if(!s.currentBox.known||s.currentBox.value.index!==b.index)pokemon.push(...b.pokemon)}else unknown=true
 if(s.daycare.known){if(s.daycare.value)pokemon.push(s.daycare.value)}else unknown=true
 return {pokemon,unknown:unknown||pokemon.some(p=>p.dexNumber===null)}
}
/** Explicit three-valued current-fact predicates. Ready means prerequisites, never a hardcore award. */
export function evaluatePredicate(p: Predicate, input: PlanInput, rule?: AchievementRule): PredicateAssessment {
 const s=input.attempt.snapshot
 const result=(value:boolean,reason:string):PredicateAssessment=>({readiness:value?'ready':'blocked',reasons:[reason]})
 const missing=(reason:string):PredicateAssessment=>({readiness:'unknown',reasons:[reason]})
 const from=<T>(fact: Fact<T>|undefined,test:(v:T)=>boolean,reason:string)=>fact?.known?result(test(fact.value),reason):missing(fact&&!fact.known?fact.reason:reason+' Observe the current save.')
 switch(p.kind){
 case 'all':return combine(p.predicates.map(x=>evaluatePredicate(x,input,rule)))
 case 'any':{const a=p.predicates.map(x=>evaluatePredicate(x,input,rule));return {readiness:a.some(x=>x.readiness==='ready')?'ready':a.some(x=>x.readiness==='unknown')?'unknown':'blocked',reasons:a.flatMap(x=>x.reasons)}}
 case 'not':{const a=evaluatePredicate(p.predicate,input,rule);return {readiness:a.readiness==='ready'?'blocked':a.readiness==='blocked'?'ready':a.readiness,reasons:a.reasons.map(r=>'Required absence: '+r)}}
 case 'manual':return from(manualFact(input,p.key),v=>v===(p.expected??true),`Attempt confirmation: ${p.key}.`)
 case 'attempt-kind':return result(p.allowed.includes(input.attempt.kind),`Use an attempt of kind ${p.allowed.join(' or ')}.`)
 case 'owned':return from(s?.ownedDex,d=>p.dexNumbers.filter(n=>d.includes(n)).length >= (p.minimum??p.dexNumbers.length),`Register Dex ${p.dexNumbers.join(', ')}; current ownership is independent of held instances.`)
 case 'owned-count':return from(s?.ownedDex,d=>new Set(d).size>=p.minimum,`Register at least ${p.minimum} legitimate species.`)
 case 'branch-owned':{
  const group=rule?.branches.find(g=>g.id===p.groupId)
  if(!group)return missing(`No branch definition for ${p.groupId}.`)
  if(group.choiceKey){const choice=input.attempt.branches[group.choiceKey];const option=group.options.find(o=>o.value===choice);return option?evaluatePredicate({kind:'owned',dexNumbers:option.dexNumbers},input,rule):missing(`Record the ${group.choiceKey} branch choice.`)}
  return from(s?.ownedDex,d=>group.options.filter(o=>o.dexNumbers.every(n=>d.includes(n))).length >= (group.requiredAll?group.options.length:group.minimumDistinct??1),`Register ${group.requiredAll?group.options.length:group.minimumDistinct??1} distinct alternatives from ${group.id}.`)
 }
 case 'event':return from(flagFact(input,'events',p.flag),v=>v===p.value,`${p.flag} must be ${p.value}.`)
 case 'badge':return from(s?.badgeMask,m=>((m&p.mask)===p.mask)===p.obtained,`${p.obtained?'Obtain':'Leave undefeated'} badge mask ${p.mask}.`)
 case 'battle-style':return from(s?.battleStyle,v=>v===p.value,`Select ${p.value} mode before entry.`)
 case 'party-size':return from(s?.party,v=>v.length>=p.minimum&&v.length<=p.maximum,`Prepare ${p.minimum===p.maximum?p.minimum:`${p.minimum}–${p.maximum}`} party members.`)
 case 'party-level':{
  if(!s?.party.known)return missing(s&&!s.party.known?s.party.reason:'Observe every party level.')
  if(!s.party.value.length)return result(false,'Prepare a nonempty party.')
  return combine(s.party.value.map(mon=>from(mon.level,v=>v<=p.maximum,`Box every party member above level ${p.maximum} before entering; boxed grinders are allowed.`)))
 }
 case 'party-species':{
  if(!s?.party.known)return missing(s&&!s.party.known?s.party.reason:'Observe every party species.')
  if(!s.party.value.length)return result(false,'Prepare a nonempty party.')
  return combine(s.party.value.map(mon=>mon.dexNumber===null?missing('Unreadable party species.'):result((!p.allowed.length||p.allowed.includes(mon.dexNumber))&&!(p.excluded??[]).includes(mon.dexNumber),`Allowed party pool: ${p.allowed.length?p.allowed.join(', '):'any legitimate species'}; excluded: ${(p.excluded??[]).join(', ')||'none'}.`)))
 }
 case 'item':return from(s?.bag,items=>{
  const found=items.filter(i=>i.rawItemId===p.rawItemId&&(p.position===undefined||i.position===p.position))
  return p.exactQuantity!==undefined?found.some(i=>i.quantity===p.exactQuantity):found.reduce((n,i)=>n+i.quantity,0)>=p.minimum
 },`Carry item ${p.rawItemId}${p.position!==undefined?` in bag slot ${p.position}`:''}, quantity ${p.exactQuantity??`at least ${p.minimum}`}.`)
 case 'move':{
  const held=heldPokemon(input)
  if(held.pokemon.some(mon=>mon.moves.known&&mon.moves.value.some(m=>m.id===p.moveId)))return result(true,`An owned carrier knows move ${p.moveId}; retrieve boxed/daycare carriers before travel.`)
  return held.unknown||held.pokemon.some(mon=>!mon.moves.known)?missing(`Carrier for move ${p.moveId} is unknown.`):result(false,`Obtain and retain a carrier for move ${p.moveId}.`)
 }
 case 'special':{
  if(!s?.party.known)return missing('Observe actual party Special stats.')
  if(s.party.value.some(mon=>mon.special.known&&mon.special.value===p.value))return result(true,`Measured party Special ${p.value}.`)
  return s.party.value.some(mon=>!mon.special.known)?missing('Some actual party Special stats are unreadable.'):result(false,`Measure actual party Special ${p.value}; never infer it from level.`)
 }
 case 'section-readable':{const f=s?.[p.section];return f&&typeof f==='object'&&'known'in f?f.known?result(true,`${p.section} readable.`):missing(`Unreadable ${p.section}.`):missing(`Unavailable ${p.section}.`)}
 }
}
