import { useState } from 'preact/hooks'
import type { PlanInput, RunPlan } from '../model'
import type { Controller } from './controller'
import { FactText, History, ManualInput, Reasons, Sources } from './shared'
import { counterProgress } from '../planner/areas'
import { CounterLine } from './Achievements'
export function Areas({
  input,
  plan,
  controller,
}: {
  input: PlanInput
  plan: RunPlan
  controller: Controller
}) {
  const [area, setArea] = useState(plan.areas?.[0]?.id ?? ''),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [status, setStatus] = useState('all'),
    [counts, setCounts] = useState('all')
  const counterRules = input.dataset.rules.filter((r) => r.counter)
  const counterRule = counterRules.find((r) => String(r.id) === counts)
  const titleOf = (id: number) =>
    input.dataset.rules.find((r) => r.id === id)?.title ?? `#${id}`
  const entries = (plan.areas ?? [])
    .filter((a) => area === 'all' || a.id === area)
    .flatMap((a) => a.entries)
    .filter(
      (a) =>
        (kind === 'all' || a.entry.kind === kind) &&
        (!counterRule ||
          a.entry.ruleIds.includes(counterRule.id) ||
          !!a.entry.uncountedFor?.includes(counterRule.id)) &&
        `${a.entry.title} ${a.entry.area} ${a.entry.instructions.join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .filter(
      (a) =>
        status === 'all' ||
        (status === 'unknown' && !a.completion.known) ||
        (status === 'outstanding' &&
          a.completion.known &&
          !a.completion.value) ||
        (status === 'recorded' && a.completion.known && a.completion.value),
    )
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">Area checklist</p>
        <h1>Trainers, items and events</h1>
        <p>
          Everything the achievements need, area by area. Defeating a stationary
          Pokémon is not the same as catching it.
        </p>
      </div>
      <div class="filters">
        <label>
          Area
          <select value={area} onChange={(e) => setArea(e.currentTarget.value)}>
            <option value="all">All areas</option>
            {plan.areas?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Trainer, item, map, session"
          />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="all">All kinds</option>
            {[
              'trainer',
              'pickup',
              'door',
              'static',
              'gift',
              'trade',
              'session',
              'coin',
            ].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <option value="all">Everything</option>
            <option value="outstanding">Still to do</option>
            <option value="unknown">Can’t tell yet</option>
            <option value="recorded">Done</option>
          </select>
        </label>
        {counterRules.length > 0 && (
          <label>
            Counts toward
            <select
              value={counts}
              onChange={(e) => setCounts(e.currentTarget.value)}
            >
              <option value="all">Any achievement</option>
              {counterRules.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {r.title} (/{r.counter!.total})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {counterRule && (
        <CounterLine
          progress={counterProgress(counterRule, plan.areas ?? [])}
          rule={counterRule}
        />
      )}
      <p>{entries.length} shown</p>
      {entries.map((a) => (
        <details class="card" key={a.entry.id}>
          <summary>
            <strong>{a.entry.title}</strong>
            <span class="muted">
              {a.entry.area} · {a.entry.kind} ·{' '}
              {a.completion.known
                ? a.completion.value
                  ? 'done'
                  : 'still to do'
                : 'can’t tell yet'}
            </span>
          </summary>
          <p>
            <FactText fact={a.completion} yes="Done" no="Still to do" /> ·{' '}
            {a.evidence === 'save'
              ? 'from your save'
              : a.evidence === 'manual'
                ? 'from your mark'
                : 'not readable yet'}
          </p>
          <p>
            Save flag: <FactText fact={a.observed} yes="set" no="not set" />
          </p>
          {a.entry.ruleIds.some((id) => counterRules.some((r) => r.id === id)) && (
            <p>
              Counts toward:{' '}
              {a.entry.ruleIds
                .filter((id) => counterRules.some((r) => r.id === id))
                .map(titleOf)
                .join(', ')}
            </p>
          )}
          {a.entry.uncountedFor?.length ? (
            <p class="muted">
              Not counted toward {a.entry.uncountedFor.map(titleOf).join(', ')}{' '}
              (the guide’s sources say it does not move that counter); do it
              anyway if it serves another goal.
            </p>
          ) : null}
          {a.entry.deadline && (
            <p class="notice">Deadline: {a.entry.deadline}</p>
          )}
          {a.entry.deferredUntil && <p>Defer until: {a.entry.deferredUntil}</p>}
          <Reasons items={[...a.entry.instructions, ...a.reasons]} />
          <Sources urls={a.entry.sourceUrls} />
          <details>
            <summary>Mark it yourself</summary>
            <ManualInput
              controller={controller}
              control={{
                key: a.entry.manualKey,
                label: `Observed: ${a.entry.title}`,
                valueType: 'boolean',
                expected: true,
                scope: 'Attempt-specific area history',
              }}
            />
            <History
              records={a.manualEvidence}
              attempt={input.attempt}
              controller={controller}
            />
          </details>
        </details>
      ))}
      {!entries.length && (
        <p class="notice">
          Nothing matches. Change the filters to see the full checklist.
        </p>
      )}
    </>
  )
}
