import { useState } from 'preact/hooks'
import type { PlanInput, RunPlan } from '../model'
import type { Controller } from './controller'
import { FactText, History, ManualInput, Reasons, Sources } from './shared'
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
    [status, setStatus] = useState('all')
  const entries = (plan.areas ?? [])
    .filter((a) => area === 'all' || a.id === area)
    .flatMap((a) => a.entries)
    .filter(
      (a) =>
        (kind === 'all' || a.entry.kind === kind) &&
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
        <p class="eyebrow">Area field notes</p>
        <h1>Clear the right obligations.</h1>
        <p>
          Individual battles, pickups and session history. A resolved encounter
          does not establish capture.
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
          Find an obligation
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
          Evidence status
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <option value="all">All evidence</option>
            <option value="outstanding">Observed outstanding</option>
            <option value="unknown">Unknown</option>
            <option value="recorded">Recorded</option>
          </select>
        </label>
      </div>
      <p>{entries.length} obligations match</p>
      {entries.map((a) => (
        <details class="card" key={a.entry.id}>
          <summary>
            <strong>{a.entry.title}</strong>
            <span class="muted">
              {a.entry.area} · {a.entry.kind} ·{' '}
              {a.completion.known
                ? a.completion.value
                  ? 'recorded'
                  : 'outstanding'
                : 'unknown'}
            </span>
          </summary>
          <p>
            <FactText
              fact={a.completion}
              yes="Obligation recorded"
              no="Obligation outstanding"
            />{' '}
            · {a.evidence} evidence
          </p>
          <p>
            Literal source observation: <FactText fact={a.observed} />
          </p>
          {a.entry.deadline && (
            <p class="notice">Deadline: {a.entry.deadline}</p>
          )}
          {a.entry.deferredUntil && <p>Defer until: {a.entry.deferredUntil}</p>}
          <Reasons items={[...a.entry.instructions, ...a.reasons]} />
          <Sources urls={a.entry.sourceUrls} />
          <details>
            <summary>Record attempt history</summary>
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
          No obligations match. Change the filters to explore the full
          checklist.
        </p>
      )}
    </>
  )
}
