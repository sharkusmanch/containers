/** Plain-language display helpers. They describe observations; they never decide readiness. */
import type { Attempt, MasteryProject, Readiness, SaveSnapshot } from '../model'
import type { DeploymentState } from '../sources/deployment'
import { SIGNED_OUT, sourceAvailable } from '../sources/deployment'
import maps from '../data/map-names.generated.json'

const mapNames = maps.names as Record<string, string>
export const mapName = (mapId: number): string | undefined =>
  mapNames[String(mapId)]

export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'at an unknown time'
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `on ${new Date(iso).toLocaleDateString()}`
}

export const countBits = (mask: number) => {
  let n = 0
  for (let m = mask; m; m >>= 1) n += m & 1
  return n
}
/** Short facts for the status strip; unreadable sections are simply omitted. */
export function saveFacts(s: SaveSnapshot): string[] {
  const facts: string[] = []
  const place = s.location.known
    ? (s.location.value.name ?? mapName(s.location.value.mapId))
    : undefined
  if (place) facts.push(place)
  if (s.badgeMask.known) {
    const n = countBits(s.badgeMask.value)
    facts.push(`${n} badge${n === 1 ? '' : 's'}`)
  }
  if (s.ownedDex.known) facts.push(`${s.ownedDex.value.length} caught`)
  return facts
}

export const isSignedOutError = (message?: string) =>
  !!message?.startsWith(SIGNED_OUT)

export type SaveStatus = {
  tone: 'ok' | 'busy' | 'warn' | 'none'
  text: string
  signedOut: boolean
}
export function saveStatus(
  project: MasteryProject,
  attempt: Attempt,
  deployment: DeploymentState,
  now = Date.now(),
): SaveStatus {
  const s = attempt.snapshot
  const loaded = s
    ? [`Save loaded ${relativeTime(s.importedAt, now)}`, ...saveFacts(s)].join(
        ' · ',
      )
    : ''
  const lower = loaded.charAt(0).toLowerCase() + loaded.slice(1)
  if (deployment.status === 'signed-out')
    return {
      tone: 'warn',
      signedOut: true,
      text: s
        ? `Signed out — reload to sign in · showing ${lower}`
        : 'Signed out — reload to sign in',
    }
  // A request in flight supersedes an older stored error.
  if (project.pendingImport)
    return {
      tone: 'busy',
      signedOut: false,
      text: s ? `Checking for a newer save… · ${loaded}` : 'Loading your save…',
    }
  if (attempt.source.url && !sourceAvailable(attempt.source, deployment)) {
    const why =
      deployment.status === 'public' && deployment.unreachable
        ? "Couldn't reach this server's settings — reload to try again"
        : "The server save isn't available here — upload one in More"
    return {
      tone: s ? 'ok' : 'none',
      signedOut: false,
      text: s ? `${loaded} · ${why}` : why,
    }
  }
  if (isSignedOutError(attempt.source.lastError))
    return {
      tone: 'warn',
      signedOut: true,
      text: s
        ? `Signed out — reload to sign in · showing ${lower}`
        : 'Signed out — reload to sign in',
    }
  if (attempt.source.lastError)
    return {
      tone: 'warn',
      signedOut: false,
      text: s
        ? `Couldn't refresh — ${loaded}`
        : `Couldn't load the save: ${attempt.source.lastError}`,
    }
  if (s)
    return {
      tone: 'ok',
      signedOut: false,
      text:
        attempt.source.paused && attempt.source.url
          ? `${loaded} · auto-refresh paused`
          : loaded,
    }
  if (attempt.source.url)
    return attempt.source.enabled && !attempt.source.paused
      ? { tone: 'busy', signedOut: false, text: 'Waiting for your save…' }
      : {
          tone: 'none',
          signedOut: false,
          text: 'Automatic reload is off — tap Reload now in More',
        }
  if (deployment.status === 'public' && deployment.unreachable)
    return {
      tone: 'warn',
      signedOut: false,
      text: "Couldn't reach this server's settings — reload to try again, or upload a save in More",
    }
  return {
    tone: 'none',
    signedOut: false,
    text: 'No save loaded — upload one in More',
  }
}

const readinessLabels: Record<Readiness, string> = {
  ready: 'Ready',
  blocked: 'Not ready yet',
  unknown: "Can't tell yet",
  missed: 'May be missed',
}
export const readinessLabel = (status: string) =>
  readinessLabels[status as Readiness] ?? status
