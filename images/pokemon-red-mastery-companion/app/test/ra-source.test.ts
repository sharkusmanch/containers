import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHardcoreProgress } from '../src/sources/ra'
import { dataset } from '../src/data/manifest'
import { createProject, activeAttempt } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { createController } from '../src/ui/controller'

const at = '2026-10-11T12:00:00.000Z'
function feed(index: number, over: Record<string, unknown> = {}) {
  const set = dataset.sets[index]
  return { source: 'ra', id: String(set.apiGameId), title: set.title, accountIdentity: 'tester', fetchedAt: at,
    stale: false, total: set.expectedPublishedIds.length, unlocked: 1,
    achievements: set.expectedPublishedIds.map((id, i) => ({ id: String(id), unlocked: i === 0, unlockedAt: i === 0 ? at : null })), ...over }
}
function mockFeeds(bodies = dataset.sets.map((_, i) => feed(i)), status = [200, 200, 200]) {
  const paths: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    paths.push(url)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const i = dataset.sets.findIndex(set => url.endsWith('/' + set.apiGameId))
    if (status[i] === 0) throw new Error('private upstream details')
    return new Response(JSON.stringify(bodies[i]), { status: status[i] })
  })
  return paths
}
const refresh = () => fetchHardcoreProgress('https://service.test/companion/', new AbortController().signal)
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('hardcore progress source', () => {
  it('reads all three declared backing sets with independent membership and metadata', async () => {
    const paths = mockFeeds()
    const result = await refresh()
    expect(paths).toEqual([724, 16084, 11632].map(id => `https://service.test/companion/api/achievements/ra/${id}`))
    expect(result.failures).toEqual([])
    expect(result.progress.map(p => [p.setKey, p.apiGameId, p.accountIdentity, p.lastSuccessfulFetchAt, p.unlocks])).toEqual(dataset.sets.map(s => [s.key, s.apiGameId, 'tester', at, [{ achievementId: s.expectedPublishedIds[0], earnedAt: at }]]))
  })
  it('keeps locked and softcore-only entries locked even when a timestamp is present', async () => {
    const main = feed(0)
    main.achievements[1] = { ...main.achievements[1], unlocked: false, unlockedAt: at }
    mockFeeds([main, feed(1), feed(2)])
    const result = await refresh()
    expect(result.failures).toEqual([])
    expect(result.progress[0].unlocks).toEqual([{ achievementId: dataset.sets[0].expectedPublishedIds[0], earnedAt: at }])
  })
  it.each([null, 'junk', '2026-02-30T00:00:00.000Z', '2026-10-11T24:00:00.000Z', '2026-10-11T00:60:00.000Z', '2026-10-11T00:00:60.000Z', '2026-10-11T12:00:00+00:00'])('fails the affected feed when an unlocked timestamp is unreadable: %s', async timestamp => {
    const main = feed(0)
    main.achievements[0].unlockedAt = timestamp
    mockFeeds([main, feed(1), feed(2)])
    const result = await refresh()
    expect(result.progress.map(p => p.setKey)).toEqual(['oak', 'glitch'])
    expect(result.failures).toEqual([{ setKey: 'main', reason: expect.stringContaining('Invalid hardcore unlock timestamp') }])
  })
  it.each([null, 'junk'])('retains last good main progress/time while valid Oak/glitch feeds update after unreadable timestamp %s', async timestamp => {
    mockFeeds()
    let project = createProject('tester')
    project = reduceProject(project, { type: 'record-manual', key: 'route-step', value: true })
    project = reduceProject(project, { type: 'hardcore-result', result: await refresh() })
    const priorMain = project.accountProgress.find(p => p.setKey === 'main')!
    const attempt = activeAttempt(project)
    const nextAt = '2026-10-11T13:00:00.000Z'
    const main = feed(0, { fetchedAt: nextAt })
    main.achievements[0].unlockedAt = timestamp
    const validFeeds = [1, 2].map(i => {
      const next = feed(i, { fetchedAt: nextAt })
      next.achievements[1] = { ...next.achievements[1], unlocked: true, unlockedAt: nextAt }
      return next
    })
    mockFeeds([main, ...validFeeds])
    project = reduceProject(project, { type: 'hardcore-result', result: await refresh() })
    expect(project.accountProgress.find(p => p.setKey === 'main')).toEqual({ ...priorMain, stale: true,
      unavailableReason: expect.stringContaining('Invalid hardcore unlock timestamp') })
    for (const setKey of ['oak', 'glitch']) {
      const feed = project.accountProgress.find(p => p.setKey === setKey)!
      expect(feed.lastSuccessfulFetchAt).toBe(nextAt)
      expect(feed.stale).toBe(false)
      expect(feed.unlocks).toHaveLength(2)
    }
    expect(activeAttempt(project)).toEqual(attempt)
  })
  it('rejects unreadable achievement state instead of claiming an empty unlocked set', async () => {
    const main = feed(0)
    const malformed = { ...main, achievements: main.achievements.map((a, i) => i === 0 ? { id: a.id, unlockedAt: null } : a) }
    mockFeeds([malformed, feed(1), feed(2)])
    const result = await refresh()
    expect(result.progress.map(p => p.setKey)).toEqual(['oak', 'glitch'])
    expect(result.failures).toEqual([{ setKey: 'main', reason: expect.stringContaining('Invalid achievement state') }])
  })
  it('rejects mixed account identities without picking a majority', async () => {
    mockFeeds([feed(0), feed(1, { accountIdentity: 'other' }), feed(2)])
    const result = await refresh()
    expect(result.progress).toEqual([])
    expect(result.failures).toHaveLength(3)
    expect(result.failures.every(f => /account/i.test(f.reason))).toBe(true)
  })
  it.each([{ id: '999' }, { source: 'steam' }, { accountIdentity: null }, { fetchedAt: '2026-02-30T00:00:00Z' }])('rejects unattributable feed %j independently', async over => {
    mockFeeds([feed(0, over), feed(1), feed(2)])
    const result = await refresh()
    expect(result.progress.map(p => p.setKey)).toEqual(['oak', 'glitch'])
    expect(result.failures.map(f => f.setKey)).toEqual(['main'])
  })
  it('reports changed published membership as dataset-drift', async () => {
    const main = feed(0); main.achievements[0].id = '999999'
    mockFeeds([main, feed(1), feed(2)])
    expect((await refresh()).failures).toEqual([{ setKey: 'main', reason: expect.stringContaining('dataset-drift') }])
  })
  it.each([403, 404, 0])('keeps main/glitch successful when Oak returns %s', async status => {
    mockFeeds(undefined, [200, status, 200])
    const result = await refresh()
    expect(result.progress.map(p => p.setKey)).toEqual(['main', 'glitch'])
    expect(result.failures.map(f => f.setKey)).toEqual(['oak'])
    expect(JSON.stringify(result)).not.toContain('private upstream details')
  })
  it('preserves prior good progress/time and manual attempt history on stale, denied or network results', async () => {
    mockFeeds()
    let project = createProject('tester')
    project = reduceProject(project, { type: 'record-manual', key: 'route-step', value: true })
    project = reduceProject(project, { type: 'hardcore-result', result: await refresh() })
    const prior = project.accountProgress
    const attempt = activeAttempt(project)
    mockFeeds([feed(0, { stale: true }), feed(1), feed(2)], [200, 403, 0])
    const result = await refresh()
    expect(result.progress).toEqual([])
    project = reduceProject(project, { type: 'hardcore-result', result })
    expect(project.accountProgress.map(p => [p.unlocks, p.lastSuccessfulFetchAt])).toEqual(prior.map(p => [p.unlocks, p.lastSuccessfulFetchAt]))
    expect(project.accountProgress.every(p => p.stale && p.unavailableReason)).toBe(true)
    expect(activeAttempt(project)).toEqual(attempt)
  })
  it('leaves unknown failed feeds unsynced and rejects mismatch against the project account', async () => {
    mockFeeds()
    const project = reduceProject(createProject('other'), { type: 'hardcore-result', result: await refresh() })
    expect(project.accountProgress.every(p => p.lastSuccessfulFetchAt === null && p.unlocks.length === 0 && p.stale)).toBe(true)
    expect(activeAttempt(project).snapshot).toBeNull()
  })
  it('keeps disabled sync manual and does not request the network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const result = await fetchHardcoreProgress('', new AbortController().signal)
    expect(fetch).not.toHaveBeenCalled()
    expect(result.progress).toEqual([])
    expect(result.failures).toHaveLength(3)
  })
})


