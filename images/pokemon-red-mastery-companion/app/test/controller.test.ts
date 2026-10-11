import { afterEach, expect, it, vi } from 'vitest'
import { createController, STORAGE_KEY } from '../src/ui/controller'
import { activeAttempt, createProject } from '../src/state/project'
import { serializeProject } from '../src/state/persist'
import { snapshot } from './planner-fixtures'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('persists a fresh anonymous startup and reloads the same valid project', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
  }
  const first = createController({ storage })
  expect(values.has(STORAGE_KEY)).toBe(true)
  const second = createController({ storage })
  expect(second.getProject().id).toBe(first.getProject().id)
  expect(second.getProject().accountIdentity).toBeNull()
})
it('keeps unreadable stored data recoverable instead of overwriting it on startup', () => {
  let raw = 'broken export'
  const c = createController({
    storage: {
      getItem: () => raw,
      setItem: (_, v) => {
        raw = v
      },
    },
  })
  expect(raw).toBe('broken export')
  expect(c.getError()).toMatch(/needs recovery/)
})
it('serialization failure keeps live project and exposes recovery error', () => {
  const c = createController({ storage: null })
  const p = c.getProject()
  p.version = 999
  expect(c.exportProject()).toBe('')
  expect(c.getProject()).toBe(p)
  expect(c.getError()).toMatch(/export/)
})
it('HTTP and parse failures retain the last good snapshot and manual history', async () => {
  const p = createProject()
  p.attempts[0]!.snapshot = {
    ...snapshot([1]),
    importedAt: '2026-10-11T00:00:00.000Z',
  }
  const c = createController({ initial: p, storage: null })
  c.dispatch({
    type: 'set-source',
    source: { kind: 'url', url: './save', enabled: true },
  })
  c.dispatch({ type: 'record-manual', key: 'history', value: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 404 })),
  )
  await c.saves.refresh()
  expect(activeAttempt(c.getProject()).snapshot?.hash).toBe('test')
  expect(activeAttempt(c.getProject()).source.lastError).toMatch(/404/)
  await c.saves.upload(async () => new Uint8Array(3))
  expect(activeAttempt(c.getProject()).snapshot?.hash).toBe('test')
  expect(activeAttempt(c.getProject()).manualEvidence).toHaveLength(1)
})
it('restore, source change and reset invalidate pending uploads even if reads cannot cancel', async () => {
  const c = createController({ storage: null }),
    raw = c.exportProject()
  let resolve!: (v: Uint8Array) => void
  const pending = c.saves.upload(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  c.dispatch({ type: 'restore-project', raw })
  resolve(new Uint8Array(3))
  await pending
  expect(activeAttempt(c.getProject()).source.lastError).toBeUndefined()
  expect(c.getProject().pendingImport).toBeNull()
})
it('account changes cannot accept an in-flight old-account result; sync remains manual', async () => {
  const c = createController({ storage: null })
  const fetcher = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetcher)
  await c.sync('')
  expect(fetcher).not.toHaveBeenCalled()
  c.dispatch({ type: 'set-account-identity', identity: 'red' })
  vi.useFakeTimers()
  const pending = c.sync('/companion/')
  expect(fetcher).toHaveBeenCalledTimes(3)
  c.dispatch({ type: 'set-account-identity', identity: 'blue' })
  await vi.advanceTimersByTimeAsync(10000)
  await pending
  expect(c.getProject().accountProgress).toEqual([])
})
it('export restores exact source settings, branches, manual history and independent feeds', () => {
  const c = createController({ storage: null })
  c.dispatch({
    type: 'set-source',
    source: { kind: 'url', url: './own-save', enabled: true },
  })
  c.dispatch({ type: 'set-branches', branches: { starter: 'squirtle' } })
  c.dispatch({ type: 'record-manual', key: 'rule:4401:completed', value: true })
  c.dispatch({ type: 'set-account-identity', identity: 'red' })
  c.dispatch({
    type: 'hardcore-result',
    result: {
      progress: [
        {
          setKey: 'main',
          apiGameId: 724,
          accountIdentity: 'red',
          lastSuccessfulFetchAt: '2026-10-11T00:00:00.000Z',
          stale: false,
          unlocks: [
            { achievementId: 4401, earnedAt: '2026-10-10T00:00:00.000Z' },
          ],
        },
      ],
      failures: [],
    },
  })
  const before = c.exportProject()
  c.dispatch({ type: 'reset-attempt' })
  expect(c.getProject().accountProgress[0]!.unlocks).toHaveLength(1)
  c.dispatch({ type: 'undo-reset' })
  expect(activeAttempt(c.getProject()).source.url).toBe('./own-save')
  c.dispatch({ type: 'restore-project', raw: before })
  expect(activeAttempt(c.getProject()).branches.starter).toBe('squirtle')
  expect(activeAttempt(c.getProject()).manualEvidence).toHaveLength(1)
  expect(serializeProject(c.getProject())).toContain('own-save')
})

it('exposes expired held-import assignment after attempt switching without losing the held record', async () => {
  const c = createController({ storage: null })
  c.dispatch({
    type: 'set-source',
    source: { kind: 'url', url: './save', enabled: false },
  })
  const p = c.getProject(),
    a = activeAttempt(p)
  // A stored held observation from the previous import generation is diagnostic history only.
  a.heldImport = {
    context: {
      projectId: p.id,
      attemptId: a.id,
      sourceRevision: a.source.revision,
      sourceKind: 'url',
      generation: p.importGeneration - 1,
    },
    snapshot: { ...snapshot(), importedAt: '2026-10-11T00:00:00.000Z' },
    issues: [],
  }
  expect(c.canAssignHeld()).toBe(false)
  a.heldImport.context.generation = p.importGeneration
  expect(c.canAssignHeld()).toBe(true)
})
