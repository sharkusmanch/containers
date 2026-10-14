import { useState } from 'preact/hooks'
import type { BranchChoices, PlanInput, RunPlan } from '../model'
type Starter = NonNullable<BranchChoices['starter']>
import { Badge, Panel, Reasons, SpeciesList, speciesName } from './shared'
import {
  earlierOpen,
  homeStage,
  nextActions,
  possiblyMissed,
  upcomingCheckpoint,
} from './home'
import { countBits } from './status'

/** "ROUTE_1" / "MtMoon1F" → "Route 1" / "Mt Moon 1F" for display only. */
export function prettyArea(area: string): string {
  const words = area.includes('_')
    ? area.split('_')
    : area
        .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
        .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
        .split(' ')
  return words
    .map((w) => (/^B?\d+F?$/.test(w) ? w : w[0]! + w.slice(1).toLowerCase()))
    .join(' ')
}

export function Next({
  input,
  plan,
  onAreas,
  onMore,
  guideUrl,
  onStarter,
}: {
  input: PlanInput
  plan: RunPlan
  onAreas: () => void
  onMore: () => void
  guideUrl?: string
  onStarter: (starter: Starter) => void
}) {
  const home = homeStage(input, plan)
  const [chosen, setChosen] = useState(''),
    stageId = chosen || home
  const stage =
    input.dataset.route.find((s) => s.id === stageId) ?? input.dataset.route[0]!
  // The quiz visit enters Blaine’s gym one stage before the leader battle.
  const checkpointStage =
    stage.id === 'cinnabar'
      ? input.dataset.route.find((s) => s.id === 'blaine')
      : stage
  const checkpoint = plan.checkpoints.find(
    (c) => c.stepId === checkpointStage?.id,
  )
  const obligations = plan.areas
    ?.flatMap((a) => a.entries)
    .filter((a) => a.entry.routeStepId === stage.id && a.entry.deadline)
  const canonical = input.attempt.kind === 'canonical'
  const homeStep = input.dataset.route.find((s) => s.id === home)
  const todo = canonical ? nextActions(input, plan, home) : []
  const deadline = canonical ? upcomingCheckpoint(input, plan, home) : undefined
  const warnings = plan.areas
    ?.flatMap((a) => a.entries)
    .filter(
      (a) =>
        a.entry.routeStepId === home &&
        a.entry.deadline &&
        !(a.completion.known && a.completion.value),
    )
  const missed = canonical ? possiblyMissed(input, plan, home) : []
  const earlier = canonical ? earlierOpen(input, plan, home) : []
  const s = input.attempt.snapshot
  const missingBranch = canonical && !input.attempt.branches.starter
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">Next up</p>
        <h1>What to do next</h1>
        <p>
          {canonical
            ? `Main + Professor Oak run · you are around ${homeStep?.title ?? 'the start'}.`
            : 'This is a separate attempt; the main route below is for reference.'}
        </p>
      </div>
      <section class="glance" aria-label="Progress at a glance">
        <div>
          <strong>
            {s?.badgeMask.known ? `${countBits(s.badgeMask.value)} / 8` : '—'}
          </strong>
          <span>Badges</span>
        </div>
        <div>
          <strong>{s?.ownedDex.known ? s.ownedDex.value.length : '—'}</strong>
          <span>Pokémon caught</span>
        </div>
        {(['main', 'oak'] as const).map((key) => {
          const feed = input.project.accountProgress.find(
            (f) =>
              f.setKey === key &&
              f.accountIdentity === input.project.accountIdentity,
          )
          const total = input.dataset.rules.filter(
            (r) => r.setKey === key,
          ).length
          return (
            <div key={key}>
              <strong>
                {feed?.lastSuccessfulFetchAt
                  ? `${feed.unlocks.length} / ${total}`
                  : '—'}
              </strong>
              <span>{key === 'main' ? 'Main' : 'Oak'} unlocks</span>
            </div>
          )
        })}
      </section>
      {!input.project.accountProgress.some((f) => f.lastSuccessfulFetchAt) && (
        <p class="muted">
          {input.project.accountIdentity
            ? 'Hardcore unlocks are not loaded yet (More, Hardcore progress).'
            : 'Hardcore unlocks are not connected yet (More, Hardcore progress).'}
        </p>
      )}
      {!s && (
        <p class="notice">
          No save loaded yet, so the list below starts at the beginning.{' '}
          <button class="link" onClick={onMore}>
            Load your save in More
          </button>
        </p>
      )}
      {missingBranch && (
        <div class="notice">
          <label>
            Which starter did you pick? The catch lists depend on it.
            <select
              value=""
              onChange={(e) =>
                e.currentTarget.value &&
                onStarter(e.currentTarget.value as Starter)
              }
            >
              <option value="">Choose your starter</option>
              <option value="bulbasaur">Bulbasaur</option>
              <option value="charmander">Charmander</option>
              <option value="squirtle">Squirtle</option>
            </select>
          </label>
          <p class="muted">
            Fossil, Eevee and Dojo choices are under More, Advanced, Run
            choices.
          </p>
        </div>
      )}
      {guideUrl && (
        <p>
          <a href={guideUrl} target="_blank" rel="noreferrer">
            Open the full written guide ↗
          </a>
        </p>
      )}
      {warnings?.length ? (
        <section class="panel warning-panel" aria-label="Don't miss">
          <h2>Don’t miss before you leave</h2>
          <Reasons
            items={warnings.map((o) => `${o.entry.title}: ${o.entry.deadline}`)}
          />
          <button class="quiet" onClick={onAreas}>
            Open the area checklist
          </button>
        </section>
      ) : null}
      {canonical && (
        <section class="panel" aria-label="Do next">
          <h2>Do next</h2>
          {todo.length ? (
            <ol class="todo">
              {todo.map(({ action, step }) => (
                <li key={action.id}>
                  <div class="section-heading">
                    <h3>{action.title}</h3>
                    <Badge status={action.readiness} />
                  </div>
                  <p class="muted">Achievement · {step.title}</p>
                  <p>{action.instructions[0]}</p>
                  <details>
                    <summary>Details and why this status</summary>
                    <Reasons items={action.instructions.slice(1)} />
                    <Reasons items={action.reasons} />
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p>Nothing left on the main route.</p>
          )}
          <p class="muted">
            Status comes from your save and your own marks. Only a
            RetroAchievements hardcore unlock counts as earned.
          </p>
        </section>
      )}
      {deadline && (
        <section class="panel deadline-panel" aria-label="Before the next gym">
          <div class="section-heading">
            <h2>Before you beat {deadline.assessment.leader}</h2>
            <Badge status={deadline.assessment.readiness} />
          </div>
          <p>
            Professor Oak Challenge: this guide plans for{' '}
            <strong>exactly {deadline.assessment.requiredCount} species</strong>{' '}
            registered —{' '}
            {deadline.assessment.ownedCount.known
              ? `you have ${deadline.assessment.ownedCount.value}.`
              : 'load your save to see your count.'}{' '}
            Whole party at level {deadline.step.checkpoint!.levelCap} or below,
            Set mode on, no items in the gym battle.
          </p>
          {deadline.assessment.missingDex.length ? (
            <>
              <h3>Still to catch</h3>
              <ul class="species-list">
                {deadline.assessment.missingDex.map((dex) => {
                  const path = plan.acquisitions?.targets
                    .find((t) => t.dexNumber === dex)
                    ?.paths.find((p) => p.method !== 'unavailable')
                  return (
                    <li key={dex}>
                      <span>#{String(dex).padStart(3, '0')}</span>{' '}
                      {speciesName(input.dataset, dex)}
                      {path?.area
                        ? ` — ${path.method}${path.sourceDex ? ` from ${speciesName(input.dataset, path.sourceDex)}` : ''}, ${prettyArea(path.area)}`
                        : path?.sourceDex
                          ? ` — ${path.method} from ${speciesName(input.dataset, path.sourceDex)}`
                          : ''}
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}
          <details>
            <summary>Why this status</summary>
            <Reasons items={deadline.assessment.reasons.filter(Boolean)} />
          </details>
        </section>
      )}
      {missed.length ? (
        <section class="panel warning-panel" aria-label="May already be missed">
          <h2>May already be missed</h2>
          <Reasons
            items={missed.map((a) => `${a.title}: ${a.reasons[0] ?? ''}`)}
          />
        </section>
      ) : null}
      {earlier.length ? (
        <details class="panel">
          <summary>Still open from earlier · {earlier.length}</summary>
          <ul class="reasons">
            {earlier.map(({ action, step }) => (
              <li key={action.id}>
                {action.title} <span class="muted">· {step.title}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details class="panel browse">
        <summary>Browse the route stage by stage</summary>
        <label class="stage-picker">
          Route stage
          <select
            value={stage.id}
            onChange={(e) => setChosen(e.currentTarget.value)}
          >
            {input.dataset.route.map((s) => (
              <option key={s.id} value={s.id}>
                {s.order}. {s.title}
              </option>
            ))}
          </select>
        </label>
        <Panel title={stage.title}>
          <Reasons items={stage.instructions} />
          {obligations?.length ? (
            <div class="deadline">
              <h3>Before you move on</h3>
              <Reasons
                items={obligations.map(
                  (o) => `${o.entry.title}: ${o.entry.deadline}`,
                )}
              />
              <button class="quiet" onClick={onAreas}>
                Open area checklist
              </button>
            </div>
          ) : null}
        </Panel>
        {checkpoint && checkpointStage?.checkpoint && (
          <Panel title={`${checkpoint.leader} checkpoint`}>
            <div class="section-heading">
              <h3>Exactly {checkpoint.requiredCount} registered species</h3>
              <Badge status={checkpoint.readiness} />
            </div>
            <p>
              Entire party at level {checkpointStage.checkpoint.levelCap} or
              below. Select Set mode before entry. No items in the leader
              battle; box over-cap grinders.
            </p>
            <p>
              {checkpoint.ownedCount.known
                ? `${checkpoint.ownedCount.value} currently registered.`
                : `Registered count unknown: ${checkpoint.ownedCount.reason}`}
            </p>
            <h3>Missing required species</h3>
            {checkpoint.missingDex.length ? (
              <SpeciesList
                numbers={checkpoint.missingDex}
                dataset={input.dataset}
              />
            ) : (
              <p>
                {checkpoint.ownedCount.known
                  ? 'No known fixed-species gaps; review branch and count requirements below.'
                  : 'Species gaps are unknown until Dex data is readable.'}
              </p>
            )}
            <Reasons items={checkpoint.reasons} />
            <details>
              <summary>Exact checkpoint roster and branch choices</summary>
              <SpeciesList
                numbers={checkpointStage.checkpoint.requiredDex}
                dataset={input.dataset}
              />
              {checkpointStage.checkpoint.branchGroups.map((g) => (
                <div key={g.id}>
                  <h4>
                    {g.id} ·{' '}
                    {g.choiceKey
                      ? `selected ${String(input.attempt.branches[g.choiceKey] ?? 'unknown')}`
                      : g.requiredAll
                        ? 'all alternatives'
                        : `choose ${g.minimumDistinct ?? 1}`}
                  </h4>
                  {g.options.map((o) => (
                    <div key={o.value}>
                      <strong>{o.value}</strong>
                      <SpeciesList
                        numbers={o.dexNumbers}
                        dataset={input.dataset}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </details>
          </Panel>
        )}
        <section aria-label="Concrete actions">
          <h2>Achievements in this stage</h2>
          {plan.actions
            .filter(
              (a) => a.routeStepId === stage.id && !a.id.startsWith('stage-'),
            )
            .map((a) => (
              <article class="action card" key={a.id}>
                <div class="section-heading">
                  <h3>{a.title}</h3>
                  <Badge status={a.readiness} />
                </div>
                <Reasons items={a.instructions} />
                <details>
                  <summary>Why this status</summary>
                  <Reasons items={a.reasons} />
                </details>
              </article>
            ))}
        </section>
        <details class="panel">
          <summary>
            Hold on to these for later · {plan.reservations.length}
          </summary>
          {plan.reservations.map((r) => (
            <p key={r.id}>
              {r.description} <Badge status={r.readiness} />
            </p>
          ))}
        </details>
        <details class="panel">
          <summary>Full route · {input.dataset.route.length} stages</summary>
          <ol class="route-list">
            {input.dataset.route.map((s) => (
              <li key={s.id}>
                <button
                  class="quiet"
                  onClick={() => {
                    setChosen(s.id)
                  }}
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
        </details>
      </details>
    </>
  )
}
