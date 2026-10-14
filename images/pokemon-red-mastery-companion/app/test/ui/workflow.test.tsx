// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/preact'
import { App } from '../../src/ui/App'
import { createController } from '../../src/ui/controller'
import { createProject, activeAttempt } from '../../src/state/project'
import { reduceProject } from '../../src/state/reducer'
import { restoreProject } from '../../src/state/persist'
import { dataset } from '../../src/data/manifest'
import { snapshot, brock, unknown } from '../planner-fixtures'
afterEach(() => cleanup())
function controller(partial = false) {
  let p = createProject('')
  p = reduceProject(p, {
    type: 'set-branches',
    branches: { starter: 'bulbasaur' },
  })
  p.attempts[0]!.snapshot = {
    ...snapshot([1, ...brock.filter((n) => n !== 25)]),
    importedAt: '2026-10-11T00:00:00.000Z',
    ...(partial ? { party: unknown } : {}),
  }
  return createController({ initial: p, storage: null })
}
it('provides entire guide without a save or sync and all three achievement sets', () => {
  const c = createController({ storage: null })
  render(<App controller={c} dataset={dataset} />)
  expect(screen.getAllByText(/No save loaded/).length).toBeGreaterThan(0)
  fireEvent.click(
    screen.getByRole('button', { name: 'Achievements', exact: true }),
  )
  for (const [label, count] of [
    ['Main', 93],
    ['Professor Oak', 133],
    ['Glitch Showcase', 8],
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }))
    expect(screen.getByText(`${count} achievements`)).toBeTruthy()
  }
  expect(screen.getAllByText(/Hardcore: not connected/).length).toBeGreaterThan(0)
})
it('pre-Brock shows species names, exact requirements and gym preparation', () => {
  render(<App controller={controller()} dataset={dataset} />)
  fireEvent.change(screen.getByLabelText('Route stage'), {
    target: { value: 'brock' },
  })
  const cp = screen.getByRole('region', { name: 'Brock checkpoint' })
  expect(
    within(cp).getByRole('heading', { name: 'Exactly 21 registered species' }),
  ).toBeTruthy()
  expect(within(cp).getAllByText(/Pikachu/).length).toBeGreaterThan(0)
  expect(within(cp).getByText(/level 14/)).toBeTruthy()
  expect(within(cp).getByText(/Set mode/)).toBeTruthy()
})
it('partial party remains unknown, and manual history never grants HC', () => {
  const c = controller(true)
  render(<App controller={c} dataset={dataset} />)
  fireEvent.change(screen.getByLabelText('Route stage'), {
    target: { value: 'brock' },
  })
  expect(screen.getAllByText(/Unreadable test section/).length).toBeGreaterThan(
    0,
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Achievements', exact: true }),
  )
  fireEvent.click(screen.getAllByText('Mark it yourself')[0]!)
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Confirm observed' })[0]!,
  )
  expect(activeAttempt(c.getProject()).manualEvidence.length).toBe(1)
  expect(c.getProject().accountProgress).toEqual([])
})
it('fresh attempt, export/restore, reset/Undo and anonymous persistence retain boundaries', () => {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
  const fresh = createController({ storage })
  expect(restoreProject(fresh.exportProject()).ok).toBe(true)
  const c = controller()
  const before = c.exportProject()
  render(<App controller={c} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  fireEvent.input(screen.getByLabelText('New attempt name'), {
    target: { value: 'Mew practice' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create attempt' }))
  expect(activeAttempt(c.getProject()).source.url).toBeUndefined()
  expect(activeAttempt(c.getProject()).snapshot).toBeNull()
  c.dispatch({ type: 'restore-project', raw: before })
  c.dispatch({ type: 'reset-attempt' })
  expect(activeAttempt(c.getProject()).snapshot).toBeNull()
  c.dispatch({ type: 'undo-reset' })
  expect(activeAttempt(c.getProject()).snapshot).not.toBeNull()
  c.dispatch({ type: 'set-account-identity', identity: 'new-account' })
  expect(c.getProject().accountIdentity).toBe('new-account')
  expect(activeAttempt(c.getProject()).snapshot).not.toBeNull()
})
it('storage, export and restore failures keep live state and show recovery', () => {
  const c = createController({
    initial: controller().getProject(),
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Error('quota')
      },
    },
  })
  c.dispatch({ type: 'record-manual', key: 'test', value: true })
  expect(activeAttempt(c.getProject()).manualEvidence).toHaveLength(1)
  expect(c.getError()).toMatch(/save locally/)
  c.dispatch({ type: 'restore-project', raw: 'invalid' })
  expect(activeAttempt(c.getProject()).snapshot).not.toBeNull()
  expect(c.getError()).toBeTruthy()
})
