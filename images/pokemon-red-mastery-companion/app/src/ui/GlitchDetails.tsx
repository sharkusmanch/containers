import { useState } from 'preact/hooks'
import type { GlitchMethodAssessment, GlitchPlan, PlanInput } from '../model'
import type { Controller } from './controller'
import { manualDescriptor } from '../planner/display'
import {
  Badge,
  FactText,
  ManualInput,
  Reasons,
  Sources,
  SpeciesList,
  speciesName,
} from './shared'
export function GlitchDetails({
  method: m,
  glitches,
  input,
  controller,
}: {
  method: GlitchMethodAssessment
  glitches: GlitchPlan
  input: PlanInput
  controller: Controller
}) {
  const [transport, setTransport] = useState('ordinary-trainer-fly'),
    [target, setTarget] = useState('151')
  const encounter = m.encounter
  return (
    <div class="glitch-details">
      <div class="notice">
        <strong>
          {m.auditStatus} procedure · {m.readiness}
        </strong>
        <p>{m.nextAction}</p>
        <p>
          Placement: {m.placement}. Required attempt: {m.requiredAttemptKind}.
          {m.requiresPhysicalIsolation
            ? ' Configure physically separate emulator save storage. An app attempt name does not isolate SRAM.'
            : ''}
        </p>
      </div>
      <h3>
        Current preparation <Badge status={m.prerequisites.readiness} />
      </h3>
      <Reasons items={m.prerequisites.reasons} />
      <h3>Runtime validation gates</h3>
      <Reasons items={m.validationBlockers} />
      <p>Recovery boundary: {m.recoveryBoundary}</p>
      <p>
        Observed transition history: <FactText fact={m.transitionEvidence} />
      </p>
      {m.requiresMeasuredSpecial && (
        <p>
          Current measured party donors:{' '}
          {m.measuredDonors.length
            ? m.measuredDonors
                .map(
                  (d) =>
                    `slot ${d.slot}, Special ${d.special} (${d.importedAt})`,
                )
                .join('; ')
            : 'unknown or no matching measured donor'}
          . Original setup history is shown separately below.
        </p>
      )}
      {encounter && (
        <section aria-label="Encounter setup">
          <h3>Encounter setup · {encounter.phase}</h3>
          <p>
            Original setup:{' '}
            {encounter.identity.known
              ? `generation ${encounter.identity.value.generation}, ${encounter.identity.value.transport}, donor slot ${encounter.identity.value.donor.slot}, Special ${encounter.identity.value.donor.special}, ${encounter.identity.value.successfulGrowls} successful Growls`
              : encounter.identity.reason}
          </p>
          <p>Continuation: {encounter.continuation}</p>
          {encounter.currentMew && (
            <p>
              Current first-slot Mew:{' '}
              {encounter.currentMew.known
                ? encounter.currentMew.value
                  ? `observed, level ${encounter.currentMew.value.level.known ? encounter.currentMew.value.level.value : 'unknown'}`
                  : 'not observed'
                : `unknown — ${encounter.currentMew.reason}`}
            </p>
          )}
          <Badge status={encounter.assessment.readiness} />
          <Reasons items={encounter.assessment.reasons} />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              controller.dispatch({
                type: 'record-manual',
                key: 'glitch:transport',
                value: transport,
                ruleId: m.ruleId,
              })
            }}
          >
            <label>
              Encounter transport
              <select
                value={transport}
                onChange={(e) => setTransport(e.currentTarget.value)}
              >
                <option value="ordinary-trainer-fly">
                  Ordinary Trainer-Fly
                </option>
                <option value="pc-underflow">PC underflow</option>
              </select>
            </label>
            <button class="quiet">Record transport selection</button>
          </form>
          {encounter.startControls.length === 0 && (
            <p class="muted">
              Start controls appear after a supported transport and a current
              measured matching donor are available.
            </p>
          )}
          <div class="button-row">
            {encounter.startControls.map((c) => (
              <button
                key={c.label}
                onClick={() =>
                  controller.dispatch({ type: 'record-manual', ...c.action })
                }
              >
                {c.label}
              </button>
            ))}
          </div>
          <div class="button-row">
            {encounter.phaseControls.map((c) => (
              <button
                class="quiet"
                key={c.phase}
                onClick={() =>
                  controller.dispatch({ type: 'record-manual', ...c.action })
                }
              >
                {c.label}
              </button>
            ))}
          </div>
          {encounter.confirmationControls.map((c) => (
            <ScopedConfirmation
              key={c.key}
              control={c}
              ruleId={m.ruleId}
              controller={controller}
            />
          ))}
          <details>
            <summary>Transport procedures and reserved trainers</summary>
            {glitches.transports.map((t) => (
              <div key={t.methodId}>
                <h4>
                  {t.methodId} <Badge status={t.readiness} />
                </h4>
                <p>New transport preflight: {t.prerequisites.readiness}</p>
                <Reasons items={t.prerequisites.reasons} />
                <Reasons items={[...t.instructions, ...t.warnings]} />
                <Sources urls={t.sourceUrls} />
              </div>
            ))}
            {glitches.reservations.map((r) => (
              <p key={r.flag}>
                {r.trainer}: {r.geometry} {r.releaseAfter}
              </p>
            ))}
            <ManualInput
              controller={controller}
              control={manualDescriptor(
                'glitch:trainer-fly-final-use-complete',
              )}
            />
          </details>
        </section>
      )}
      {m.oakRoster && (
        <section>
          <h3>
            Exact Oak roster · {m.oakRoster.successfulGrowls} successful Growls
          </h3>
          <p>
            {m.oakRoster.starter}, team {m.oakRoster.teamNumber}
          </p>
          <ul>
            {m.oakRoster.members.map((p) => (
              <li key={p.species}>
                {p.species} · level {p.level}
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.experienceRoute && (
        <section>
          <h3>Supported EXP route</h3>
          <p>
            {m.experienceRoute.minimum}–{m.experienceRoute.maximum} actual EXP,{' '}
            {m.experienceRoute.participants} surviving participants. Initial
            24-bit EXP: {m.experienceRoute.initialExperience}.
          </p>
          <ul>
            {m.experienceRoute.awards.map((a) => (
              <li key={`${a.species}${a.level}`}>
                {a.species} level {a.level}: {a.exp} EXP
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.collection && (
        <section>
          <h3>Own collection</h3>
          <p>
            {m.collection.ownedCount.known
              ? `${m.collection.ownedCount.value} registered`
              : `Unknown — ${m.collection.ownedCount.reason}`}
          </p>
          {m.collection.missingDex.known ? (
            <SpeciesList
              dataset={input.dataset}
              numbers={m.collection.missingDex.value}
            />
          ) : (
            <p>Missing species are unknown.</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              controller.dispatch({
                type: 'record-manual',
                key: 'glitch:collection-target-dex',
                value: Number(target),
                ruleId: m.ruleId,
              })
            }}
          >
            <label>
              Collection encounter target
              <select
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
              >
                {m.collection.targets.map((t) => (
                  <option key={t.dexNumber} value={t.dexNumber}>
                    {speciesName(input.dataset, t.dexNumber)} · Special{' '}
                    {t.special}
                  </option>
                ))}
              </select>
            </label>
            <button class="quiet">Record collection target</button>
          </form>
          {m.collection.targets.map((t) => (
            <p key={t.dexNumber}>
              {speciesName(input.dataset, t.dexNumber)}: Special {t.special};
              measured <FactText fact={t.measured} />. {t.followUp}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
function ScopedConfirmation({
  control: c,
  ruleId,
  controller,
}: {
  control: NonNullable<
    GlitchMethodAssessment['encounter']
  >['confirmationControls'][number]
  ruleId: number
  controller: Controller
}) {
  const [value, setValue] = useState(String(c.expected))
  if (c.valueType === 'boolean')
    return (
      <ManualInput
        controller={controller}
        observed={c.observed}
        control={{
          key: c.key,
          label: c.label,
          expected: c.expected,
          valueType: c.valueType,
          scope: 'This encounter setup only',
          ruleId,
        }}
      />
    )
  return (
    <form
      class="manual-input"
      onSubmit={(e) => {
        e.preventDefault()
        controller.dispatch({
          type: 'record-manual',
          key: c.key,
          value: Number(value),
          ruleId,
        })
      }}
    >
      <label>
        {c.label}
        <input
          type="number"
          required
          min={c.minimum}
          max={c.maximum}
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </label>
      <p>
        {c.observed.known
          ? `Recorded: ${c.observed.value}`
          : `Unknown — ${c.observed.reason}`}
      </p>
      <small>This encounter setup only. Enter the actual observation.</small>
      <button>Record observation</button>
    </form>
  )
}
