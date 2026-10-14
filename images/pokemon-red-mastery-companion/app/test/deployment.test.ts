import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH, SIGNED_OUT, loadDeploymentConfig, parseDeploymentConfig } from '../src/sources/deployment'
import type { DeploymentState } from '../src/sources/deployment'
import { refreshSave } from '../src/sources/save'
import { discoverAccountIdentity, fetchHardcoreProgress } from '../src/sources/ra'
import { activeAttempt, adoptDeploymentSave, canonicalAttempt, createAttempt, createProject } from '../src/state/project'
import { reduceProject } from '../src/state/reducer'
import { restoreProject, serializeProject } from '../src/state/persist'
import { PROGRESS_INTERVAL, STORAGE_KEY, createController } from '../src/ui/controller'
import { saveStatus } from '../src/ui/status'
import { known, snapshot } from './planner-fixtures'
import sets from '../src/data/sets.json'

const privateDeployment: DeploymentState = { status: 'private', config: { saveUrl: './save', companionUrl: './companion/', guideUrl: 'https://wiki.example/doc' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** A browser `redirect: 'manual'` answer: opaque, status 0. */
const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) as unknown as Response
const memory = (initial?: string) => {
  const map = new Map<string, string>(initial ? [[STORAGE_KEY, initial]] : [])
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } } }
}
const withSnapshot = () => {
  let p = reduceProject(createProject(''), { type: 'set-branches', branches: { starter: 'charmander' } })
  p = reduceProject(p, { type: 'record-manual', key: 'rule:108020:completed', value: true })
  const a = activeAttempt(p)
  return { ...p, attempts: [{ ...a, snapshot: { ...snapshot([4]), importedAt: '2026-10-11T00:00:00.000Z', trainer: known({ name: 'RED', id: 1 }) } }] }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('deployment config detection', () => {
  it('accepts only same-origin relative routes and an https guide link', () => {
    expect(parseDeploymentConfig({ saveUrl: './save', companionUrl: '/companion/', guideUrl: 'https://wiki.example/doc' }))
      .toEqual({ saveUrl: './save', companionUrl: '/companion/', guideUrl: 'https://wiki.example/doc' })
    expect(parseDeploymentConfig({ saveUrl: 'https://evil.example/save', companionUrl: '//evil.example/', guideUrl: 'javascript:alert(1)' })).toEqual({})
    expect(parseDeploymentConfig({ saveUrl: 'javascript:alert(1)', guideUrl: 'http://wiki.example/' })).toEqual({})
    expect(parseDeploymentConfig({ saveUrl: './save?x=<b>' })).toEqual({})
    expect(parseDeploymentConfig(['./save'])).toEqual({})
  })
  it('present JSON declares a private deployment, using a same-origin manual-redirect request', async () => {
    const fetcher = vi.fn(async () => json({ saveUrl: './save', companionUrl: './companion/' }))
    await expect(loadDeploymentConfig(fetcher)).resolves.toEqual({ status: 'private', config: { saveUrl: './save', companionUrl: './companion/' } })
    expect(fetcher).toHaveBeenCalledWith(CONFIG_PATH, expect.objectContaining({ redirect: 'manual', credentials: 'same-origin', cache: 'no-store' }))
  })
  it.each([
    ['404 (public Pages)', () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } })],
    ['HTML 200 (SPA fallback)', () => new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html' } })],
    ['empty JSON object', () => json({})],
    ['malformed JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
  ])('%s means public/manual mode', async (_, make) => {
    await expect(loadDeploymentConfig(vi.fn(async () => make()))).resolves.toEqual({ status: 'public' })
  })
  it('network failure and a stalled request fall back to public mode', async () => {
    await expect(loadDeploymentConfig(vi.fn(async () => { throw TypeError('offline') }))).resolves.toEqual({ status: 'public', unreachable: true })
    vi.useFakeTimers()
    const stalled = loadDeploymentConfig(vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Error('aborted'))))), 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(stalled).resolves.toEqual({ status: 'public', unreachable: true })
  })
  it('an auth redirect or 401 reports a signed-out session (HTML login behind a redirect)', async () => {
    await expect(loadDeploymentConfig(vi.fn(async () => opaqueRedirect()))).resolves.toEqual({ status: 'signed-out' })
    await expect(loadDeploymentConfig(vi.fn(async () => new Response(null, { status: 302, headers: { Location: '/oauth2/sign_in' } })))).resolves.toEqual({ status: 'signed-out' })
    await expect(loadDeploymentConfig(vi.fn(async () => new Response('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })))).resolves.toEqual({ status: 'signed-out' })
  })
})

describe('adopting the deployment save route', () => {
  it('fills an unset canonical source and enables automatic refresh', () => {
    const p = createProject(), next = adoptDeploymentSave(p, './save'), a = activeAttempt(next)
    expect(a.source).toMatchObject({ kind: 'url', url: './save', enabled: true, paused: false, origin: 'deployment', revision: 1 })
    expect(adoptDeploymentSave(next, './save')).toBe(next)
  })
  it('keeps an existing project’s observation, marks and choices without a continuity review', () => {
    const p = withSnapshot(), next = adoptDeploymentSave(p, './save'), a = activeAttempt(next)
    expect(a.snapshot).toEqual(activeAttempt(p).snapshot)
    expect(a.branches).toEqual({ starter: 'charmander' })
    expect(a.manualEvidence.map((e) => e.status)).toEqual(['active'])
    expect(a.continuityRevision).toBe(activeAttempt(p).continuityRevision)
    expect(restoreProject(serializeProject(next)).ok).toBe(true)
  })
  it('never replaces a URL the player set, nor a source the player deliberately cleared', () => {
    const own = reduceProject(createProject(), { type: 'set-source', source: { kind: 'url', url: './my-save', enabled: false } })
    expect(adoptDeploymentSave(own, './save')).toBe(own)
    const legacy = createProject()
    legacy.attempts[0]!.source = { kind: 'url', url: './old', revision: 3 }
    expect(adoptDeploymentSave(legacy, './save')).toBe(legacy)
    const cleared = reduceProject(adoptDeploymentSave(createProject(), './save'), { type: 'set-source', source: { kind: 'upload', url: undefined, enabled: false } })
    expect(activeAttempt(cleared).source.origin).toBe('user')
    expect(adoptDeploymentSave(cleared, './save')).toBe(cleared)
  })
  it('follows a changed deployment route only for a deployment-adopted source', () => {
    const adopted = adoptDeploymentSave(createProject(), './save')
    expect(activeAttempt(adoptDeploymentSave(adopted, './saves/red')).source).toMatchObject({ url: './saves/red', revision: 2 })
    expect(adoptDeploymentSave(adopted, undefined)).toBe(adopted)
  })
  it('never gives glitch or speedrun attempts the canonical save, even when active', () => {
    const p = createAttempt(createAttempt(createProject(), 'glitch', 'Glitch later'), 'speedrun', 'Fresh run')
    const next = adoptDeploymentSave(p, './save')
    expect(next.attempts.filter((a) => a.kind !== 'canonical').map((a) => a.source.url)).toEqual([undefined, undefined])
    expect(canonicalAttempt(next)!.source.url).toBe('./save')
    expect(next.activeAttemptId).toBe(p.activeAttemptId)
  })
  it('invalidates a pending canonical import for the old source', () => {
    const p = reduceProject(createProject(), { type: 'request-import', sourceKind: 'upload' })
    const next = adoptDeploymentSave(p, './save')
    expect(next.pendingImport).toBeNull()
    expect(next.importGeneration).toBeGreaterThan(p.importGeneration)
  })
})

describe('controller migration', () => {
  it('migrates a stored pre-change project on startup and persists it with data intact', () => {
    const { map, storage } = memory(serializeProject(withSnapshot()))
    const c = createController({ storage, deployment: privateDeployment })
    const a = activeAttempt(c.getProject())
    expect(a.source).toMatchObject({ url: './save', enabled: true, origin: 'deployment' })
    expect(a.manualEvidence).toHaveLength(1)
    const stored = restoreProject(map.get(STORAGE_KEY)!)
    expect(stored.ok && activeAttempt(stored.project).source.url).toBe('./save')
  })
  it('public mode leaves the stored project untouched', () => {
    const original = serializeProject(withSnapshot())
    const c = createController({ storage: memory(original).storage })
    expect(activeAttempt(c.getProject()).source.url).toBeUndefined()
    expect(c.getDeployment()).toEqual({ status: 'public' })
  })
  it('re-adopts after a reset, restores a Pages backup into auto mode, and respects an explicit clear', () => {
    const c = createController({ storage: null, deployment: privateDeployment })
    c.dispatch({ type: 'reset-attempt' })
    expect(activeAttempt(c.getProject()).source.url).toBe('./save')
    c.dispatch({ type: 'restore-project', raw: serializeProject(withSnapshot()) })
    expect(activeAttempt(c.getProject()).source).toMatchObject({ url: './save', enabled: true })
    expect(activeAttempt(c.getProject()).manualEvidence).toHaveLength(1)
    c.dispatch({ type: 'set-source', source: { kind: 'upload', url: undefined, enabled: false } })
    expect(activeAttempt(c.getProject()).source.url).toBeUndefined()
    c.dispatch({ type: 'set-branches', branches: { fossil: 'helix' } })
    expect(activeAttempt(c.getProject()).source.url).toBeUndefined()
  })
})

describe('signed-out sessions', () => {
  const context = { projectId: 'p', attemptId: 'a', sourceRevision: 0, sourceKind: 'url' as const, generation: 1 }
  it.each([
    ['opaque redirect', opaqueRedirect],
    ['302', () => new Response(null, { status: 302, headers: { Location: '/oauth2/sign_in' } })],
    ['401', () => new Response('', { status: 401 })],
  ])('save route %s reports signed out and asks for a reload', async (_, make) => {
    const fetcher = vi.fn(async () => make())
    vi.stubGlobal('fetch', fetcher)
    await expect(refreshSave(context, './save', new AbortController().signal)).rejects.toThrow(SIGNED_OUT)
    expect(fetcher).toHaveBeenCalledWith('./save', expect.objectContaining({ redirect: 'manual', credentials: 'same-origin' }))
  })
  it('controller keeps the last good snapshot and the status line says signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect()))
    const c = createController({ initial: withSnapshot(), storage: null, deployment: privateDeployment })
    const before = activeAttempt(c.getProject()).snapshot
    await c.saves.refresh()
    const p = c.getProject(), a = activeAttempt(p)
    expect(a.snapshot).toEqual(before)
    const status = saveStatus(p, a, c.getDeployment())
    expect(status).toMatchObject({ signedOut: true, tone: 'warn' })
    expect(status.text).toMatch(/^Signed out — reload to sign in · showing save loaded/)
  })
  it('a signed-out config load is shown even without a save', () => {
    const p = createProject()
    expect(saveStatus(p, activeAttempt(p), { status: 'signed-out' }).text).toBe('Signed out — reload to sign in')
  })
  it('hardcore feeds report signed out instead of a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect()))
    const result = await fetchHardcoreProgress('./companion/', new AbortController().signal)
    expect(result.failures.map((f) => f.reason)).toEqual([SIGNED_OUT, SIGNED_OUT, SIGNED_OUT])
  })
})

