import { useState } from 'preact/hooks'
import type { GlitchPlan, PlanInput, RunPlan, SetKey } from '../model'
import type { Controller } from './controller'
import { Badge, History, ManualInput, Reasons, Sources } from './shared'
import { GlitchDetails } from './GlitchDetails'
const labels = { main: 'Main', oak: 'Professor Oak', glitch: 'Glitch Showcase' }
export function Achievements({
  input,
  plan,
  glitches,
  controller,
}: {
  input: PlanInput
  plan: RunPlan
  glitches: GlitchPlan
  controller: Controller
}) {
  const [set, setSet] = useState<SetKey>('main'),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all')
  const feed = input.project.accountProgress.find(
    (f) =>
      f.setKey === set && f.accountIdentity === input.project.accountIdentity,
  )
  const known = !!feed?.lastSuccessfulFetchAt
  const all = input.dataset.rules.filter((r) => r.setKey === set),
    rules = all
      .filter((r) =>
        `${r.title} ${r.objective} ${r.id}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .filter((r) => {
        const a = plan.achievements.find((a) => a.ruleId === r.id)!,
          g = glitches.methods.find((m) => m.ruleId === r.id)
        return (
          status === 'all' ||
          (status === 'earned' && a.hardcoreEarned) ||
          (status === 'history' && a.manualEvidence.length > 0) ||
          (g?.readiness ?? a.readiness) === status
        )
      })
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">Three sets · 234 objectives</p>
        <h1>Mastery, with evidence.</h1>
        <p>
          Current readiness helps you prepare. Manual history records your
          observations. Only attributed account feeds confirm hardcore awards.
        </p>
      </div>
      <div class="set-tabs" aria-label="Achievement sets">
        {input.dataset.sets.map((s) => (
          <button
            key={s.key}
            aria-pressed={set === s.key}
            onClick={() => {
              setSet(s.key)
              query && setQuery('')
              setStatus('all')
            }}
          >
            {labels[s.key]}
          </button>
        ))}
      </div>
      <section class="panel" aria-label={`${labels[set]} hardcore progress`}>
        <div class="section-heading">
          <h2>{labels[set]}</h2>
          <span class="stat">
            {known ? `${feed!.unlocks.length} / ${all.length}` : 'HC unknown'}
          </span>
        </div>
        <p>{all.length} achievements</p>
        <p>
          {known
            ? `Confirmed hardcore · last successful fetch ${feed!.lastSuccessfulFetchAt}${feed!.stale ? ' · stale, last good progress retained' : ''}`
            : 'Hardcore progress has not been synced successfully for this account and set.'}
        </p>
        {feed?.unavailableReason && (
          <p class="notice">{feed.unavailableReason}</p>
        )}
        <Sources
          urls={[input.dataset.sets.find((s) => s.key === set)!.sourceUrl]}
        />
      </section>
      <div class="filters">
        <label>
          Find an achievement
          <input
            type="search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Title, objective or ID"
          />
        </label>
        <label>
          Achievement evidence
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <option value="all">All objectives</option>
            <option value="ready">Ready</option>
            <option value="blocked">Blocked</option>
            <option value="unknown">Unknown readiness</option>
            <option value="missed">Missed</option>
            <option value="earned">Confirmed HC</option>
            <option value="history">Has manual history</option>
          </select>
        </label>
      </div>
      <p>{rules.length} shown</p>
      {rules.map((r) => {
        const a = plan.achievements.find((a) => a.ruleId === r.id)!,
          g = glitches.methods.find((m) => m.ruleId === r.id)
        return (
          <details class="card achievement" key={r.id}>
            <summary>
              <strong>{r.title}</strong>
              <span class="achievement-meta">
                <Badge status={g?.readiness ?? a.readiness} />
                <span>
                  {a.hardcoreEarned
                    ? 'HC confirmed'
                    : known
                      ? 'HC not confirmed'
                      : 'HC unknown'}
                </span>
                <span>{a.manualEvidence.length} history records</span>
              </span>
            </summary>
            <p class="objective">{r.objective}</p>
            <p>
              Knowledge: {g?.auditStatus ?? r.auditStatus} · {r.points} points ·
              #{r.id}
            </p>
            {a.earnedAt && (
              <p>
                Account HC earned at {a.earnedAt}
                {feed?.stale ? ' (stale feed)' : ''}
              </p>
            )}
            <Reasons items={g?.reasons ?? a.reasons} />
            <h3>Source procedure</h3>
            <Reasons items={g?.instructions ?? r.instructions} />
            <Sources urls={r.sourceUrls} />
            {g && (
              <GlitchDetails
                method={g}
                glitches={glitches}
                input={input}
                controller={controller}
              />
            )}
            <details>
              <summary>Record attempt history</summary>
              {a.manualControls?.map((c) => (
                <ManualInput key={c.key} controller={controller} control={c} />
              ))}
              <History
                records={g?.manualEvidence ?? a.manualEvidence}
                attempt={input.attempt}
                controller={controller}
              />
            </details>
          </details>
        )
      })}
      {!rules.length && (
        <p class="notice">
          No matching achievements. Change the filters to see the complete
          guide.
        </p>
      )}
    </>
  )
}
