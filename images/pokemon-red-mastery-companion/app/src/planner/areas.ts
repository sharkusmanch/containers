import type { AchievementRule, AreaAssessment, AreaEntryAssessment, CounterProgress, PlanInput } from '../model'
import { flagFact, manualFact, unknownFact } from './predicates'
export function assessAreas(input: PlanInput): AreaAssessment[] {
 return (input.dataset.areas??[]).map(area=>({id:area.id,title:area.title,entries:area.entries.map(entry=>{
  const observed=entry.observation?flagFact(input,entry.observation.namespace,entry.observation.key):unknownFact('No persistent source flag establishes this history.')
  const manualEvidence=input.attempt.manualEvidence.filter(e=>e.key===entry.manualKey)
  const manual=manualFact(input,entry.manualKey)
  const a:AreaEntryAssessment={entry,observed,completion:observed,evidence:observed.known?'save':'unknown',manualEvidence,reasons:[entry.observation?.meaning??'Requires attempt-specific history.']}
  if(entry.proof==='manual'){a.completion=unknownFact(a.reasons[0]!);a.evidence='unknown'}
  if(entry.proof==='spawned'){
   const spawned=flagFact(input,'events',entry.spawnEvent!)
   if(!spawned.known||!spawned.value){a.completion=unknownFact('Initially hidden spawn: OFF alone cannot establish receipt.');a.evidence='unknown'}
  }
  if(entry.proof==='trainer-before-leader'){
   const leader=flagFact(input,'events',entry.invalidatedByEvent!)
   if(observed.known&&observed.value&&(!leader.known||leader.value)){a.completion=unknownFact('Leader/master can set an unfought trainer flag; record the actual battle history.');a.evidence='unknown'}
  }
  // Static completion is explicitly resolution, not capture. Consumers must not reinterpret it.
  if(entry.proof==='resolution')a.reasons.push('Resolved does not establish capture; check method history for capture awards.')
  if(manual.known&&typeof manual.value==='boolean'){a.completion={known:true,value:manual.value};a.evidence='manual'}
  if(!a.completion.known)a.reasons.push(a.completion.reason)
  return a
 })}))
}
/** Counter rules count only entries listing the rule; uncountedFor extras are reported separately and never added. */
export function counterProgress(rule: AchievementRule, areas: AreaAssessment[]): CounterProgress | null {
 if (!rule.counter) return null
 const all = areas.flatMap(a => a.entries)
 const listed = all.filter(a => a.entry.ruleIds.includes(rule.id))
 const done = listed.filter(a => a.completion.known && a.completion.value).length
 const unknown = listed.filter(a => !a.completion.known).length
 return { ruleId: rule.id, total: rule.counter.total, listed: listed.length, done, unknown, outstanding: listed.length - done - unknown,
  uncounted: all.filter(a => a.entry.uncountedFor?.includes(rule.id)).length }
}
