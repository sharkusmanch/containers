import { expect, it } from 'vitest'
import {
  manualControlsForRule,
  suggestedStage,
  heldSummary,
} from '../src/planner/display'
import { dataset } from '../src/data/manifest'
import { createProject, activeAttempt } from '../src/state/project'
import { planRun } from '../src/planner/route'
import { reduceProject } from '../src/state/reducer'
import { serializeProject, restoreProject } from '../src/state/persist'
import { snapshot, unknown } from './planner-fixtures'
it('manual descriptors exclude obsolete shared encounter observations and label scope', () => {
  const m = dataset.rules.find((r) => r.id === 57642)!,
    controls = manualControlsForRule(m)
  expect(controls.some((c) => c.key === 'glitch:physically-isolated')).toBe(
    true,
  )
  expect(controls.some((c) => c.key === 'glitch:transform-confirmed')).toBe(
    false,
  )
  expect(controls.every((c) => c.label && c.scope)).toBe(true)
})
it('stage suggestion and partial storage preserve unknown and selected route access', () => {
  const project = createProject(),
    attempt = activeAttempt(project)
  attempt.snapshot = snapshot([1])
  attempt.snapshot.events = {
    known: true,
    value: { EVENT_GOT_POKEBALLS_FROM_OAK: true },
  }
  attempt.snapshot.archivedBoxes = unknown
  const input = { project, attempt, dataset }
  expect(suggestedStage(input)).toBe('brock')
  expect(heldSummary(attempt.snapshot, 25)).toMatch(/unknown/i)
  const rules = planRun(input).achievements
  expect(
    rules
      .find((r) => r.ruleId === 108045)
      ?.manualControls?.some((c) => c.key === 'safari:supplies-ready'),
  ).toBe(true)
})
it('anonymous projects persist and identity changes clear feeds while keeping attempts/history', () => {
  let p = createProject()
  expect(restoreProject(serializeProject(p)).ok).toBe(true)
  p = reduceProject(p, { type: 'record-manual', key: 'history', value: true })
  const attempts = p.attempts
  p = reduceProject(p, { type: 'set-account-identity', identity: 'red' })
  p = reduceProject(p, {
    type: 'hardcore-result',
    result: {
      failures: [],
      progress: [
        {
          setKey: 'main',
          apiGameId: 724,
          accountIdentity: 'red',
          lastSuccessfulFetchAt: null,
          stale: true,
          unlocks: [],
        },
      ],
    },
  })
  p = reduceProject(p, { type: 'set-account-identity', identity: 'blue' })
  expect(p.accountProgress).toEqual([])
  expect(p.attempts).toBe(attempts)
  p = reduceProject(p, { type: 'set-account-identity', identity: '  ' })
  expect(p.accountIdentity).toBeNull()
})

it('cross-rule history controls name and attribute the prerequisite rule', () => {
  const project = createProject(),
    attempt = activeAttempt(project),
    plan = planRun({ project, attempt, dataset })
  const passenger = plan.achievements
    .find((a) => a.ruleId === 108030)!
    .manualControls!.find((c) => c.key === 'rule:108138:completed')!
  expect(passenger.ruleId).toBe(108138)
  expect(passenger.label).toContain(
    dataset.rules.find((r) => r.id === 108138)!.title,
  )
})

it('exposes attributed failure controls that actually mark the known missed route obligations', () => {
  for (const [id, key] of [[108040, 'ghost-defeated-without-doll'], [108056, 'cinnabar-trainer-before-quizzes']] as const) {
    let project = createProject()
    project.attempts[0]!.snapshot = snapshot()
    const control = manualControlsForRule(dataset.rules.find((r) => r.id === id)!).find((c) => c.key === key)
    expect(control).toMatchObject({ key, expected: true, valueType: 'boolean', ruleId: id, scope: 'Attempt-specific history' })
    expect(control!.label).toMatch(/^Failure observation:/)
    project = reduceProject(project, { type: 'record-manual', key: control!.key, value: control!.expected, ruleId: control!.ruleId })
    const plan = planRun({ project, attempt: activeAttempt(project), dataset })
    expect(plan.achievements.find((a) => a.ruleId === id)?.readiness).toBe('missed')
  }
})
it('provides one Safari failure observation and deduplicates shared keys with cutoff values/types', () => {
  const safari = manualControlsForRule(dataset.rules.find((r) => r.id === 108045)!)
  const failures = safari.filter((c) => c.label.startsWith('Failure observation:'))
  expect(failures).toHaveLength(1)
  expect(failures[0]?.key).toBe('safari:prior-pickup')
  const base = dataset.rules.find((r) => r.id === 108056)!
  const controls = manualControlsForRule({ ...base,
    prerequisites: [{ kind: 'manual', key: 'shared', expected: false }],
    evidence: [...base.evidence, { kind: 'manual', key: 'shared', description: 'Shared observation' }],
    cutoffs: [{ id: 'composite', message: 'Observed session failure.', when: { kind: 'all', predicates: [
      { kind: 'manual', key: 'shared', expected: false },
      { kind: 'manual', key: 'count', expected: 2 },
      { kind: 'manual', key: 'phase', expected: 'interrupted' },
      { kind: 'manual', key: 'glitch:successful-growls', expected: 6 },
    ] } }],
  })
  expect(controls.filter((c) => c.key === 'shared')).toHaveLength(1)
  expect(controls.find((c) => c.key === 'shared')).toMatchObject({ expected: false, valueType: 'boolean', ruleId: 108056 })
  expect(controls.find((c) => c.key === 'count')).toMatchObject({ expected: 2, valueType: 'number' })
  expect(controls.find((c) => c.key === 'phase')).toMatchObject({ expected: 'interrupted', valueType: 'string' })
  expect(controls.filter((c) => ['shared', 'count', 'phase'].includes(c.key)).every((c) => c.label.startsWith('Failure observation:'))).toBe(true)
  expect(controls.some((c) => c.key === 'glitch:successful-growls')).toBe(false)
})