describe('hardcore connection', () => {
  const feed = (set: (typeof sets)[number], identity = 'player-one') => ({ source: 'ra', id: String(set.apiGameId), accountIdentity: identity, fetchedAt: '2026-10-13T00:00:00Z', stale: false,
    achievements: set.expectedPublishedIds.map((id) => ({ id: String(id), unlocked: false, unlockedAt: null })) })
  const server = (identity = 'player-one') => vi.fn(async (url: string) => json(feed(sets.find((s) => url.endsWith(`/${s.apiGameId}`))!, identity)))
  it('discovers the server-reported account without storing it', async () => {
    const fetcher = server()
    vi.stubGlobal('fetch', fetcher)
    const c = createController({ storage: null, deployment: privateDeployment })
    await expect(c.discoverIdentity()).resolves.toEqual({ identity: 'player-one' })
    expect(c.getProject().accountIdentity).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('./companion/api/achievements/ra/724')
  })
  it('discovery reports bad answers and never runs in public mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ source: 'ra', id: '724' })))
    await expect(discoverAccountIdentity('./companion/', new AbortController().signal)).resolves.toEqual({ error: 'The server did not report an account.' })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(createController({ storage: null }).discoverIdentity()).resolves.toHaveProperty('error')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('automatic refresh needs a confirmed identity and is throttled; mismatched accounts are rejected', async () => {
    const fetcher = server()
    vi.stubGlobal('fetch', fetcher)
    const c = createController({ storage: null, deployment: privateDeployment })
    c.syncDeployment()
    expect(fetcher).not.toHaveBeenCalled()
    c.dispatch({ type: 'set-account-identity', identity: 'player-one' })
    c.syncDeployment()
    await vi.waitFor(() => expect(c.isSyncing()).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(c.getProject().accountProgress.every((f) => f.lastSuccessfulFetchAt && !f.stale)).toBe(true)
    c.syncDeployment()
    expect(fetcher).toHaveBeenCalledTimes(3)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PROGRESS_INTERVAL + 1)
    vi.stubGlobal('fetch', server('someone-else'))
    c.syncDeployment()
    await vi.waitFor(() => expect(c.isSyncing()).toBe(false))
    expect(c.getProject().accountProgress.every((f) => f.stale && f.unavailableReason)).toBe(true)
    vi.restoreAllMocks()
  })
})
