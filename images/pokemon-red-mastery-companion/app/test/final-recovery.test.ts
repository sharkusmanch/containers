import { expect, it } from 'vitest'
import { createController } from '../src/ui/controller'
import { createProject } from '../src/state/project'
import { serializeProject } from '../src/state/persist'

function stored(original = '{"version":999,"salvage":"keep exactly\\nthis"}') {
  let raw = original
  let fail = false
  const storage = {
    getItem: () => raw,
    setItem: (_: string, value: string) => {
      if (fail) throw new Error('quota')
      raw = value
    },
  }
  return { original, storage, raw: () => raw, fail: () => { fail = true } }
}
function deferred() {
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
it('preserves original recovery text through failed restore, fallback edits and reload', () => {
  const s = stored(), c = createController({ storage: s.storage })
  c.dispatch({ type: 'restore-project', raw: 'invalid' })
  c.dispatch({ type: 'record-manual', key: 'history', value: true })
  expect(s.raw()).toBe(s.original)
  expect(c.exportRecoveryData()).toBe(s.original)
  expect(c.isPersistenceBlocked()).toBe(true)
  expect(c.exportProject()).toContain('history')
  const reloaded = createController({ storage: s.storage })
  expect(reloaded.exportRecoveryData()).toBe(s.original)
})
it.each(['restore', 'replace'] as const)('resumes persistence after explicit %s and keeps original text exportable this session', (mode) => {
  const s = stored(), c = createController({ storage: s.storage })
  const replacement = createProject()
  if (mode === 'restore') c.dispatch({ type: 'restore-project', raw: serializeProject(replacement) })
  else c.replaceStoredProject()
  expect(c.isPersistenceBlocked()).toBe(false)
  expect(s.raw()).toBe(c.exportProject())
  if (mode === 'restore') expect(c.getProject().id).toBe(replacement.id)
  c.dispatch({ type: 'record-manual', key: 'new-history', value: true })
  expect(s.raw()).toContain('new-history')
  expect(c.exportRecoveryData()).toBe(s.original)
})
it.each(['restore', 'replace'] as const)('retains original storage and live export when %s hits quota', (mode) => {
  const s = stored(), c = createController({ storage: s.storage })
  s.fail()
  const replacement = createProject()
  if (mode === 'restore') c.dispatch({ type: 'restore-project', raw: serializeProject(replacement) })
  else c.replaceStoredProject()
  c.dispatch({ type: 'record-manual', key: 'live-history', value: true })
  expect(s.raw()).toBe(s.original)
  expect(c.exportRecoveryData()).toBe(s.original)
  expect(c.exportProject()).toContain('live-history')
  expect(c.getError()).toMatch(/save locally/)
})
it('keeps normal valid persistence working', () => {
  const s = stored(serializeProject(createProject())), c = createController({ storage: s.storage })
  c.dispatch({ type: 'record-manual', key: 'normal-history', value: true })
  expect(s.raw()).toContain('normal-history')
  expect(c.exportRecoveryData()).toBeNull()
})
it('protects unreadable storage until explicit replacement', () => {
  let written = false
  const c = createController({ storage: { getItem() { throw new Error('denied') }, setItem() { written = true } } })
  c.dispatch({ type: 'record-manual', key: 'live', value: true })
  expect(written).toBe(false)
  expect(c.exportProject()).toContain('live')
  c.replaceStoredProject()
  expect(written).toBe(true)
})
it('keeps the latest selected project when reads finish in reverse order', async () => {
  const c = createController({ storage: null }), a = deferred(), b = deferred()
  const older = createProject(), newer = createProject()
  const first = c.restoreProjectFile(() => a.promise), second = c.restoreProjectFile(() => b.promise)
  b.resolve(serializeProject(newer)); await second
  a.resolve(serializeProject(older)); await first
  expect(c.getProject().id).toBe(newer.id)
})
it('pasted restore wins over a pending file and ignores its stale read error', async () => {
  const c = createController({ storage: null }), a = deferred(), newer = createProject()
  const pending = c.restoreProjectFile(() => a.promise)
  c.dispatch({ type: 'restore-project', raw: serializeProject(newer) })
  a.reject(new Error('private filename'))
  await pending
  expect(c.getProject().id).toBe(newer.id)
  expect(c.getError()).toBe('')
})
it('pasted restore wins over a stale successful file', async () => {
  const c = createController({ storage: null }), a = deferred(), newer = createProject()
  const pending = c.restoreProjectFile(() => a.promise)
  c.dispatch({ type: 'restore-project', raw: serializeProject(newer) })
  a.resolve(serializeProject(createProject())); await pending
  expect(c.getProject().id).toBe(newer.id)
})
it.each(['reset', 'edit', 'source', 'account', 'attempt', 'replace', 'dispose'] as const)('invalidates project reads on newer %s', async (operation) => {
  const c = createController({ storage: null }), a = deferred()
  const pending = c.restoreProjectFile(() => a.promise)
  if (operation === 'reset') c.dispatch({ type: 'reset-attempt' })
  if (operation === 'edit') c.dispatch({ type: 'record-manual', key: 'new-edit', value: true })
  if (operation === 'source') c.dispatch({ type: 'set-source', source: { kind: 'url', url: './save' } })
  if (operation === 'account') c.dispatch({ type: 'set-account-identity', identity: 'new' })
  if (operation === 'attempt') c.dispatch({ type: 'create-attempt', name: 'new', kind: 'glitch' })
  if (operation === 'replace') c.replaceStoredProject()
  if (operation === 'dispose') c.dispose()
  const expected = c.exportProject()
  a.resolve(serializeProject(createProject())); await pending
  expect(c.exportProject()).toBe(expected)
})
it('current read failures preserve the live project and expose a safe message', async () => {
  const c = createController({ storage: null }), before = c.getProject()
  await c.restoreProjectFile(async () => { throw new Error('private content') })
  expect(c.getProject()).toBe(before)
  expect(c.getError()).toBe('Could not read project file. Your live project is retained.')
})
it('a new battery-save import invalidates a still-reading project backup', async () => {
  const c = createController({ storage: null }), a = deferred()
  const pending = c.restoreProjectFile(() => a.promise)
  await c.saves.upload(async () => new Uint8Array(3))
  const expected = c.exportProject()
  a.resolve(serializeProject(createProject())); await pending
  expect(c.exportProject()).toBe(expected)
})
it('a stale invalid backup cannot add a recovery error to a newer project', async () => {
  const c = createController({ storage: null }), a = deferred()
  const pending = c.restoreProjectFile(() => a.promise)
  c.dispatch({ type: 'record-manual', key: 'newer-history', value: true })
  a.resolve('invalid'); await pending
  expect(c.getError()).toBe('')
  expect(c.getProject().recoveryError).toBeUndefined()
  expect(c.exportProject()).toContain('newer-history')
})
