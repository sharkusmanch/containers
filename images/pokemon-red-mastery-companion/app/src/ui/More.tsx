import { useState } from 'preact/hooks'
import type { BranchChoices, PlanInput, RunPlan } from '../model'
import type { Controller } from './controller'
import { History, Panel, Reasons, Sources } from './shared'
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
    [assign, setAssign] = useState(attempt.id)
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
        <p class="eyebrow">Your mastery desk</p>
        <h1>Attempts & sources</h1>
        <p>
          Battery saves are read only. App backups contain observations and
          history, never emulator save bytes.
        </p>
      </div>
      <Panel title="Attempts">
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
            ? 'Protected main / Oak attempt.'
            : 'Use physically separate emulator save storage for unsafe or fresh attempts.'}
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
      <Panel title="Branch choices">
        <p>Record your actual choices for the exact canonical collection.</p>
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
      <Panel title="Save source">
        <label>
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
        <p>
          English Red USA/Europe, 32,768-byte SRAM. Uploads are parsed in this
          browser and never sent to a server.
        </p>
        <p class="notice">
          {attempt.source.paused
            ? 'Automatic refresh paused after manual upload. Explicit URL refresh or saving source settings resumes it.'
            : 'Automatic refresh runs only when enabled, at least 30 seconds apart, including tab return.'}
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
            disabled={!attempt.source.url}
            onClick={() => void controller.saves.refresh()}
          >
            Refresh URL now
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
          Saved endpoint: {attempt.source.url ?? 'none'} · revision{' '}
          {attempt.source.revision}. Requests time out after 10 seconds.
        </p>
        {project.pendingImport && (
          <p role="status">Reading save for {attempt.name}…</p>
        )}
        {attempt.source.lastError && (
          <p role="alert" class="notice">
            {attempt.source.lastError} Last good snapshot:{' '}
            {attempt.snapshot?.importedAt ?? 'none'}.
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
          <p>Last successful import: {attempt.source.lastImportAt ?? 'none'}</p>
          <p>Current fingerprint: {attempt.snapshot?.hash ?? 'none'}</p>
          <Reasons items={attempt.diagnostics ?? []} />
          <p>
            {attempt.ignoredHashes?.length ?? 0} ignored fingerprints in this
            attempt.
          </p>
        </details>
      </Panel>
      <Panel title="Optional hardcore progress">
        <p>
          Manual sync only. Final authenticated deployed-route acceptance
          remains open. A server-side key and all three allowed backing IDs are
          required; never enter a key here.
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
          Changing identity clears incompatible account feeds and preserves all
          attempts and history.
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
            !project.accountIdentity || !mount.trim() || controller.isSyncing()
          }
          onClick={() => void controller.sync(mount)}
        >
          {controller.isSyncing()
            ? 'Refreshing progress…'
            : 'Refresh all three HC feeds'}
        </button>
        {dataset.sets.map((s) => {
          const f = project.accountProgress.find((p) => p.setKey === s.key)
          return (
            <p key={s.key}>
              <strong>{s.title}</strong>:{' '}
              {f?.lastSuccessfulFetchAt
                ? `${f.unlocks.length} confirmed HC · ${f.stale ? 'stale' : 'last success'} ${f.lastSuccessfulFetchAt}`
                : 'unknown / not synced'}
              {f?.unavailableReason ? ` — ${f.unavailableReason}` : ''}
            </p>
          )
        })}
      </Panel>
      <Panel title="Project backup & recovery">
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
          Restoring replaces this app’s project. It does not restore an emulator
          save. Pending encounter setups require review after restore or Undo.
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
              Clear {attempt.name}’s snapshot, source, branches and history?
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
        <summary>
          Evidence history · {attempt.manualEvidence.length} records
        </summary>
        <History
          records={attempt.manualEvidence}
          attempt={attempt}
          controller={controller}
        />
      </details>
      <details class="panel">
        <summary>Dataset, source notes & open validation</summary>
        <p>
          Dataset {dataset.manifest.version} · published membership checked{' '}
          {dataset.manifest.publishedCheckedAt}. Source guidance is available
          for all 234 objectives. Runtime success is not established for every
          procedure.
        </p>
        <Reasons items={plan.diagnostics} />
        <Sources urls={dataset.manifest.sources.map((s) => s.url)} />
      </details>
    </>
  )
}
