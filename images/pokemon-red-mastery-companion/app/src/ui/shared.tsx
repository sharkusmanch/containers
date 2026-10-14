import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type {
  Dataset,
  Fact,
  ManualControl,
  ManualEvidence,
  Attempt,
  Readiness,
} from '../model'
import type { Controller } from './controller'
import { manualEvidenceIsEligible } from '../state/project'
import { readinessLabel } from './status'
export function Badge({ status }: { status: Readiness | string }) {
  return <span class={`badge ${status}`}>{readinessLabel(status)}</span>
}
export function Reasons({ items }: { items: string[] }) {
  return items.length ? (
    <ul class="reasons">
      {[...new Set(items)].map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  ) : null
}
export function Sources({ urls }: { urls: string[] }) {
  return (
    <div class="sources">
      {urls.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noreferrer">
          Source {i + 1}
          <span class="sr-only"> (opens a new tab)</span> ↗
        </a>
      ))}
    </div>
  )
}
export function Panel({
  title,
  children,
}: {
  title: string
  children: ComponentChildren
}) {
  return (
    <section class="panel" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}
export const speciesName = (dataset: Dataset, n: number) =>
  dataset.game.species.find((s) => s.dexNumber === n)?.name ?? `#${n}`
export function SpeciesList({
  numbers,
  dataset,
}: {
  numbers: number[]
  dataset: Dataset
}) {
  return (
    <ul class="species-list">
      {numbers.map((n) => (
        <li key={n}>
          <span>#{String(n).padStart(3, '0')}</span> {speciesName(dataset, n)}
        </li>
      ))}
    </ul>
  )
}
export function FactText({
  fact,
  yes = 'Observed',
  no = 'Not observed',
}: {
  fact: Fact<boolean>
  yes?: string
  no?: string
}) {
  return (
    <span>
      {fact.known ? (fact.value ? yes : no) : `Unknown — ${fact.reason}`}
    </span>
  )
}
export function ManualInput({
  control,
  controller,
  observed,
}: {
  control: ManualControl
  controller: Controller
  observed?: Fact<boolean | number | string>
}) {
  const [value, setValue] = useState(String(control.expected)),
    [note, setNote] = useState('')
  const record = (v: boolean | number | string) =>
    controller.dispatch({
      type: 'record-manual',
      key: control.key,
      value: v,
      ruleId: control.ruleId,
      note: note.trim() || undefined,
    })
  return (
    <fieldset class="manual-input">
      <legend>{control.label}</legend>
      <small>
        {control.scope}. Your own mark — it never counts as a hardcore unlock.
      </small>
      {observed && (
        <p>
          {observed.known
            ? `Recorded: ${observed.value}`
            : `Unknown — ${observed.reason}`}
        </p>
      )}
      <label>
        Note (optional)
        <input
          value={note}
          onInput={(e) => setNote(e.currentTarget.value)}
          placeholder="Optional context"
        />
      </label>
      {control.valueType === 'boolean' ? (
        <div class="button-row">
          <button onClick={() => record(true)}>Confirm observed</button>
          <button class="quiet" onClick={() => record(false)}>
            Record not observed
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            record(control.valueType === 'number' ? Number(value) : value)
          }}
        >
          <label>
            {control.label}
            {control.valueType === 'number' ? (
              <input
                type="number"
                required
                value={value}
                onInput={(e) => setValue(e.currentTarget.value)}
              />
            ) : (
              <input
                type="text"
                required
                value={value}
                onInput={(e) => setValue(e.currentTarget.value)}
              />
            )}
          </label>
          <button>Record observation</button>
        </form>
      )}
    </fieldset>
  )
}
export function History({
  records,
  attempt,
  controller,
}: {
  records: ManualEvidence[]
  attempt: Attempt
  controller: Controller
}) {
  if (!records.length) return <p class="muted">No marks recorded yet.</p>
  return (
    <ul class="history">
      {records.map((e) => (
        <li key={e.id}>
          <strong>
            {manualEvidenceIsEligible(e, attempt)
              ? 'Active'
              : e.status === 'archived'
                ? 'Archived'
                : 'Needs a fresh check'}
          </strong>
          <p>
            {e.note ?? e.key} · {String(e.value)}
          </p>
          <small>Marked {new Date(e.recordedAt).toLocaleString()}</small>
          <div class="button-row">
            {e.status !== 'archived' && (
              <>
                <button
                  class="quiet"
                  onClick={() =>
                    controller.dispatch({
                      type: 'reconfirm-manual',
                      evidenceId: e.id,
                    })
                  }
                  disabled={e.key === 'glitch:encounter-setup'}
                >
                  Still true — keep it
                </button>
                <button
                  class="quiet"
                  onClick={() =>
                    controller.dispatch({
                      type: 'archive-manual',
                      evidenceId: e.id,
                    })
                  }
                >
                  Archive
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
