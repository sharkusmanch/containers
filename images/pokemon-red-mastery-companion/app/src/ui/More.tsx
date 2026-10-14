import { useEffect, useState } from 'preact/hooks'
import type { BranchChoices, PlanInput, RunPlan } from '../model'
import type { Controller } from './controller'
import { History, Panel, Reasons, Sources } from './shared'
import { saveStatus } from './status'
import { sourceAvailable } from '../sources/deployment'
import type { IdentityDiscovery } from '../sources/ra'
import { retiredMarks } from '../state/key-migrations'
export function More({
  input,
  plan,
  controller,
}: {
  input: PlanInput
  plan: RunPlan
  controller: Controller
}) {
  const { attempt, project, dataset } = input
  const [name, setName] = useState(''),
    [kind, setKind] = useState<'glitch' | 'speedrun'>('glitch'),
    [url, setUrl] = useState(attempt.source.url ?? ''),
    [enabled, setEnabled] = useState(attempt.source.enabled ?? false)
  const [identity, setIdentity] = useState(project.accountIdentity ?? ''),
    [mount, setMount] = useState(''),
    [reset, setReset] = useState(false),
    [restore, setRestore] = useState(''),
    [exported, setExported] = useState(''),
    [original, setOriginal] = useState<string | null>(null),
    [assign, setAssign] = useState(attempt.id),
    [discovery, setDiscovery] = useState<IdentityDiscovery | 'checking' | null>(
      null,
    )
  // Keep the Advanced form in step with the quick toggle in Your save.
  useEffect(
    () => setEnabled(attempt.source.enabled ?? false),
    [attempt.source.enabled],
  )
  const deployment = controller.getDeployment(),
    config = deployment.status === 'private' ? deployment.config : {},
    status = saveStatus(project, attempt, deployment),
    available = sourceAvailable(attempt.source, deployment)
  async function connect() {
    setDiscovery('checking')
    setDiscovery(await controller.discoverIdentity())
  }
  function download() {
    const raw = controller.exportProject()
    if (!raw) return
    setExported(raw)
    try {
      const blob = new Blob([raw], { type: 'application/json' }),
        href = URL.createObjectURL(blob),
        a = document.createElement('a')
      a.href = href
      a.download = 'pokemon-red-mastery-project.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
    } catch {
      controller.reportError(
        'Download could not start. Copy the project export text below; your live state is retained.',
      )
    }
  }
  return (
    <>
      <div class="page-intro">
        <p class="eyebrow">Settings</p>
        <h1>Your save & progress</h1>
        <p>
          The app only reads your save; it never changes it. Everything else
          stays in this browser.
        </p>
      </div>
      <Panel title="Your save">
        {status.tone !== 'none' && (
          <p class={`notice ${status.tone}`} role="status">
            {status.text}
            {status.signedOut && (
              <button class="link" onClick={() => location.reload()}>
                Reload to sign in
              </button>
            )}
          </p>
        )}
        {attempt.source.url && !available ? (
          <p>
            This project’s save address belongs to the private server, so
            nothing is requested here. Upload a battery save instead.
          </p>
        ) : attempt.source.url ? (
          <p>
            {attempt.source.origin === 'deployment'
              ? 'This server provides your emulator save. '
              : 'Loading from your own save address. '}
            {attempt.source.enabled && !attempt.source.paused
              ? 'It reloads automatically every 30 seconds and when you come back to this tab.'
              : attempt.source.paused
                ? 'Automatic reload is paused because you uploaded a file; tap Reload now to resume.'
                : 'Automatic reload is off.'}
          </p>
        ) : (
          <p>
            Upload your battery save (.srm or .sav) whenever you want an update.
            It is read in this browser and never sent anywhere.
          </p>
        )}
        {available && (
          <label class="check">
            <input
              type="checkbox"
              checked={!!attempt.source.enabled && !attempt.source.paused}
              onChange={(e) => {
                const enabled = e.currentTarget.checked
                controller.dispatch({ type: 'set-source-enabled', enabled })
                // Load straight away instead of waiting for the next 30-second tick.
                if (enabled) void controller.saves.refresh()
              }}
            />
            Reload automatically
          </label>
        )}
        <div class="button-row">
          {available && (
            <button
              disabled={!!project.pendingImport}
              onClick={() => void controller.saves.refresh()}
            >
              Reload now
            </button>
          )}
          {project.pendingImport && (
            <button class="quiet" onClick={() => controller.saves.cancel()}>
              Cancel
            </button>
          )}
        </div>
        <label class="upload">
          Upload battery save
          <input
            type="file"
            accept=".sav,.srm,application/octet-stream"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              if (file)
                void controller.saves.upload(
                  async () => new Uint8Array(await file.arrayBuffer()),
                )
              e.currentTarget.value = ''
            }}
          />
        </label>
        <p>English Red (USA/Europe) battery save, 32,768 bytes.</p>
        {attempt.source.lastError && !status.signedOut && (
          <p role="alert" class="notice">
            {attempt.source.lastError}
          </p>
        )}
        {attempt.heldImport && (
          <div class="held">
            <h3>Trainer changed — import held</h3>
            {!controller.canAssignHeld() && (
              <p class="notice">
                This held import expired when the attempt or source context
                changed. Refresh this attempt’s URL to review a current
                observation, or discard it.
              </p>
            )}
            <p>
              Incoming trainer:{' '}
              {attempt.heldImport.snapshot.trainer.known
                ? `${attempt.heldImport.snapshot.trainer.value.name} · ID ${attempt.heldImport.snapshot.trainer.value.id}`
                : 'unknown'}
              .
            </p>
            <p>
              The previous snapshot remains active. Assign the new observation
              explicitly or discard it.
            </p>
            <label>
              Assign held save to
              <select
                value={assign}
                onChange={(e) => setAssign(e.currentTarget.value)}
              >
                {project.attempts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <div class="button-row">
              <button
                disabled={!controller.canAssignHeld()}
                onClick={() =>
                  controller.dispatch({
                    type: 'assign-held',
                    targetAttemptId: assign,
                  })
                }
              >
                Assign held import
              </button>
              <button
                class="quiet"
                onClick={() => controller.dispatch({ type: 'discard-held' })}
              >
                Discard held import
              </button>
              <button
                class="quiet"
                onClick={() => {
                  controller.dispatch({
                    type: 'ignore-hash',
                    hash: attempt.heldImport!.snapshot.hash,
                  })
                  controller.dispatch({ type: 'discard-held' })
                }}
              >
                Ignore this fingerprint
              </button>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="Hardcore progress">
        {project.accountIdentity && config.companionUrl ? (
          <>
            <p>
              Connected to RetroAchievements account{' '}
              <strong>{project.accountIdentity}</strong>. Unlocks refresh when
              you open the app, and at most every 5 minutes while it is open.
            </p>
            <button
              disabled={controller.isSyncing()}
              onClick={() => controller.syncDeployment(false)}
            >
              {controller.isSyncing() ? 'Refreshing…' : 'Refresh unlocks now'}
            </button>
          </>
        ) : config.companionUrl ? (
          <>
            <p>
              See your real hardcore unlocks next to the guide. The server holds
              the RetroAchievements key; this browser only reads the results.
            </p>
            {discovery && discovery !== 'checking' && discovery.identity ? (
              <div class="notice">
                <p>
                  The server reports account{' '}
                  <strong>{discovery.identity}</strong>. Is that you?
                </p>
                <div class="button-row">
                  <button
                    onClick={() => {
                      controller.dispatch({
                        type: 'set-account-identity',
                        identity: discovery.identity,
                      })
                      setDiscovery(null)
                      controller.syncDeployment(false)
                    }}
                  >
                    Yes, use {discovery.identity}
                  </button>
                  <button class="quiet" onClick={() => setDiscovery(null)}>
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button
                disabled={discovery === 'checking'}
                onClick={() => void connect()}
              >
                {discovery === 'checking'
                  ? 'Checking…'
                  : 'Connect hardcore progress'}
              </button>
            )}
            {discovery && discovery !== 'checking' && discovery.error && (
              <p role="alert" class="notice">
                Couldn’t connect: {discovery.error}
              </p>
            )}
          </>
        ) : (
          <p>
            {project.accountIdentity
              ? deployment.status === 'signed-out'
                ? `Account ${project.accountIdentity} is connected, but you are signed out. Reload to sign in and refresh unlocks.`
                : deployment.status === 'public' && deployment.unreachable
                  ? `Account ${project.accountIdentity} is connected, but this server’s settings could not be reached. Reload to try again.`
                  : `Account ${project.accountIdentity} is set, but no progress service is available here. The last loaded unlocks are shown below.`
              : 'Not connected. Hardcore unlocks need a private server (see Advanced). Your own marks never count as unlocks.'}
          </p>
        )}
        {dataset.sets.map((s) => {
          const f = project.accountProgress.find((p) => p.setKey === s.key)
          return f ? (
            <p key={s.key}>
              <strong>{s.title}</strong>:{' '}
              {f.lastSuccessfulFetchAt
                ? `${f.unlocks.length} unlocked · checked ${new Date(f.lastSuccessfulFetchAt).toLocaleString()}${f.stale ? ' (latest check failed)' : ''}`
                : 'not loaded yet'}
              {f.unavailableReason ? ` — ${f.unavailableReason}` : ''}
            </p>
          ) : null
        })}
      </Panel>
      {config.guideUrl && (
        <Panel title="Written guide">
          <a href={config.guideUrl} target="_blank" rel="noreferrer">
            Open the full written guide ↗
          </a>
        </Panel>
      )}
      {retiredMarks(attempt).length > 0 && (
        <Panel title="Marks no longer used">
          <p>
            The guide data changed, so these marks no longer count toward
            anything. They are kept for your records; archive them when you no
            longer need them.
          </p>
          <Reasons
            items={[...new Set(retiredMarks(attempt).map((m) => m.reason))]}
          />
          <History
            records={retiredMarks(attempt).map((m) => m.record)}
            attempt={attempt}
            controller={controller}
          />
        </Panel>
      )}
      <details class="panel advanced">
        <summary>Advanced</summary>
        <p class="muted">
          Separate attempts, run choices, save address, account settings,
          backups and your recorded marks.
        </p>
        <Panel title="Separate save files (attempts)">
          <label>
            Active attempt
            <select
              value={attempt.id}
              onChange={(e) =>
                controller.dispatch({
                  type: 'switch-attempt',
                  attemptId: e.currentTarget.value,
                })
              }
            >
              {project.attempts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.kind}
                </option>
              ))}
            </select>
          </label>
          <p>
            {attempt.kind === 'canonical'
              ? 'Main + Professor Oak run (the protected attempt).'
              : 'Use a physically separate emulator save file for this attempt.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim())
                controller.dispatch({
                  type: 'create-attempt',
                  name: name.trim(),
                  kind,
                })
            }}
          >
            <label>
              New attempt name
              <input
                required
                maxLength={100}
                value={name}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="e.g. Mew practice"
              />
            </label>
            <label>
              Attempt type
              <select
                value={kind}
                onChange={(e) => setKind(e.currentTarget.value as typeof kind)}
              >
                <option value="glitch">Separate glitch attempt</option>
                <option value="speedrun">Fresh speedrun attempt</option>
              </select>
            </label>
            <button>Create attempt</button>
          </form>
          <p class="muted">
            New attempts begin with no save, URL, branch choices or history.
            Naming an attempt does not configure emulator storage.
          </p>
        </Panel>
        <Panel title="Run choices">
          <p>
            Record the choices you actually made; the catch lists before each
            gym depend on them.
          </p>
          <div class="filters">
            {(['starter', 'fossil', 'dojo', 'eevee'] as const).map((key) => {
              const values = {
                starter: ['bulbasaur', 'charmander', 'squirtle'],
                fossil: ['helix', 'dome'],
                dojo: ['hitmonlee', 'hitmonchan'],
                eevee: ['vaporeon', 'jolteon', 'flareon'],
              }[key]
              return (
                <label key={key}>
                  {key[0]!.toUpperCase() + key.slice(1)}
                  <select
                    value={attempt.branches[key] ?? ''}
                    onChange={(e) =>
                      controller.dispatch({
                        type: 'set-branches',
                        branches: {
                          [key]: e.currentTarget.value || undefined,
                        } as BranchChoices,
                      })
                    }
                  >
                    <option value="">Unknown / not selected</option>
                    {values.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
          <fieldset>
            <legend>Misty’s two distinct Moon Stone species</legend>
            {[
              [31, 'Nidoqueen'],
              [34, 'Nidoking'],
              [36, 'Clefable'],
              [40, 'Wigglytuff'],
            ].map(([dex, label]) => (
              <label class="check" key={dex}>
                <input
                  type="checkbox"
                  checked={
                    attempt.branches.moonstones?.includes(Number(dex)) ?? false
                  }
                  onChange={(e) => {
                    const selected = attempt.branches.moonstones ?? []
                    const values = e.currentTarget.checked
                      ? [...selected, Number(dex)]
                      : selected.filter((n) => n !== dex)
                    controller.dispatch({
                      type: 'set-branches',
                      branches: {
                        moonstones: values.length ? values : undefined,
                      },
                    })
                  }}
                />
                {label}
              </label>
            ))}
            <p class="muted">
              Choose exactly two, or leave unselected to use readable
              registrations. Later checkpoints require all four.
            </p>
          </fieldset>
        </Panel>
        <Panel title="Save address">
          <p class="notice">
            {attempt.source.paused
              ? 'Automatic reload is paused after a manual upload. Reloading from the address or saving these settings resumes it.'
              : 'Automatic reload runs only when turned on: every 30 seconds and when you return to the tab.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              controller.dispatch({
                type: 'set-source',
                source: {
                  kind: url.trim() ? 'url' : 'upload',
                  url: url.trim() || undefined,
                  enabled,
                },
              })
            }}
          >
            <label>
              Save URL for this attempt
              <input
                value={url}
                onInput={(e) => setUrl(e.currentTarget.value)}
                placeholder="./save"
              />
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.currentTarget.checked)}
              />
              Enable automatic save refresh
            </label>
            <button>Save source settings</button>
          </form>
          <div class="button-row">
            <button
              disabled={!available}
              onClick={() => void controller.saves.refresh()}
            >
              Reload from address now
            </button>
            <button
              class="quiet"
              disabled={!project.pendingImport}
              onClick={() => controller.saves.cancel()}
            >
              Cancel import
            </button>
          </div>
          <p>
            Current address: {attempt.source.url ?? 'none'}. Each request gives
            up after 10 seconds.
          </p>
          {project.pendingImport && (
            <p role="status">Reading save for {attempt.name}…</p>
          )}
          <details>
            <summary>Source diagnostics and ignored files</summary>
            <p>
              Current trainer:{' '}
              {attempt.snapshot?.trainer.known
                ? `${attempt.snapshot.trainer.value.name} · ID ${attempt.snapshot.trainer.value.id}`
                : 'unknown'}
              .
            </p>
            <p>
              Registered Dex:{' '}
              {attempt.snapshot?.ownedDex.known
                ? attempt.snapshot.ownedDex.value.length
                : 'unknown'}{' '}
              · Party:{' '}
              {attempt.snapshot?.party.known
                ? `${attempt.snapshot.party.value.length} observed members`
                : 'unknown'}
              .
            </p>
            <p>
              Last successful import: {attempt.source.lastImportAt ?? 'none'}
            </p>
            <p>Current fingerprint: {attempt.snapshot?.hash ?? 'none'}</p>
            <Reasons items={attempt.diagnostics ?? []} />
            <p>
              {attempt.ignoredHashes?.length ?? 0} ignored fingerprints in this
              attempt.
            </p>
          </details>
        </Panel>
        <Panel title="Account settings (hardcore progress)">
          <p>
            For your own server: enter the exact account name your progress
            service reports and its companion address. The RetroAchievements key
            stays on the server; never enter a key here.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              controller.dispatch({ type: 'set-account-identity', identity })
            }}
          >
            <label>
              Account identity
              <input
                value={identity}
                onInput={(e) => setIdentity(e.currentTarget.value)}
                placeholder="Exact identity exposed by your proxy"
              />
            </label>
            <button>Save account identity</button>
          </form>
          <p>
            Changing identity clears incompatible account feeds and preserves
            all attempts and history.
          </p>
          <label>
            Companion mount URL
            <input
              value={mount}
              onInput={(e) => setMount(e.currentTarget.value)}
              placeholder="/companion/"
            />
          </label>
          <p class="muted">
            Use the companion mount, such as /companion/. The client appends
            api/achievements/ra/&lt;id&gt;.
          </p>
          <button
            disabled={
              !project.accountIdentity ||
              !mount.trim() ||
              controller.isSyncing()
            }
            onClick={() => void controller.sync(mount)}
          >
            {controller.isSyncing()
              ? 'Refreshing progress…'
              : 'Refresh hardcore unlocks'}
          </button>
          {dataset.sets.map((s) => {
            const f = project.accountProgress.find((p) => p.setKey === s.key)
            return (
              <p key={s.key}>
                <strong>{s.title}</strong>:{' '}
                {f?.lastSuccessfulFetchAt
                  ? `${f.unlocks.length} unlocked · checked ${new Date(f.lastSuccessfulFetchAt).toLocaleString()}${f.stale ? ' (latest check failed)' : ''}`
                  : 'not loaded'}
                {f?.unavailableReason ? ` — ${f.unavailableReason}` : ''}
              </p>
            )
          })}
        </Panel>
        <Panel title="Backup, restore & reset">
          {controller.isPersistenceBlocked() && (
            <div class="notice">
              <p>
                Stored data is protected. Edits currently stay in memory; export
                your live project before closing this page. Export the original
                recovery text before a valid restore or explicit replacement.
              </p>
              <button onClick={() => controller.replaceStoredProject()}>
                Use current project as stored replacement
              </button>
            </div>
          )}
          {controller.exportRecoveryData() !== null && (
            <>
              <button
                class="quiet"
                onClick={() => setOriginal(controller.exportRecoveryData())}
              >
                Show original recovery text
              </button>
              <p class="muted">
                Copy this exact original text to a file for recovery. After
                replacement it remains available here until you close the page.
              </p>
            </>
          )}
          {original !== null && (
            <label>
              Original recovery text
              <textarea readOnly value={original} rows={5} />
            </label>
          )}
          <div class="button-row">
            <button onClick={download}>Export project</button>
            <button
              class="quiet"
              onClick={() => setExported(controller.exportProject())}
            >
              Show export text
            </button>
          </div>
          {exported && (
            <label>
              Project export text
              <textarea readOnly value={exported} rows={5} />
            </label>
          )}
          <label>
            Restore project file
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                e.currentTarget.value = ''
                if (file) void controller.restoreProjectFile(() => file.text())
              }}
            />
          </label>
          <details>
            <summary>Restore pasted project export</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                controller.dispatch({ type: 'restore-project', raw: restore })
              }}
            >
              <label>
                Project export to restore
                <textarea
                  value={restore}
                  onInput={(e) => setRestore(e.currentTarget.value)}
                  rows={4}
                />
              </label>
              <button>Restore project</button>
            </form>
          </details>
          <p>
            Restoring replaces this app’s project. It does not restore an
            emulator save. Pending encounter setups require review after restore
            or Undo.
          </p>
          <div class="button-row">
            <button class="danger quiet" onClick={() => setReset(true)}>
              Reset active attempt
            </button>
            <button
              class="quiet"
              disabled={!project.resetUndo}
              onClick={() => controller.dispatch({ type: 'undo-reset' })}
            >
              Undo reset
            </button>
          </div>
          {reset && (
            <div class="notice">
              <p>
                Clear {attempt.name}’s snapshot, source, branches and history?{' '}
                {attempt.kind === 'canonical' &&
                deployment.status === 'private' &&
                deployment.config.saveUrl
                  ? 'This server’s save will be reconnected straight away.'
                  : ''}
                Account hardcore progress is retained.
              </p>
              <div class="button-row">
                <button
                  class="danger"
                  onClick={() => {
                    controller.dispatch({ type: 'reset-attempt' })
                    setReset(false)
                  }}
                >
                  Confirm reset
                </button>
                <button class="quiet" onClick={() => setReset(false)}>
                  Keep attempt
                </button>
              </div>
            </div>
          )}
        </Panel>
        <details class="panel">
          <summary>Your marks · {attempt.manualEvidence.length}</summary>
          <History
            records={attempt.manualEvidence}
            attempt={attempt}
            controller={controller}
          />
        </details>
        <details class="panel">
          <summary>About the data and what is not yet tested</summary>
          <p>
            Dataset {dataset.manifest.version} · published membership checked{' '}
            {dataset.manifest.publishedCheckedAt}. Source guidance is available
            for all 234 objectives. Runtime success has not been established for
            any procedure yet.
          </p>
          <Reasons items={plan.diagnostics} />
          <Sources urls={dataset.manifest.sources.map((s) => s.url)} />
        </details>
      </details>
    </>
  )
}
