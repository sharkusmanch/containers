import { useState } from 'preact/hooks'
import type { AchievementRule, CounterProgress, GlitchPlan, PlanInput, RunPlan, SetKey } from '../model'
import type { Controller } from './controller'
import { Badge, History, ManualInput, Reasons, Sources } from './shared'
import { GlitchDetails } from './GlitchDetails'
import { counterProgress } from '../planner/areas'
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
  const notLoaded = input.project.accountIdentity
    ? 'Hardcore: not loaded yet'
    : 'Hardcore: not connected'
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
        <p class="eyebrow">Three sets · 234 achievements</p>
        <h1>Achievements</h1>
        <p>
          The status says whether your save looks ready. Your own marks are
          notes for you. Only a RetroAchievements hardcore unlock counts as
          earned.
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
            {known
              ? `${feed!.unlocks.length} / ${all.length}`
              : notLoaded}
          </span>
        </div>
        <p>{all.length} achievements</p>
        <p>
          {known
            ? `Hardcore unlocks · checked ${new Date(feed!.lastSuccessfulFetchAt!).toLocaleString()}${feed!.stale ? ' · latest check failed, showing the last good result' : ''}`
            : 'Hardcore unlocks are not loaded. Connect them in More.'}
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
          Show
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <option value="all">All achievements</option>
            <option value="ready">Ready</option>
            <option value="blocked">Not ready yet</option>
            <option value="unknown">Can’t tell yet</option>
            <option value="missed">May be missed</option>
            <option value="earned">Unlocked (hardcore)</option>
            <option value="history">Has your marks</option>
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
                    ? 'Unlocked (hardcore)'
                    : known
                      ? 'Not unlocked yet'
                      : notLoaded}
                </span>
                {a.manualEvidence.length ? (
                  <span>{a.manualEvidence.length} of your marks</span>
                ) : null}
              </span>
            </summary>
            <p class="objective">{r.objective}</p>
            <CounterLine progress={counterProgress(r, plan.areas ?? [])} rule={r} />
            <p>
              {(g?.auditStatus ?? r.auditStatus) === 'validated'
                ? 'Method checked against the game’s source code (not tested in-game)' : 'Method from published guides (not tested in-game)'}{' '}
              · {r.points} points · #{r.id}
            </p>
            {a.earnedAt && (
              <p>
                Unlocked in hardcore on {new Date(a.earnedAt).toLocaleString()}
                {feed?.stale ? ' (latest check failed)' : ''}
              </p>
            )}
            <Reasons items={g?.reasons ?? a.reasons} />
            <h3>How to do it</h3>
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
              <summary>Mark it yourself</summary>
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

/** Checklist progress only: save flags and the player's marks. The in-game RA counter is the authority. */
export function CounterLine({ progress, rule }: { progress: CounterProgress | null; rule: AchievementRule }) {
  if (!progress || !rule.counter) return null
  return (
    <p class="counter">
      Checklist: {progress.done} of {progress.total} {rule.counter.unit} done in
      this attempt (save flags and your marks)
      {progress.unknown ? ` · ${progress.unknown} can’t tell yet` : ''}
      {progress.uncounted
        ? ` · ${progress.uncounted} more listed to do anyway (not counted)`
        : ''}
      . {rule.counter.note}
    </p>
  )
}
