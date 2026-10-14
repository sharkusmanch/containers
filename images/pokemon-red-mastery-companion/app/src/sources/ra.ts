import type { AchievementSet, HardcoreProgress, HardcoreRefreshResult } from '../model'
import memberships from '../data/sets.json'
import { SIGNED_OUT, isSignedOut } from './deployment'

const sets = memberships as AchievementSet[]
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Round-trip comparison rejects raw calendar rollovers as well as hour 24. */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'))
}
function mapFeed(set: AchievementSet, body: unknown): HardcoreProgress {
  if (!record(body) || body.source !== 'ra' || body.id !== String(set.apiGameId)) throw new Error('Unexpected achievement source or backing set ID.')
  if (typeof body.accountIdentity !== 'string' || !body.accountIdentity.trim()) throw new Error('Account identity unavailable.')
  if (!isTimestamp(body.fetchedAt)) throw new Error('Last successful upstream fetch time unavailable or invalid.')
  if (body.stale !== false) throw new Error('Feed is stale; retaining last good progress.')
  if (!Array.isArray(body.achievements)) throw new Error('Invalid achievement feed.')
  const ids = body.achievements.map(a => record(a) && typeof a.id === 'string' && /^[1-9]\d*$/.test(a.id) ? Number(a.id) : NaN)
  const expected = new Set(set.expectedPublishedIds)
  if (ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) {
    throw new Error('dataset-drift: Published achievement membership changed; refresh the dataset before syncing this set.')
  }
  if (body.achievements.some(a => !record(a) || typeof a.unlocked !== 'boolean' || !(a.unlockedAt === null || typeof a.unlockedAt === 'string'))) throw new Error('Invalid achievement state; progress remains unknown.')
  if (body.achievements.some(a => record(a) && a.unlocked === true && !isTimestamp(a.unlockedAt))) throw new Error('Invalid hardcore unlock timestamp; retaining last good progress.')
  const unlocks = body.achievements.flatMap((a, i) => record(a) && a.unlocked === true && isTimestamp(a.unlockedAt)
    ? [{ achievementId: ids[i]!, earnedAt: a.unlockedAt }] : [])
  return { setKey: set.key, apiGameId: set.apiGameId, accountIdentity: body.accountIdentity,
    lastSuccessfulFetchAt: body.fetchedAt, stale: false, unlocks }
}

const feedUrl = (baseUrl: string, id: number) => `${baseUrl.replace(/\/+$/, '')}/api/achievements/ra/${id}`
type FeedResult = { progress: HardcoreProgress; failure?: never } | { progress?: never; failure: HardcoreRefreshResult['failures'][number] }
const FEED_TIMEOUT = 10_000

async function readFeed(set: AchievementSet, baseUrl: string, signal: AbortSignal): Promise<FeedResult> {
  try {
    const response = await fetch(feedUrl(baseUrl, set.apiGameId), { signal, credentials: 'same-origin', redirect: 'manual' })
    if (isSignedOut(response)) return { failure: { setKey: set.key, reason: SIGNED_OUT } }
    if (!response.ok) return { failure: { setKey: set.key, reason: response.status === 403 || response.status === 404
      ? 'Feed denied or unavailable; check the server allowlist.' : 'Progress service unavailable.' } }
    // Parsing errors must not surface arbitrary upstream text or credentials.
    let body: unknown
    try { body = await response.json() } catch { return { failure: { setKey: set.key, reason: 'Invalid achievement response.' } } }
    try { return { progress: mapFeed(set, body) } }
    catch (error) { return { failure: { setKey: set.key, reason: (error as Error).message } } }
  } catch {
    return { failure: { setKey: set.key, reason: signal.aborted ? 'Hardcore refresh cancelled.' : 'Progress service could not be reached.' } }
  }
}

/** Bound headers AND body parsing independently; abort is never the settlement mechanism. */
async function boundedFeed(set: AchievementSet, baseUrl: string, signal: AbortSignal): Promise<FeedResult> {
  const failure = (reason: string): FeedResult => ({ failure: { setKey: set.key, reason } })
  if (!baseUrl.trim()) return failure('Hardcore sync disabled; manual guidance remains available.')
  if (signal.aborted) return failure('Hardcore refresh cancelled.')
  const request = new AbortController()
  let interrupt!: (result: FeedResult) => void
  const interrupted = new Promise<FeedResult>(resolve => { interrupt = resolve })
  const cancel = () => {
    interrupt(failure('Hardcore refresh cancelled.'))
    request.abort()
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    interrupt(failure('Hardcore feed timed out after 10 seconds; last successful data retained.'))
    request.abort()
  }, FEED_TIMEOUT)
  try {
    return await Promise.race([readFeed(set, baseUrl, request.signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

/** baseUrl is the companion service mount (e.g. /companion/), never an RA API URL.
 * Each feed is independent. The reducer checks identity against the user's project
 * and preserves prior progress/time on failures; account unlocks never mutate attempts.
 */
export async function fetchHardcoreProgress(baseUrl: string, signal: AbortSignal): Promise<HardcoreRefreshResult> {
  const results = await Promise.all(sets.map(set => boundedFeed(set, baseUrl, signal)))
  const progress = results.flatMap(result => result.progress ? [result.progress] : [])
  const failures = results.flatMap(result => result.failure ? [result.failure] : [])
  // No majority vote or silent account adoption: all mixed successful feeds fail attribution.
  if (new Set(progress.map(feed => feed.accountIdentity)).size > 1) return {
    progress: [], failures: [...failures, ...progress.map(feed => ({ setKey: feed.setKey, reason: 'Account identity mismatch between achievement feeds.' }))],
  }
  return { progress, failures }
}

export type IdentityDiscovery = { identity: string; error?: never } | { identity?: never; error: string }
/**
 * Read the account name the server's Main feed reports so the player can confirm it.
 * Nothing is stored here: the caller records the identity only after explicit confirmation.
 */
async function readIdentity(baseUrl: string, signal: AbortSignal): Promise<IdentityDiscovery> {
  const set = sets.find(s => s.key === 'main')!
  try {
    const response = await fetch(feedUrl(baseUrl, set.apiGameId), { signal, credentials: 'same-origin', redirect: 'manual' })
    if (isSignedOut(response)) return { error: SIGNED_OUT }
    if (!response.ok) return { error: 'Progress service unavailable.' }
    let body: unknown
    try { body = await response.json() } catch { return { error: 'Invalid achievement response.' } }
    if (!record(body) || body.source !== 'ra' || body.id !== String(set.apiGameId)) return { error: 'Unexpected achievement source.' }
    const identity = typeof body.accountIdentity === 'string' ? body.accountIdentity.trim() : ''
    if (!identity || identity.length > 100) return { error: 'The server did not report an account.' }
    return { identity }
  } catch {
    return { error: signal.aborted ? 'Cancelled.' : 'Progress service could not be reached.' }
  }
}
export async function discoverAccountIdentity(baseUrl: string, signal: AbortSignal): Promise<IdentityDiscovery> {
  if (!baseUrl.trim()) return { error: 'No progress service is configured.' }
  const request = new AbortController()
  let settle!: (result: IdentityDiscovery) => void
  const interrupted = new Promise<IdentityDiscovery>(resolve => { settle = resolve })
  const cancel = () => { settle({ error: 'Cancelled.' }); request.abort() }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { settle({ error: 'Progress service timed out after 10 seconds.' }); request.abort() }, FEED_TIMEOUT)
  try {
    return await Promise.race([readIdentity(baseUrl, request.signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
