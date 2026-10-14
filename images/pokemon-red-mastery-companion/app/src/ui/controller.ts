import type { MasteryProject } from '../model'
import {
  adoptDeploymentSave,
  createProject,
  heldImportIsCurrent,
} from '../state/project'
import { reduceProject } from '../state/reducer'
import type { ProjectAction } from '../state/reducer'
import { restoreProject, serializeProject } from '../state/persist'
import { createSaveController } from '../sources/poller'
import { discoverAccountIdentity, fetchHardcoreProgress } from '../sources/ra'
import type { DeploymentState } from '../sources/deployment'
import { SIGNED_OUT, sourceAvailable } from '../sources/deployment'
export const STORAGE_KEY = 'pokemon-red-mastery-project-v1'
/** Automatic hardcore refreshes on open/focus are at least this far apart. */
export const PROGRESS_INTERVAL = 5 * 60_000
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
export function createController(
  options: {
    initial?: MasteryProject
    storage?: Storage | null
    deployment?: DeploymentState
  } = {},
) {
  const deployment: DeploymentState = options.deployment ?? { status: 'public' }
  const adopt = (p: MasteryProject) =>
    deployment.status === 'private'
      ? adoptDeploymentSave(p, deployment.config.saveUrl)
      : p
  let project = options.initial ?? createProject(),
    error = '',
    recoveryRaw: string | null = null,
    persistenceBlocked = false,
    restoreGeneration = 0,
    storage: Storage | null = null
  const listeners = new Set<() => void>()
  let syncGeneration = 0,
    syncAbort: AbortController | undefined,
    syncing = false,
    lastAutomaticSync = -Infinity
  try {
    storage =
      options.storage === undefined ? globalThis.localStorage : options.storage
    if (!options.initial) {
      const raw = storage?.getItem(STORAGE_KEY)
      if (raw) {
        const restored = restoreProject(raw)
        if (restored.ok) project = restored.project
        else {
          recoveryRaw = raw
          persistenceBlocked = true
          error = `Stored project needs recovery: ${restored.error}. Export the original recovery text before replacing it.`
        }
      }
    }
  } catch {
    persistenceBlocked = true
    error = 'Could not read local storage. Keep an exported project backup.'
  }
  // Existing browser projects keep their data; only an unset canonical source is filled in.
  project = adopt(project)
  // This page load passed sign-in, so a stored "Signed out" error is stale.
  if (
    deployment.status !== 'signed-out' &&
    project.attempts.some((a) => a.source.lastError?.startsWith(SIGNED_OUT))
  )
    project = {
      ...project,
      attempts: project.attempts.map((a) =>
        a.source.lastError?.startsWith(SIGNED_OUT)
          ? { ...a, source: { ...a.source, lastError: undefined } }
          : a,
      ),
    }
  const notify = () => listeners.forEach((fn) => fn())
  function persist() {
    if (persistenceBlocked) return
    try {
      storage?.setItem(STORAGE_KEY, serializeProject(project))
    } catch {
      error =
        'Could not save locally. Your live project is retained; export a backup.'
    }
  }
  function setProject(next: MasteryProject) {
    if (next === project) return
    // Any newer live state supersedes a still-reading project backup.
    restoreGeneration++
    project = next
    persist()
    notify()
  }
  const saves = createSaveController({
    getProject: () => project,
    setProject,
    sourceAllowed: (source) => sourceAvailable(source, deployment),
  })
  const invalidating = new Set([
    'create-attempt',
    'switch-attempt',
    'set-source',
    'pause-source',
    'reset-attempt',
    'undo-reset',
    'restore-project',
  ])
  const controller = {
    getProject: () => project,
    getDeployment: () => deployment,
    canAssignHeld: () => heldImportIsCurrent(project),
    getError: () => error,
    isPersistenceBlocked: () => persistenceBlocked,
    exportRecoveryData: () => recoveryRaw,
    isSyncing: () => syncing,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    dispatch(action: ProjectAction) {
      restoreGeneration++
      if (invalidating.has(action.type)) saves.cancel()
      if (
        action.type === 'restore-project' ||
        action.type === 'set-account-identity'
      ) {
        syncGeneration++
        syncAbort?.abort()
        syncing = false
      }
      try {
        const next = adopt(reduceProject(project, action))
        if (action.type === 'restore-project') {
          error = next.recoveryError ?? ''
          if (!next.recoveryError) persistenceBlocked = false
        }
        setProject(next)
      } catch {
        error = 'Project operation failed. Your live project is retained.'
        notify()
      }
    },
    saves,
    async restoreProjectFile(read: () => Promise<string>) {
      saves.cancel()
      syncGeneration++
      syncAbort?.abort()
      syncing = false
      // Capture before invoking file.text(), never after its await.
      const token = ++restoreGeneration
      notify()
      try {
        const raw = await read()
        if (token === restoreGeneration)
          controller.dispatch({ type: 'restore-project', raw })
      } catch {
        if (token === restoreGeneration)
          controller.reportError(
            'Could not read project file. Your live project is retained.',
          )
      }
    },
    replaceStoredProject() {
      restoreGeneration++
      persistenceBlocked = false
      error = ''
      persist()
      notify()
    },
    exportProject() {
      try {
        return serializeProject(project)
      } catch {
        error = 'Could not export the project. Your live project is retained.'
        notify()
        return ''
      }
    },
    reportError(message: string) {
      error = message
      notify()
    },
    clearError() {
      error = ''
      notify()
    },
    async sync(mount: string) {
      if (!mount.trim() || !project.accountIdentity) return
      syncAbort?.abort()
      const abort = new AbortController()
      syncAbort = abort
      const token = ++syncGeneration,
        identity = project.accountIdentity,
        projectId = project.id
      syncing = true
      notify()
      try {
        const result = await fetchHardcoreProgress(mount, abort.signal)
        if (
          token === syncGeneration &&
          identity === project.accountIdentity &&
          projectId === project.id
        )
          setProject(
            reduceProject(project, { type: 'hardcore-result', result }),
          )
      } catch {
        if (token === syncGeneration)
          setProject(
            reduceProject(project, {
              type: 'hardcore-result',
              result: {
                progress: [],
                failures: (['main', 'oak', 'glitch'] as const).map(
                  (setKey) => ({
                    setKey,
                    reason:
                      'Progress refresh failed; last successful data retained.',
                  }),
                ),
              },
            }),
          )
      } finally {
        if (token === syncGeneration) {
          syncing = false
          notify()
        }
      }
    },
    /** Automatic refresh only for a deployment-declared service and a confirmed account. */
    syncDeployment(automatic = true) {
      if (
        deployment.status !== 'private' ||
        !deployment.config.companionUrl ||
        !project.accountIdentity ||
        syncing
      )
        return
      if (automatic && Date.now() - lastAutomaticSync < PROGRESS_INTERVAL)
        return
      lastAutomaticSync = Date.now()
      void controller.sync(deployment.config.companionUrl)
    },
    /** Reads the server-reported account; the caller confirms before set-account-identity. */
    discoverIdentity() {
      if (deployment.status !== 'private' || !deployment.config.companionUrl)
        return Promise.resolve({
          error: 'No progress service is configured.',
        } as const)
      return discoverAccountIdentity(
        deployment.config.companionUrl,
        new AbortController().signal,
      )
    },
    dispose() {
      restoreGeneration++
      saves.cancel()
      syncGeneration++
      syncAbort?.abort()
      listeners.clear()
    },
  }
  if (!error) persist()
  return controller
}
export type Controller = ReturnType<typeof createController>
