// @vitest-environment happy-dom
// Regressions found in the pre-release review (C1, I1–I3, M2, M4, missing tests).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { App } from '../../src/ui/App'
import { STORAGE_KEY, createController } from '../../src/ui/controller'
import { activeAttempt, adoptDeploymentSave, canonicalAttempt, createAttempt, createProject } from '../../src/state/project'
import { reduceProject } from '../../src/state/reducer'
import { restoreProject, serializeProject } from '../../src/state/persist'
import { SIGNED_OUT } from '../../src/sources/deployment'
import type { DeploymentState } from '../../src/sources/deployment'
import { saveStatus } from '../../src/ui/status'
import { dataset } from '../../src/data/manifest'
import { known, snapshot } from '../planner-fixtures'

const privateDeployment: DeploymentState = { status: 'private', config: { saveUrl: './save', companionUrl: './companion/' } }
const bytes = () => new Response(new Uint8Array(32768), { headers: { 'Content-Type': 'application/octet-stream' } })
const urls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map((call) => String(call[0]))
/** A project as exported from the private deployment: adopted address, a snapshot and one mark. */
function privateExport() {
  let p = adoptDeploymentSave(createProject(''), './save')
  p = reduceProject(p, { type: 'record-manual', key: 'rule:108020:completed', value: true })
  const a = activeAttempt(p)
  p = { ...p, attempts: [{ ...a, snapshot: { ...snapshot([4]), importedAt: '2026-10-11T00:00:00.000Z', trainer: known({ name: 'RED', id: 1 }) } }] }
  return serializeProject(p)
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('C1: no achievement claims an in-game tested method; source-audited rules say so plainly', () => {
  render(<App controller={createController({ storage: null })} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'Achievements', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Professor Oak', exact: true }))
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/Method tested/)
  expect(text).toMatch(/Method checked against the game’s source code \(not tested in-game\)/)
  for (const match of text.matchAll(/[^.·]*\btested\b[^.·]*/g)) expect(match[0]).toMatch(/not tested|none has been tested|not yet tested/)
})

describe('I1: a deployment address is never requested without the private host', () => {
  it('public mode with a restored private export makes no save request, even on focus or Reload', async () => {
    const fetcher = vi.fn(async () => bytes())
    vi.stubGlobal('fetch', fetcher)
    const c = createController({ storage: { getItem: () => privateExport(), setItem: () => {} } })
    expect(activeAttempt(c.getProject()).source).toMatchObject({ url: './save', origin: 'deployment' })
    render(<App controller={c} dataset={dataset} />)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await c.saves.refresh()
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull()
    expect(screen.getAllByText(/belongs to the private server/).length).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).not.toHaveBeenCalled()
    // The restored observation and mark are still there.
    expect(activeAttempt(c.getProject()).manualEvidence).toHaveLength(1)
    expect(activeAttempt(c.getProject()).snapshot).not.toBeNull()
  })
  it('a user-set address still works in public mode', async () => {
    const fetcher = vi.fn(async () => bytes())
    vi.stubGlobal('fetch', fetcher)
    const p = reduceProject(createProject(), { type: 'set-source', source: { kind: 'url', url: './my-save', enabled: true } })
    const c = createController({ initial: p, storage: null })
    await c.saves.refresh()
    expect(urls(fetcher)).toEqual(['./my-save'])
  })
  it('an unreachable config says so instead of claiming the public site', () => {
    const p = restoreProject(privateExport())
    if (!p.ok) throw Error(p.error)
    const status = saveStatus(p.project, activeAttempt(p.project), { status: 'public', unreachable: true })
    expect(status.text).toMatch(/Couldn't reach this server's settings — reload to try again/)
  })
})

describe('I2: a stored signed-out error does not outlive the sign-in', () => {
  const stored = () => {
    const p = adoptDeploymentSave(createProject(), './save')
    return { ...p, attempts: p.attempts.map((a) => ({ ...a, source: { ...a.source, paused: true, lastError: `${SIGNED_OUT} Last good save retained.` } })) }
  }
  it('is cleared on startup after a successful page load, but kept while the config says signed out', () => {
    for (const deployment of [privateDeployment, { status: 'public' } as const]) {
      const c = createController({ initial: stored(), storage: null, deployment })
      const a = activeAttempt(c.getProject())
      expect(a.source.lastError).toBeUndefined()
      expect(saveStatus(c.getProject(), a, deployment).signedOut).toBe(false)
    }
    const c = createController({ initial: stored(), storage: null, deployment: { status: 'signed-out' } })
    expect(saveStatus(c.getProject(), activeAttempt(c.getProject()), { status: 'signed-out' }).signedOut).toBe(true)
  })
  it('an import in flight shows loading instead of an older error', () => {
    const p = reduceProject(stored(), { type: 'request-import', sourceKind: 'url' })
    expect(saveStatus(p, activeAttempt(p), privateDeployment)).toMatchObject({ tone: 'busy', signedOut: false })
  })
  it('the top bar offers Reload when the session expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    render(<App controller={createController({ storage: null, deployment: privateDeployment })} dataset={dataset} />)
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getAllByText(/Signed out — reload to sign in/).length).toBeGreaterThan(0)
  })
})

