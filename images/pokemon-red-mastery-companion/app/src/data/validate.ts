import { canonicalAcquisitionIsEligible, canonicalPhaseForStep } from './acquisitions'
import type { Dataset, DatasetIssue, Predicate, BranchGroup, PreservationObligation } from '../model'

/** Development accepts sourced records; release requires independent validation evidence. */
export function validateDataset(dataset: Dataset, mode: 'development' | 'release'): DatasetIssue[] {
  const issues: DatasetIssue[] = []
  const add = (issue: DatasetIssue) => issues.push(issue)
  const ruleIds = new Set(dataset.rules.map(r => r.id))
  const routeIds = new Set(dataset.route.map(s => s.id))
  const speciesIds = new Set(dataset.game.species.map(s => s.dexNumber))
  const expected = new Map(dataset.sets.map(s => [s.key, new Set(s.expectedPublishedIds)]))
  const checkUrls = (urls: string[], affected: Pick<DatasetIssue, 'ruleId' | 'methodId'>) => {
    if (!urls.length || urls.some(url => !/^https:\/\/[^\s]+$/.test(url))) add({ code: 'missing-source', message: 'Provide usable HTTPS source URLs.', ...affected })
  }
  const checkSpecies = (ids: number[], affected: Pick<DatasetIssue, 'ruleId' | 'methodId'>) => {
    for (const id of ids) if (!speciesIds.has(id)) add({ code: 'unresolved-reference', reference: `dex:${id}`, message: `Unknown national Dex reference ${id}.`, ...affected })
  }
  const checkGroups = (groups: BranchGroup[], affected: Pick<DatasetIssue, 'ruleId' | 'methodId'>) => {
    for (const group of groups) for (const option of group.options) checkSpecies(option.dexNumbers, affected)
  }
  const checkPredicate = (p: Predicate, groups: BranchGroup[], affected: Pick<DatasetIssue, 'ruleId' | 'methodId'>): void => {
    if (p.kind === 'all' || p.kind === 'any') { p.predicates.forEach(child => checkPredicate(child, groups, affected)); return }
    if (p.kind === 'not') { checkPredicate(p.predicate, groups, affected); return }
    if (p.kind === 'owned') checkSpecies(p.dexNumbers, affected)
    if (p.kind === 'party-species') checkSpecies([...p.allowed, ...p.excluded ?? []], affected)
    if (p.kind === 'branch-owned' && !groups.some(g => g.id === p.groupId)) add({ code: 'unresolved-reference', reference: `branch:${p.groupId}`, message: 'Prerequisite refers to an absent branch group.', ...affected })
    if (p.kind === 'event' && dataset.game.eventFlags[p.flag] === undefined) add({ code: 'unresolved-reference', reference: `event:${p.flag}`, message: 'Unknown event flag.', ...affected })
  }
  const checkReservation = (p: PreservationObligation, affected: Pick<DatasetIssue, 'ruleId' | 'methodId'>) => {
    for (const id of [p.consumingRuleId, p.releaseAfterRuleId]) if (!ruleIds.has(id)) add({ code: 'unresolved-reference', reference: `rule:${id}`, message: 'Resource reservation has no published consuming/release rule.', ...affected })
  }
  for (const set of dataset.sets) {
    const seen = new Set<number>()
    for (const id of set.expectedPublishedIds) {
      if (seen.has(id)) add({ code: 'invalid-membership', ruleId: id, message: `Expected membership repeats ${id} in ${set.key}.` })
      seen.add(id)
      if (!dataset.rules.some(r => r.id === id && r.setKey === set.key)) add({ code: 'missing-rule', ruleId: id, message: `Published ${set.key} member ${id} has no rule.` })
    }
  }
  const seenRules = new Set<number>()
  for (const rule of dataset.rules) {
    const affected = { ruleId: rule.id }
    if (seenRules.has(rule.id)) add({ code: 'duplicate-rule', message: 'Achievement IDs must be globally unique.', ...affected })
    seenRules.add(rule.id)
    if (!expected.get(rule.setKey)?.has(rule.id)) add({ code: 'unpublished-rule', message: 'Rule is outside the declared published set membership.', ...affected })
    checkUrls(rule.sourceUrls, affected)
    if (!rule.instructions.length || rule.instructions.some(s => !s.trim())) add({ code: 'missing-guidance', message: 'Rule needs actionable original instructions.', ...affected })
    if (!rule.routeStepIds.length) add({ code: 'missing-placement', message: 'Rule needs a project route placement.', ...affected })
    if (!rule.evidence.length) add({ code: 'missing-evidence', message: 'Rule needs explicit evidence requirements.', ...affected })
    for (const id of rule.routeStepIds) if (!routeIds.has(id)) add({ code: 'unresolved-reference', reference: id, message: 'Rule refers to an absent route step.', ...affected })
    for (const path of rule.acquisitions ?? []) {
      const phase = canonicalPhaseForStep(rule.routeStepIds[0] ?? '') ?? path.phase
      if (path.phase !== phase || !canonicalAcquisitionIsEligible(path, phase)) add({ code: 'inaccessible-acquisition', message: `Acquisition for Dex ${path.targetDex} cannot execute before the ${path.phase} checkpoint.`, ...affected })
      checkSpecies([path.targetDex], affected)
    }
    checkGroups(rule.branches, affected)
    rule.prerequisites.forEach(p => checkPredicate(p, rule.branches, affected))
    rule.cutoffs.forEach(c => checkPredicate(c.when, rule.branches, affected))
    rule.preservation.forEach(p => checkReservation(p, affected))
    if (mode === 'release') {
      if (rule.auditStatus !== 'validated') add({ code: 'unvalidated-rule', message: 'Sourced rule has not passed its owning validation task.', ...affected })
      else if (!rule.validationEvidence?.length) add({ code: 'missing-validation-evidence', message: 'Validated status requires recorded independent evidence.', ...affected })
    }
  }
  const seenRoutes = new Set<string>()
  for (const step of dataset.route) {
    if (seenRoutes.has(step.id)) add({ code: 'duplicate-route', reference: step.id, message: 'Route step IDs must be unique.' })
    seenRoutes.add(step.id)
    for (const id of step.ruleIds) if (!ruleIds.has(id)) add({ code: 'unresolved-reference', ruleId: id, reference: step.id, message: 'Route refers to an absent rule.' })
    for (const id of step.afterStepIds ?? []) if (!routeIds.has(id)) add({ code: 'unresolved-reference', reference: id, message: 'Route ordering refers to an absent step.' })
    if (step.checkpoint) {
      checkSpecies(step.checkpoint.requiredDex, {})
      checkGroups(step.checkpoint.branchGroups, {})
      for (const id of step.checkpoint.ruleIds) if (!ruleIds.has(id)) add({ code: 'unresolved-reference', ruleId: id, reference: step.id, message: 'Checkpoint refers to an absent rule.' })
    }
    step.prerequisites.forEach(p => checkPredicate(p, step.checkpoint?.branchGroups ?? [], {}))
    step.preserves.forEach(p => checkReservation(p, {}))
  }
  const seenEntries = new Set<string>()
  const seenAreas = new Set<string>()
  for (const area of dataset.areas ?? []) {
    if (seenAreas.has(area.id)) add({ code:'duplicate-route', reference:area.id, message:'Area IDs must be unique.' })
    seenAreas.add(area.id)
    for (const entry of area.entries) {
      if (seenEntries.has(entry.id)) add({ code:'duplicate-route', reference:entry.id, message:'Checklist entry IDs must be globally unique.' })
      seenEntries.add(entry.id)
      checkUrls(entry.sourceUrls,{})
      if (!routeIds.has(entry.routeStepId)) add({ code:'unresolved-reference', reference:entry.routeStepId, message:'Checklist refers to absent route stage.' })
      for (const id of entry.ruleIds) if (!ruleIds.has(id)) add({ code:'unresolved-reference',ruleId:id,reference:entry.id,message:'Checklist refers to absent rule.' })
      const obs=entry.observation
      if (obs?.namespace==='events' && dataset.game.eventFlags[obs.key]===undefined) add({code:'unresolved-reference',reference:obs.key,message:'Checklist event flag does not exist.'})
      if (obs?.namespace==='objectFlags' && dataset.game.objectFlags[obs.key]===undefined) add({code:'unresolved-reference',reference:obs.key,message:'Checklist object flag does not exist.'})
      for (const event of [entry.spawnEvent,entry.invalidatedByEvent]) if (event && dataset.game.eventFlags[event]===undefined) add({code:'unresolved-reference',reference:event,message:'Checklist proof guard does not exist.'})
      if (!entry.manualKey || !entry.title) add({code:'missing-guidance',reference:entry.id,message:'Checklist needs a label and explicit manual evidence key.'})
    }
  }
  const seenMethods = new Set<string>()
  for (const method of dataset.glitches) {
    const affected = { methodId: method.id }
    if (seenMethods.has(method.id)) add({ code: 'duplicate-method', message: 'Glitch method IDs must be unique.', ...affected })
    seenMethods.add(method.id)
    if (!ruleIds.has(method.ruleId)) add({ code: 'unresolved-reference', reference: `rule:${method.ruleId}`, message: 'Glitch method has no published rule.', ...affected })
    checkUrls(method.sourceUrls, affected)
    checkGroups(method.branches, affected)
    method.prerequisites.forEach(p => checkPredicate(p, method.branches, affected))
    if (!method.instructions.length) add({ code: 'missing-guidance', message: 'Method needs instructions.', ...affected })
    if (!method.evidence.length) add({ code: 'missing-evidence', message: 'Method needs evidence requirements.', ...affected })
    if (mode === 'release') {
      if (method.auditStatus !== 'validated') add({ code: 'unvalidated-method', message: 'Candidate method needs target-core validation.', ...affected })
      else if (!method.validationEvidence?.length) add({ code: 'missing-validation-evidence', message: 'Validated method requires recorded independent evidence.', ...affected })
    }
  }
  if (mode === 'release') for (const prerequisite of dataset.manifest.runtimePrerequisites) if (prerequisite.status !== 'verified') add({ code: 'runtime-prerequisite', reference: prerequisite.id, message: prerequisite.description })
  return issues
}
