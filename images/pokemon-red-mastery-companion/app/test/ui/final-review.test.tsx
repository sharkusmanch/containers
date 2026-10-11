// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { App } from '../../src/ui/App'
import { createController } from '../../src/ui/controller'
import { createProject } from '../../src/state/project'
import { serializeProject } from '../../src/state/persist'
import { dataset } from '../../src/data/manifest'
afterEach(cleanup)
it('More keeps the latest selected backup when an older file resolves last', async () => {
  const c = createController({ storage: null })
  render(<App controller={c} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  const input = screen.getByLabelText('Restore project file')
  let finishA!: (s: string) => void, finishB!: (s: string) => void
  const a = new Promise<string>((r) => { finishA = r }), b = new Promise<string>((r) => { finishB = r })
  fireEvent.change(input, { target: { files: [{ text: () => a }] } })
  fireEvent.change(input, { target: { files: [{ text: () => b }] } })
  const older = createProject(), newer = createProject()
  finishB(serializeProject(newer))
  await waitFor(() => expect(c.getProject().id).toBe(newer.id))
  finishA(serializeProject(older))
  await a
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(c.getProject().id).toBe(newer.id)
})
it('More exposes exact original recovery text and explicit fallback replacement', () => {
  const original = '{unsupported recovery text}'
  let raw = original
  const c = createController({ storage: { getItem: () => raw, setItem: (_, next) => { raw = next } } })
  render(<App controller={c} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Show original recovery text' }))
  expect((screen.getByLabelText('Original recovery text') as HTMLTextAreaElement).value).toBe(original)
  fireEvent.click(screen.getByRole('button', { name: 'Use current project as stored replacement' }))
  expect(raw).toBe(c.exportProject())
})
it('Cinnabar quiz visit displays Blaine preparation before the entry procedure', () => {
  render(<App controller={createController({ storage: null })} dataset={dataset} />)
  fireEvent.change(screen.getByLabelText('Route stage'), { target: { value: 'cinnabar' } })
  const preparation = screen.getByRole('region', { name: 'Blaine checkpoint' })
  expect(within(preparation).getByText(/Entire party at level 47/)).toBeTruthy()
  expect(within(preparation).getByText(/Select Set mode before entry/)).toBeTruthy()
  const actions = screen.getByRole('region', { name: 'Concrete actions' })
  expect(preparation.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it('More pasted restoration supersedes an outstanding file read', async () => {
  const c = createController({ storage: null }), newer = createProject()
  render(<App controller={c} dataset={dataset} />)
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  let finish!: (s: string) => void
  const pending = new Promise<string>((r) => { finish = r })
  fireEvent.change(screen.getByLabelText('Restore project file'), { target: { files: [{ text: () => pending }] } })
  fireEvent.click(screen.getByText('Restore pasted project export'))
  fireEvent.input(screen.getByLabelText('Project export to restore'), { target: { value: serializeProject(newer) } })
  fireEvent.click(screen.getByRole('button', { name: 'Restore project', exact: true }))
  expect(c.getProject().id).toBe(newer.id)
  finish(serializeProject(createProject())); await pending
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(c.getProject().id).toBe(newer.id)
})
