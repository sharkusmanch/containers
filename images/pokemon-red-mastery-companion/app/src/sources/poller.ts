import type { ImportContext, MasteryProject, ParseResult } from '../model'
import { activeAttempt, beginImport, applySnapshot } from '../state/project'
import { reduceProject } from '../state/reducer'
import { parseRedSave } from '../save/parse'
import { refreshSave } from './save'
export const AUTOMATIC_INTERVAL = 30_000
export const SOURCE_TIMEOUT = 10_000
interface Options {
  getProject: () => MasteryProject
  setProject: (project: MasteryProject) => void
  refresh?: typeof refreshSave
}
/** Cancellation is a courtesy; full-context reducer guards are the authority. */
export function createSaveController({
  getProject,
  setProject,
  refresh = refreshSave,
}: Options) {
  let active:
    | { context: ImportContext; abort: AbortController; cancelWait: () => void }
    | undefined
  const lastRequest = new Map<string, number>()
  function cancel() {
    if (!active) return
    const job = active
    active = undefined
    job.abort.abort()
    job.cancelWait()
    setProject(
      reduceProject(getProject(), {
        type: 'cancel-import',
        context: job.context,
      }),
    )
  }
  async function run(
    kind: 'upload' | 'url',
    operation: (
      context: ImportContext,
      signal: AbortSignal,
    ) => Promise<ParseResult>,
  ) {
    cancel()
    const started = beginImport(getProject(), kind)
    // This MUST happen before operation (including file.arrayBuffer) can run.
    setProject(started.project)
    const { context } = started,
      abort = new AbortController()
    let cancelWait!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancelWait = () => reject(new Error('Save import cancelled.'))
    })
    const job = { context, abort, cancelWait }
    active = job
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(
            new Error(
              'Save refresh timed out after 10 seconds. Last good save retained.',
            ),
          )
        }, SOURCE_TIMEOUT)
      })
      const result = await Promise.race([
        operation(context, abort.signal),
        timeout,
        cancelled,
      ])
      setProject(applySnapshot(getProject(), context, result))
    } catch (error) {
      setProject(
        reduceProject(getProject(), {
          type: 'import-error',
          context,
          reason:
            error instanceof Error ? error.message : 'Save import failed.',
        }),
      )
    } finally {
      clearTimeout(timer)
      if (active === job) active = undefined
    }
  }
  return {
    cancel,
    async refresh(automatic = false) {
      const project = getProject(),
        attempt = activeAttempt(project),
        url = attempt.source.url
      if (!url?.trim()) return
      const key = `${project.id}/${attempt.id}/${attempt.source.revision}`
      if (
        automatic &&
        (!attempt.source.enabled ||
          attempt.source.paused ||
          project.pendingImport ||
          Date.now() - (lastRequest.get(key) ?? -Infinity) < AUTOMATIC_INTERVAL)
      )
        return
      lastRequest.set(key, Date.now())
      // URL is captured before run/beginImport and never reread after an await.
      await run('url', (context, signal) => refresh(context, url, signal))
    },
    upload(
      read: () => Promise<Uint8Array>,
      parse: (bytes: Uint8Array) => ParseResult = parseRedSave,
    ) {
      return run('upload', async () => parse(await read()))
    },
  }
}
