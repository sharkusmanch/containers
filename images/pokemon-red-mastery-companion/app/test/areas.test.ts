import { describe, expect, it } from 'vitest'
import { dataset } from '../src/data/manifest'
import { validateDataset } from '../src/data/validate'
import visibleOracle from './fixtures/visible-pickup-source-oracle.json'
import { evaluatePredicate } from '../src/planner/predicates'
import { createProject } from '../src/state/project'
import type { PlanInput } from '../src/model'
import { known, pokemon, snapshot, unknown } from './planner-fixtures'
const entries=dataset.areas!.flatMap(a=>a.entries)
// Catch source alias mistakes, namespace conflation and incomplete field-disk/trade scopes.
describe('concrete Areas contract',()=>{
 it('matches every independently audited visible pickup identity and source coordinate',()=>{
  for(const p of visibleOracle){
   const e=entries.find(e=>e.id===`pickup-${p.objectFlag}`)!
   expect(e,p.objectFlag).toBeDefined();expect([e.x,e.y,e.rawItemId]).toEqual([p.x,p.y,p.rawItemId])
   expect(e.observation?.namespace).toBe('objectFlags')
  }
  expect(entries.filter(e=>e.kind==='pickup'&&e.observation?.namespace==='objectFlags')).toHaveLength(104)
  expect(entries.filter(e=>e.observation?.namespace==='hiddenItemFlags')).toHaveLength(52)
  expect(entries.filter(e=>e.observation?.namespace==='hiddenCoinFlags')).toHaveLength(12)
 })
 it('rejects dangling checklist rules/stages/flags instead of silently yielding unknown observations',()=>{
  const d=structuredClone(dataset),e=d.areas![0]!.entries[0]!
  e.ruleIds=[999999];e.routeStepId='missing';e.observation={namespace:'events',key:'MISSING',meaning:'bad'}
  const issues=validateDataset(d,'development')
  expect(issues.filter(i=>i.code==='unresolved-reference')).toHaveLength(3)
 })
 it('rejects ambiguous duplicate entry IDs and missing proof sources',()=>{
  const d=structuredClone(dataset),e=d.areas![0]!.entries[0]!
  e.sourceUrls=[];d.areas![1]!.entries.push(structuredClone(e))
  const issues=validateDataset(d,'development')
  expect(issues.some(i=>i.code==='duplicate-route'&&i.reference===e.id)).toBe(true)
  expect(issues.some(i=>i.code==='missing-source')).toBe(true)
 })
 it('keeps unmissable global trainers separate from erased optional gym, ship and Silph opportunities',()=>{
  for(const id of ['gyms','anne','silph'])expect(dataset.areas!.find(a=>a.id===id)!.entries.filter(e=>e.kind==='trainer'&&e.ruleIds.includes(108368))).toHaveLength(0)
  expect(entries.filter(e=>e.kind==='static'&&e.ruleIds.includes(108368))).toHaveLength(0)
  expect(entries.filter(e=>e.ruleIds.includes(108365)).map(e=>e.rawItemId)).not.toEqual(expect.arrayContaining([208,244,215,223,250]))
 })
})
describe('shared current fact predicates',()=>{
 const input=():PlanInput=>{const project=createProject('test');const attempt=project.attempts[0]!;attempt.snapshot=snapshot();return {project,attempt,dataset}}
 it('propagates unreadable Special rather than asserting a required measured stat is absent',()=>{
  const i=input();i.attempt.snapshot!.party=known([{...pokemon(1),special:unknown}])
  expect(evaluatePredicate({kind:'special',value:21,observed:true},i).readiness).toBe('unknown')
 })
 it('handles conjunction/disjunction/negation with unknown facts without inventing absence',()=>{
  const i=input();i.attempt.snapshot!.bag=unknown
  const unknownItem={kind:'item' as const,rawItemId:51,minimum:1}
  expect(evaluatePredicate({kind:'not',predicate:unknownItem},i).readiness).toBe('unknown')
  expect(evaluatePredicate({kind:'all',predicates:[unknownItem,{kind:'badge',mask:1,obtained:true}]},i).readiness).toBe('blocked')
  expect(evaluatePredicate({kind:'any',predicates:[unknownItem,{kind:'badge',mask:1,obtained:false}]},i).readiness).toBe('ready')
 })
})

it('places each leader reward at that leader’s protected canonical stage',()=>{
 // Independent leader/reward mapping: a reward cannot be scheduled during an earlier town visit.
 const leaderRewards=[['TM_BIDE','brock'],['TM_BUBBLEBEAM','misty'],['TM_TOXIC','koga'],['TM_MEGA_DRAIN','erika'],['TM_THUNDERBOLT','surge'],['TM_PSYWAVE','sabrina'],['TM_FIRE_BLAST','blaine'],['TM_FISSURE','giovanni']] as const
 for(const [reward,stage] of leaderRewards){
  const e=entries.find(e=>e.id===`disk-gift-${reward}`)!
  expect(e, reward).toBeDefined()
  expect(e.routeStepId,reward).toBe(stage)
 }
 const stages=leaderRewards.map(([reward])=>dataset.route.find(s=>s.id===entries.find(e=>e.id===`disk-gift-${reward}`)!.routeStepId)!)
 expect(stages.map(s=>s.checkpoint?.leader)).toEqual(['Brock','Misty','Koga','Erika','Lt. Surge','Sabrina','Blaine','Giovanni'])
 expect(stages.map(s=>s.order)).toEqual([...stages.map(s=>s.order)].sort((a,b)=>a-b))
})
