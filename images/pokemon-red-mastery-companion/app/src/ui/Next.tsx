import { useState } from 'preact/hooks'
import type { PlanInput, RunPlan } from '../model'
import { suggestedStage } from '../planner/display'
import { Badge, Panel, Reasons, SpeciesList } from './shared'
export function Next({
  input,
  plan,
  onAreas,
}: {
  input: PlanInput
  plan: RunPlan
  onAreas: () => void
}) {
  const [chosen, setChosen] = useState(''),
    stageId = chosen || suggestedStage(input)
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
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">Your next session</p>
        <h1>Make every step count.</h1>
        <p>
          Follow the protected main / Oak route. Preparation, recorded history
          and hardcore awards remain separate.
        </p>
      </div>
      {!input.attempt.snapshot && (
        <p class="notice">
          No save imported. The full guide is available; choose your branches in
          More and import a save whenever you’re ready.
        </p>
      )}
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
            Entire party at level {checkpointStage.checkpoint.levelCap} or below.
            Select Set mode before entry. No items in the leader battle; box
            over-cap grinders.
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
        <h2>Session actions</h2>
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
                <summary>Preparation and evidence</summary>
                <Reasons items={a.reasons} />
              </details>
            </article>
          ))}
      </section>
      <details class="panel">
        <summary>
          Keep in reserve · {plan.reservations.length} obligations
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
                  window.scrollTo?.(0, 0)
                }}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </details>
    </>
  )
}
