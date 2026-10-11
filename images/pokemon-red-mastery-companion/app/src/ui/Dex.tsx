import { useMemo, useState } from 'preact/hooks'
import type { PlanInput } from '../model'
import { planAcquisitions } from '../planner/acquisition'
import { heldSummary } from '../planner/display'
import { Badge, Reasons, Sources } from './shared'
export function Dex({ input }: { input: PlanInput }) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all')
  const acquisitions = useMemo(
    () =>
      planAcquisitions(
        input.attempt.snapshot,
        input.dataset.game.species.map((s) => s.dexNumber),
        input.dataset,
      ),
    [input.attempt.snapshot, input.dataset],
  )
  const species = input.dataset.game.species
    .filter((s) =>
      `${s.name} ${s.dexNumber}`.toLowerCase().includes(query.toLowerCase()),
    )
    .filter((s) => {
      const a = acquisitions.targets.find((t) => t.dexNumber === s.dexNumber)
      return (
        filter === 'all' ||
        (filter === 'registered' &&
          a?.registered.known &&
          a.registered.value) ||
        (filter === 'missing' && a?.registered.known && !a.registered.value) ||
        (filter === 'unknown' && !a?.registered.known)
      )
    })
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">The complete 151</p>
        <h1>Dex & acquisition</h1>
        <p>
          Registration survives an evolution or trade. A registered species is
          not necessarily held now.
        </p>
      </div>
      <div class="filters">
        <label>
          Find a species
          <input
            type="search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Name or Dex number"
          />
        </label>
        <label>
          Dex status
          <select
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          >
            <option value="all">All species</option>
            <option value="registered">Registered</option>
            <option value="missing">Not registered</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      </div>
      <p>{species.length} species</p>
      <div class="dex-grid">
        {species.map((s) => {
          const target = acquisitions.targets.find(
              (t) => t.dexNumber === s.dexNumber,
            )!,
            rules = input.dataset.rules.filter((r) =>
              r.acquisitions?.some((a) => a.targetDex === s.dexNumber),
            )
          const glitches = input.dataset.glitches.filter((g) =>
            g.collectionTargets?.some((t) => t.dexNumber === s.dexNumber),
          )
          return (
            <details class="card dex-entry" key={s.dexNumber}>
              <summary>
                <span class="dex-number">
                  #{String(s.dexNumber).padStart(3, '0')}
                </span>
                <strong>{s.name}</strong>
                <span class="muted">
                  {target.registered.known
                    ? target.registered.value
                      ? 'Registered'
                      : 'Not registered'
                    : 'Registration unknown'}
                </span>
              </summary>
              <p>{heldSummary(input.attempt.snapshot, s.dexNumber)}</p>
              <h3>Current acquisition</h3>
              {target.paths.length ? (
                target.paths.map((p, i) => (
                  <div key={i}>
                    <Badge status={p.readiness} />
                    <Reasons items={p.instructions} />
                    <Reasons items={p.reasons} />
                  </div>
                ))
              ) : (
                <p>A held instance is already observed.</p>
              )}
              <details>
                <summary>Canonical and later source guidance</summary>
                {rules.map((r) => (
                  <div key={r.id}>
                    <h4>{r.title}</h4>
                    <Reasons items={r.instructions} />
                    <Sources urls={r.sourceUrls} />
                  </div>
                ))}
                {!rules.length && (
                  <p>
                    No ordinary canonical acquisition is documented for this
                    species. Consult the sourced collection methods;
                    availability is not inferred.
                  </p>
                )}
                {glitches.map((g) => (
                  <div key={g.id}>
                    <p>
                      {g.title} · {g.auditStatus} · runtime validation pending
                    </p>
                    {g.collectionTargets
                      ?.filter((t) => t.dexNumber === s.dexNumber)
                      .map((t) => (
                        <p key={t.dexNumber}>
                          Required donor Special {t.special}. {t.followUp}
                        </p>
                      ))}
                    <Sources urls={g.sourceUrls} />
                  </div>
                ))}
                <Sources urls={s.sourceUrls} />
              </details>
            </details>
          )
        })}
      </div>
      <details class="panel">
        <summary>Storage and acquisition diagnostics</summary>
        <Reasons items={acquisitions.diagnostics} />
      </details>
    </>
  )
}
