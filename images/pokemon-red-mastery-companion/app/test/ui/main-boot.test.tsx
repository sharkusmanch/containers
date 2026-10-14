// @vitest-environment happy-dom
// Entry wiring: exactly one config request, and the app renders even if it never answers.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/preact'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  document.body.innerHTML = '<div id="app"></div>'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('public boot requests only app-config.json once and renders the home screen', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  await import('../../src/main')
  await waitFor(() => expect(document.body.textContent).toMatch(/What to do next/), { timeout: 10_000 })
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual(['./app-config.json'])
}, 15_000)

it('a config request that never answers still renders after the five-second limit, in manual mode', async () => {
  const fetcher = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))))
  vi.stubGlobal('fetch', fetcher)
  await import('../../src/main')
  await waitFor(() => expect(document.body.textContent).toMatch(/What to do next/), { timeout: 9_000 })
  expect(fetcher).toHaveBeenCalledTimes(1)
}, 15_000)

it('private boot loads the save without any click', async () => {
  const fetcher = vi.fn(async (url: string) =>
    url === './app-config.json'
      ? new Response(JSON.stringify({ saveUrl: './save' }), { headers: { 'Content-Type': 'application/json' } })
      : new Response(new Uint8Array(32768), { headers: { 'Content-Type': 'application/octet-stream' } }))
  vi.stubGlobal('fetch', fetcher)
  await import('../../src/main')
  await waitFor(() => expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain('./save'), { timeout: 10_000 })
  expect(fetcher.mock.calls.map((call) => String(call[0])).filter((u) => u === './app-config.json')).toHaveLength(1)
}, 15_000)