describe('I3: turning automatic reload on or off keeps marks and the deployment origin', () => {
  it('reducer: same address only changes enablement', () => {
    let p = adoptDeploymentSave(createProject(), './save')
    p = reduceProject(p, { type: 'record-manual', key: 'x', value: true })
    const before = activeAttempt(p)
    p = reduceProject(p, { type: 'set-source-enabled', enabled: false })
    let a = activeAttempt(p)
    expect(a.source).toMatchObject({ enabled: false, origin: 'deployment', revision: before.source.revision })
    expect(a.manualEvidence.map((e) => e.status)).toEqual(['active'])
    expect(a.continuityRevision).toBe(before.continuityRevision)
    // Saving the same address from the Advanced form claims it (review 2, N2) without a review.
    p = reduceProject(p, { type: 'set-source', source: { kind: 'url', url: './save', enabled: true } })
    a = activeAttempt(p)
    expect(a.source).toMatchObject({ enabled: true, origin: 'user', revision: before.source.revision })
    expect(a.manualEvidence.map((e) => e.status)).toEqual(['active'])
    expect(adoptDeploymentSave(p, './saves/red')).toBe(p)
    // A different address is a new source and is still reviewed.
    p = reduceProject(p, { type: 'set-source', source: { kind: 'url', url: './other', enabled: true } })
    expect(activeAttempt(p).manualEvidence.map((e) => e.status)).toEqual(['needs-review'])
    expect(activeAttempt(p).source.origin).toBe('user')
  })
  it('UI: the Reload automatically checkbox toggles without review', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const c = createController({ storage: null, deployment: privateDeployment })
    c.dispatch({ type: 'record-manual', key: 'x', value: true })
    render(<App controller={c} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    fireEvent.click(screen.getByLabelText('Reload automatically'))
    const a = activeAttempt(c.getProject())
    expect(a.source).toMatchObject({ enabled: false, origin: 'deployment' })
    expect(a.manualEvidence[0]!.status).toBe('active')
  })
})

describe('adoption edge cases', () => {
  it('M4: following a changed deployment address keeps an upload pause and enablement', () => {
    let p = adoptDeploymentSave(createProject(), './save')
    p = reduceProject(p, { type: 'request-import', sourceKind: 'upload' })
    expect(activeAttempt(p).source.paused).toBe(true)
    p = { ...p, pendingImport: null }
    const followed = activeAttempt(adoptDeploymentSave(p, './saves/red')).source
    expect(followed).toMatchObject({ url: './saves/red', paused: true, enabled: true })
  })
  it('reset re-adopts and Undo restores the original attempt with its marks', () => {
    const c = createController({ storage: null, deployment: privateDeployment })
    c.dispatch({ type: 'record-manual', key: 'x', value: true })
    const original = activeAttempt(c.getProject())
    c.dispatch({ type: 'reset-attempt' })
    expect(activeAttempt(c.getProject())).toMatchObject({ manualEvidence: [], source: { url: './save', origin: 'deployment' } })
    c.dispatch({ type: 'undo-reset' })
    const undone = activeAttempt(c.getProject())
    expect(undone.manualEvidence.map((e) => e.id)).toEqual(original.manualEvidence.map((e) => e.id))
    expect(undone.source.url).toBe('./save')
    expect(restoreProject(c.exportProject()).ok).toBe(true)
  })
  it('adopting while a glitch attempt is active keeps that attempt’s own pending import valid', () => {
    let p = createAttempt(createProject(), 'glitch', 'Glitch later')
    p = reduceProject(p, { type: 'set-source', source: { kind: 'url', url: './glitch-save', enabled: true } })
    p = reduceProject(p, { type: 'request-import', sourceKind: 'url' })
    const pending = p.pendingImport
    expect(pending?.attemptId).toBe(p.activeAttemptId)
    const next = adoptDeploymentSave(p, './save')
    expect(next.pendingImport).toEqual(pending)
    expect(activeAttempt(next).source.url).toBe('./glitch-save')
    expect(canonicalAttempt(next)!.source.url).toBe('./save')
    expect(restoreProject(serializeProject(next)).ok).toBe(true)
  })
  it('a persisted adopted project reloads unchanged (no repeated adoption)', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
    const first = createController({ storage, deployment: privateDeployment }).getProject()
    const second = createController({ storage, deployment: privateDeployment }).getProject()
    expect(activeAttempt(second).source.revision).toBe(activeAttempt(first).source.revision)
    // Restoring bumps the import generation by design; the source itself is unchanged.
    expect(activeAttempt(second).source).toEqual(activeAttempt(first).source)
    expect(map.get(STORAGE_KEY)).toContain('"origin":"deployment"')
  })
})

