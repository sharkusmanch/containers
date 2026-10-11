import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSaveController } from '../src/sources/poller'
import { refreshSave } from '../src/sources/save'
import { activeAttempt, createProject } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { serializeProject } from '../src/state/persist'
import { snapshot, known } from './planner-fixtures'
import type { ParseResult } from '../src/model'
const good = (hash = 'first'): ParseResult => ({
  status: 'readable',
  snapshot: {
    ...snapshot([1]),
    hash,
    importedAt: '2026-10-11T00:00:00.000Z',
    trainer: known({ name: 'RED', id: 1 }),
  },
  issues: [],
})
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function setup() {
  let project = reduceProject(createProject(''), {
    type: 'set-source',
    source: { kind: 'url', url: './save', enabled: true },
  })
  const requests: ReturnType<typeof deferred<ParseResult>>[] = []
  const fetcher = vi.fn(() => {
    const d = deferred<ParseResult>()
    requests.push(d)
    return d.promise
  })
  const controller = createSaveController({
    getProject: () => project,
    setProject: (p) => {
      project = p
    },
    refresh: fetcher,
  })
  return {
    controller,
    requests,
    fetcher,
    get: () => project,
    dispatch: (action: Parameters<typeof reduceProject>[1]) => {
      project = reduceProject(project, action)
    },
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('save controller commits against live generations without depending on cancellation', () => {
  it('stores context synchronously before fetching and preserves canonical on A→B→A', async () => {
    const s = setup(),
      id = s.get().activeAttemptId
    await s.controller.upload(
      async () => new Uint8Array(),
      () => good('canonical-good'),
    )
    const previous = activeAttempt(s.get()).snapshot
    const work = s.controller.refresh()
    expect(s.get().pendingImport?.attemptId).toBe(id)
    s.dispatch({ type: 'create-attempt', kind: 'speedrun', name: 'Fresh' })
    expect(activeAttempt(s.get()).source.url).toBeUndefined()
    expect(activeAttempt(s.get()).snapshot).toBeNull()
    s.dispatch({ type: 'switch-attempt', attemptId: id })
    s.requests[0]!.resolve(good('late'))
    await work
    expect(activeAttempt(s.get()).snapshot).toEqual(previous)
  })
  it('a late URL cannot overwrite a newer upload; upload pauses focus and automatic requests', async () => {
    const s = setup()
    const old = s.controller.refresh()
    const newer = s.controller.upload(
      async () => new Uint8Array([1]),
      () => good('upload'),
    )
    expect(activeAttempt(s.get()).source.paused).toBe(true)
    await newer
    s.requests[0]!.resolve(good('old'))
    await old
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('upload')
    await s.controller.refresh(true)
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    const resumed = s.controller.refresh()
    expect(activeAttempt(s.get()).source.paused).toBe(false)
    s.requests[1]!.resolve(good('url'))
    await resumed
  })
  it('captures upload context before reading and two reverse completions retain newer', async () => {
    const s = setup(),
      first = deferred<Uint8Array>(),
      second = deferred<Uint8Array>()
    const a = s.controller.upload(
      () => {
        expect(s.get().pendingImport?.sourceKind).toBe('upload')
        return first.promise
      },
      () => good('old'),
    )
    const b = s.controller.upload(
      () => second.promise,
      () => good('new'),
    )
    second.resolve(new Uint8Array())
    await b
    first.resolve(new Uint8Array())
    await a
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('new')
  })
  it.each(['source', 'reset', 'restore', 'undo'] as const)(
    '%s invalidates an uncancellable old import',
    async (action) => {
      const s = setup()
      const exported = serializeProject(s.get())
      if (action === 'undo') s.dispatch({ type: 'reset-attempt' })
      if (action === 'undo')
        s.dispatch({
          type: 'set-source',
          source: { kind: 'url', url: './save', enabled: true },
        })
      const work = s.controller.refresh()
      if (action === 'source')
        s.dispatch({
          type: 'set-source',
          source: { kind: 'url', url: './other', enabled: true },
        })
      if (action === 'reset') s.dispatch({ type: 'reset-attempt' })
      if (action === 'restore')
        s.dispatch({ type: 'restore-project', raw: exported })
      if (action === 'undo') s.dispatch({ type: 'undo-reset' })
      s.requests[0]!.resolve(good())
      await work
      expect(activeAttempt(s.get()).snapshot).toBeNull()
    },
  )
  it('does not overlap automatic requests and throttles focus to 30 seconds', async () => {
    vi.useFakeTimers()
    const s = setup(),
      a = s.controller.refresh(true)
    await s.controller.refresh(true)
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    s.requests[0]!.resolve(good())
    await a
    await vi.advanceTimersByTimeAsync(29999)
    await s.controller.refresh(true)
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const b = s.controller.refresh(true)
    s.requests[1]!.resolve(good())
    await b
    expect(s.fetcher).toHaveBeenCalledTimes(2)
  })
  it('times out after ten seconds, retains last good data, and ignores late completion', async () => {
    vi.useFakeTimers()
    const s = setup()
    const first = s.controller.refresh()
    s.requests[0]!.resolve(good())
    await first
    const late = s.controller.refresh()
    await vi.advanceTimersByTimeAsync(10000)
    await late
    expect(activeAttempt(s.get()).source.lastError).toMatch(/10 seconds/)
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('first')
    s.requests[1]!.resolve(good('late'))
    await Promise.resolve()
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('first')
  })
  it('ignored hashes are per attempt; unchanged imports settle and retain freshness', async () => {
    const s = setup()
    s.dispatch({ type: 'ignore-hash', hash: 'ignored' })
    let p = s.controller.refresh()
    s.requests[0]!.resolve(good('ignored'))
    await p
    expect(activeAttempt(s.get()).snapshot).toBeNull()
    s.dispatch({ type: 'create-attempt', kind: 'glitch', name: 'Other' })
    await s.controller.refresh(true)
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    await s.controller.upload(
      async () => new Uint8Array(),
      () => good('ignored'),
    )
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('ignored')
    await s.controller.upload(
      async () => new Uint8Array(),
      () => good('ignored'),
    )
    expect(s.get().pendingImport).toBeNull()
    expect(activeAttempt(s.get()).source.lastImportAt).toBe(
      '2026-10-11T00:00:00.000Z',
    )
  })
  it('holds changed trainer URL and keeps previous snapshot until assigned', async () => {
    const s = setup()
    let p = s.controller.refresh()
    s.requests[0]!.resolve(good())
    await p
    p = s.controller.refresh()
    const changed = good('foreign')
    if (changed.status !== 'rejected')
      changed.snapshot.trainer = known({ name: 'BLUE', id: 2 })
    s.requests[1]!.resolve(changed)
    await p
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('first')
    expect(activeAttempt(s.get()).heldImport?.snapshot.hash).toBe('foreign')
    s.dispatch({
      type: 'assign-held',
      targetAttemptId: s.get().activeAttemptId,
    })
    expect(activeAttempt(s.get()).snapshot?.hash).toBe('foreign')
  })
})
describe('private save transport', () => {
  const context = {
    projectId: 'p',
    attemptId: 'a',
    sourceRevision: 0,
    sourceKind: 'url' as const,
    generation: 1,
  }
  it.each([403, 404, 500])(
    'rejects HTTP %s without losing the current snapshot',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('no', { status })),
      )
      await expect(
        refreshSave(context, './save', new AbortController().signal),
      ).rejects.toThrow(/Save endpoint/)
    },
  )
  it('rejects login HTML and unreachable endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>login</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    )
    await expect(
      refreshSave(context, './save', new AbortController().signal),
    ).rejects.toThrow(/HTML/)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('network')
      }),
    )
    await expect(
      refreshSave(context, './save', new AbortController().signal),
    ).rejects.toThrow(/unavailable/)
  })
})
