// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { readFileSync } from 'node:fs'
import { App } from '../../src/ui/App'
import { createController } from '../../src/ui/controller'
import { activeAttempt, createProject } from '../../src/state/project'
import { reduceProject } from '../../src/state/reducer'
import { dataset } from '../../src/data/manifest'
import { planRun } from '../../src/planner/route'
import { homeStage, nextActions, upcomingCheckpoint } from '../../src/ui/home'
import type { DeploymentState } from '../../src/sources/deployment'
import { snapshot } from '../planner-fixtures'

const privateDeployment: DeploymentState = { status: 'private', config: { saveUrl: './save', companionUrl: './companion/', guideUrl: 'https://wiki.example/doc' } }
// Synthetic 32 KiB SRAM: zero-filled bytes the parser reads as partial/rejected; no personal save is needed for request routing.
const bytes = new Uint8Array(32768)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const urls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map((call) => String(call[0]))

it('private deployment loads the canonical save on first open with no setup', async () => {
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
  vi.stubGlobal('fetch', fetcher)
  const c = createController({ storage: null, deployment: privateDeployment })
  render(<App controller={c} dataset={dataset} />)
  await waitFor(() => expect(urls(fetcher)).toContain('./save'))
  expect(activeAttempt(c.getProject()).source).toMatchObject({ enabled: true, origin: 'deployment' })
  // Hardcore progress is not requested before the player confirms an account.
  expect(urls(fetcher).some((u) => u.includes('/companion/'))).toBe(false)
  expect(screen.getAllByRole('link', { name: /full written guide/ })[0]!.getAttribute('href')).toBe('https://wiki.example/doc')
})

it('public mode makes no save or progress request, even on focus and tab return', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  render(<App controller={createController({ storage: null })} dataset={dataset} />)
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByRole('link', { name: /full written guide/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Connect hardcore progress' })).toBeNull()
  expect(screen.getAllByText(/No save loaded — upload one in More/).length).toBeGreaterThan(0)
})

it('one-tap hardcore connection asks the player to confirm the server-reported account', async () => {
  const sets = (await import('../../src/data/sets.json')).default
  const fetcher = vi.fn(async (url: string) => {
    if (url === './save') return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })
    const set = sets.find((s) => url.endsWith(`/${s.apiGameId}`))!
    return new Response(JSON.stringify({ source: 'ra', id: String(set.apiGameId), accountIdentity: 'player-one', fetchedAt: '2026-10-13T00:00:00Z', stale: false,
      achievements: set.expectedPublishedIds.map((id, i) => ({ id: String(id), unlocked: i === 0, unlockedAt: i === 0 ? '2026-10-13T00:00:00Z' : null })) }), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  const c = createController({ storage: null, deployment: privateDeployment })
  render(<App controller={c} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Connect hardcore progress' }))
  const confirm = await screen.findByRole('button', { name: 'Yes, use player-one' })
  expect(c.getProject().accountIdentity).toBeNull()
  fireEvent.click(confirm)
  expect(c.getProject().accountIdentity).toBe('player-one')
  await waitFor(() => expect(c.getProject().accountProgress).toHaveLength(3))
  expect(c.getProject().accountProgress.map((f) => f.unlocks.length)).toEqual([1, 1, 1])
  // Account unlocks never become attempt marks.
  expect(activeAttempt(c.getProject()).manualEvidence).toEqual([])
})

it('More keeps everyday controls up front and power features under Advanced', () => {
  render(<App controller={createController({ storage: null })} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  const advanced = document.querySelector('details.advanced')!
  expect(advanced.hasAttribute('open')).toBe(false)
  for (const label of ['New attempt name', 'Save URL for this attempt', 'Account identity', 'Restore project file', 'Starter'])
    expect(within(advanced as HTMLElement).getByLabelText(label)).toBeTruthy()
  expect(within(advanced as HTMLElement).getByRole('button', { name: 'Reset active attempt' })).toBeTruthy()
  expect(advanced.contains(screen.getByLabelText('Upload battery save'))).toBe(false)
})

it('the home screen picks up after the last badge and lists unfinished achievements in route order', () => {
  let p = reduceProject(createProject(''), { type: 'set-branches', branches: { starter: 'squirtle' } })
  p.attempts[0]!.snapshot = { ...snapshot([7, 16, 19], 1), importedAt: '2026-10-11T00:00:00.000Z' }
  const input = { project: p, attempt: activeAttempt(p), dataset }, plan = planRun(input)
  expect(homeStage(input, plan)).toBe('moon')
  const next = nextActions(input, plan, 'moon')
  expect(next.length).toBe(5)
  const orders = next.map(({ step }) => step.order)
  expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  expect(upcomingCheckpoint(input, plan, 'moon')?.step.id).toBe('misty')
  // A confirmed hardcore unlock removes that achievement from the list.
  const first = next[0]!.action.ruleIds[0]!
  const set = dataset.rules.find((r) => r.id === first)!.setKey
  p = { ...p, accountIdentity: 'x', accountProgress: [{ setKey: set, apiGameId: dataset.sets.find((s) => s.key === set)!.apiGameId, accountIdentity: 'x', lastSuccessfulFetchAt: '2026-10-13T00:00:00Z', stale: false, unlocks: [{ achievementId: first, earnedAt: '2026-10-13T00:00:00Z' }] }] }
  const input2 = { project: p, attempt: activeAttempt(p), dataset }
  expect(nextActions(input2, planRun(input2), 'moon').some(({ action }) => action.ruleIds.includes(first))).toBe(false)
})

it('the starter question on the home screen records the branch choice', () => {
  const c = createController({ storage: null })
  render(<App controller={c} dataset={dataset} />)
  fireEvent.change(screen.getByLabelText(/Which starter did you pick/), { target: { value: 'bulbasaur' } })
  expect(activeAttempt(c.getProject()).branches.starter).toBe('bulbasaur')
  expect(screen.queryByLabelText(/Which starter did you pick/)).toBeNull()
})

it('the public build ships no deployment config', () => {
  expect(() => readFileSync(new URL('../../public/app-config.json', import.meta.url))).toThrow()
})