describe('review 2 follow-ups', () => {
  it('N1/N5: the Advanced checkbox follows the quick toggle, and a paused source shows unchecked', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const c = createController({ storage: null, deployment: privateDeployment })
    render(<App controller={c} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    const quick = screen.getByLabelText('Reload automatically') as HTMLInputElement
    const advanced = screen.getByLabelText('Enable automatic save refresh') as HTMLInputElement
    expect([quick.checked, advanced.checked]).toEqual([true, true])
    fireEvent.click(quick)
    expect([quick.checked, advanced.checked]).toEqual([false, false])
    fireEvent.click(screen.getByRole('button', { name: 'Save source settings' }))
    expect(activeAttempt(c.getProject()).source.enabled).toBe(false)
    c.dispatch({ type: 'set-source-enabled', enabled: true })
    c.dispatch({ type: 'pause-source', paused: true })
    expect((screen.getByLabelText('Reload automatically') as HTMLInputElement).checked).toBe(false)
  })
  it('N3: a private config without saveUrl never requests an adopted address; its Reload is disabled', async () => {
    const fetcher = vi.fn(async () => bytes())
    vi.stubGlobal('fetch', fetcher)
    const deployment: DeploymentState = { status: 'private', config: { companionUrl: './companion/' } }
    const c = createController({ initial: adoptDeploymentSave(createProject(), './save'), storage: null, deployment })
    render(<App controller={c} dataset={dataset} />)
    await c.saves.refresh()
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    expect((screen.getByRole('button', { name: 'Reload from address now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('N4: More makes no claim that any procedure succeeded at runtime', () => {
    render(<App controller={createController({ storage: null })} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Runtime success has not been established for any procedure yet/)
    expect(text).not.toMatch(/not established for every/)
  })
  it('M2: an unreachable config is reported even before any save exists', () => {
    const p = createProject()
    expect(saveStatus(p, activeAttempt(p), { status: 'public', unreachable: true })).toMatchObject({ tone: 'warn', text: expect.stringMatching(/Couldn't reach this server's settings/) })
  })
  it('M8: a confirmed account that has not loaded yet says so', () => {
    const p = reduceProject(createProject(), { type: 'set-account-identity', identity: 'player-one' })
    render(<App controller={createController({ initial: p, storage: null })} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Achievements', exact: true }))
    expect(screen.getAllByText(/Hardcore: not loaded yet/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Hardcore: not connected/)).toBeNull()
  })
})

describe('final review follow-ups', () => {
  it('M1: saving empty source settings on an upload attempt changes nothing about the source or marks', () => {
    let p = reduceProject(createProject(), { type: 'record-manual', key: 'x', value: true })
    const before = activeAttempt(p).source
    p = reduceProject(p, { type: 'set-source', source: { kind: 'upload', url: undefined, enabled: true } })
    const a = activeAttempt(p)
    expect(a.manualEvidence.map((e) => e.status)).toEqual(['active'])
    expect(a.source.revision).toBe(before.revision)
    expect(a.source.origin).toBeUndefined()
    expect(activeAttempt(adoptDeploymentSave(p, './save')).source.url).toBe('./save')
  })
  it('M2: an address with automatic reload off does not claim to be waiting', () => {
    const p = reduceProject(createProject(), { type: 'set-source', source: { kind: 'url', url: '/save', enabled: false } })
    expect(saveStatus(p, activeAttempt(p), { status: 'public' })).toMatchObject({ tone: 'none', text: expect.stringMatching(/Automatic reload is off/) })
  })
  it('M3: the reset confirmation says the server save comes back', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<App controller={createController({ storage: null, deployment: privateDeployment })} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset active attempt' }))
    expect(screen.getByText(/This server’s save will be reconnected straight away/)).toBeTruthy()
  })
  it('M5: turning automatic reload on loads straight away', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const p = reduceProject(adoptDeploymentSave(createProject(), './save'), { type: 'set-source-enabled', enabled: false })
    const c = createController({ initial: p, storage: null, deployment: privateDeployment })
    render(<App controller={c} dataset={dataset} />)
    fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
    const before = fetcher.mock.calls.length
    fireEvent.click(screen.getByLabelText('Reload automatically'))
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before))
  })
})