describe('independent feed deadlines and cancellation', () => {
  it.each([
    ['fetch', true], ['fetch', false], ['body', true], ['body', false],
  ] as const)('commits two good feeds while main %s hangs (respects abort: %s)', async (phase, respectsAbort) => {
    const controller = createController({ initial: createProject('tester'), storage: null })
    controller.dispatch({ type: 'record-manual', key: 'history', value: true })
    mockFeeds()
    await controller.sync('/companion/')
    const previousMain = controller.getProject().accountProgress.find(p => p.setKey === 'main')!
    const attempts = controller.getProject().attempts
    const nextAt = '2026-10-11T13:00:00.000Z'
    const nextFeeds = dataset.sets.map((_, i) => {
      const next = feed(i, { fetchedAt: nextAt })
      next.achievements[1] = { ...next.achievements[1], unlocked: true, unlockedAt: nextAt }
      return next
    })
    let completeLate!: () => void
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const i = dataset.sets.findIndex(set => url.endsWith('/' + set.apiGameId))
      if (i !== 0) return new Response(JSON.stringify(nextFeeds[i]))
      const pending = new Promise<unknown>((resolve, reject) => {
        completeLate = () => resolve(phase === 'body' ? nextFeeds[0] : new Response(JSON.stringify(nextFeeds[0])))
        if (respectsAbort) init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return phase === 'body' ? { ok: true, json: () => pending } : pending
    })
    vi.useFakeTimers()
    let settled = false
    const work = controller.sync('/companion/').then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(true)
    await work
    expect(controller.getProject().accountProgress.find(p => p.setKey === 'main')).toEqual({
      ...previousMain, stale: true, unavailableReason: expect.stringContaining('timed out'),
    })
    for (const setKey of ['oak', 'glitch']) {
      const current = controller.getProject().accountProgress.find(p => p.setKey === setKey)!
      expect(current.lastSuccessfulFetchAt).toBe(nextAt)
      expect(current.unlocks).toHaveLength(2)
      expect(current.stale).toBe(false)
    }
    const committed = controller.getProject()
    completeLate()
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.getProject()).toBe(committed)
    expect(controller.getProject().attempts).toBe(attempts)
  })
  it('cancels without waiting for an abort-ignoring body and ignores its late identity', async () => {
    let completeLate!: () => void
    vi.stubGlobal('fetch', async (url: string) => {
      const i = dataset.sets.findIndex(set => url.endsWith('/' + set.apiGameId))
      if (i !== 0) return new Response(JSON.stringify(feed(i)))
      return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(feed(0, { accountIdentity: 'other' })) }) }
    })
    vi.useFakeTimers()
    const controller = createController({ initial: createProject('tester'), storage: null })
    let settled = false
    const work = controller.sync('/companion/').then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    controller.dispatch({ type: 'set-account-identity', identity: 'new-account' })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await work
    completeLate()
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.getProject().accountIdentity).toBe('new-account')
    expect(controller.getProject().accountProgress).toEqual([])
  })
  it('keeps mixed completed identities fail-closed when the third feed times out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async (url: string) => {
      const i = dataset.sets.findIndex(set => url.endsWith('/' + set.apiGameId))
      if (i === 2) return new Promise(() => {})
      return new Response(JSON.stringify(feed(i, { accountIdentity: i === 0 ? 'tester' : 'other' })))
    })
    let result: Awaited<ReturnType<typeof refresh>> | undefined
    const work = refresh().then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(result).toBeDefined()
    await work
    expect(result!.progress).toEqual([])
    expect(result!.failures).toEqual(expect.arrayContaining([
      { setKey: 'main', reason: expect.stringMatching(/identity mismatch/) },
      { setKey: 'oak', reason: expect.stringMatching(/identity mismatch/) },
      { setKey: 'glitch', reason: expect.stringMatching(/timed out/) },
    ]))
  })
})
