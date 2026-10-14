/**
 * Private deployments declare their same-origin integrations in `./app-config.json`.
 * The public build ships no such file, so it never requests a save or progress route.
 */
export interface DeploymentConfig {
  /** Same-origin battery-save route, e.g. `./save`. */
  saveUrl?: string
  /** Same-origin Game Companion mount, e.g. `./companion/`. */
  companionUrl?: string
  /** Link to the private written guide; never part of the public build. */
  guideUrl?: string
}
export type DeploymentState =
  /** unreachable: the config request failed or timed out, so this may still be a private host. */
  | { status: 'public'; unreachable?: true }
  | { status: 'private'; config: DeploymentConfig }
  | { status: 'signed-out' }

export const CONFIG_PATH = './app-config.json'
export const CONFIG_TIMEOUT = 5_000
export const SIGNED_OUT = 'Signed out — reload this page to sign in.'

/** Relative same-origin paths only: no scheme, host or protocol-relative URL. */
function sameOriginPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (
    !v ||
    v.length > 200 ||
    v.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(v)
  )
    return undefined
  if (!/^(\.\/|\/)[A-Za-z0-9._~\-/]*$/.test(v)) return undefined
  return v
}
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}
export function parseDeploymentConfig(body: unknown): DeploymentConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const data = body as Record<string, unknown>
  const config: DeploymentConfig = {}
  const saveUrl = sameOriginPath(data.saveUrl),
    companionUrl = sameOriginPath(data.companionUrl),
    guideUrl = httpsUrl(data.guideUrl)
  if (saveUrl) config.saveUrl = saveUrl
  if (companionUrl) config.companionUrl = companionUrl
  if (guideUrl) config.guideUrl = guideUrl
  return config
}
/** True for an auth gateway answer: a redirect to sign-in or an explicit 401. */
export function isSignedOut(response: Response): boolean {
  return (
    response.type === 'opaqueredirect' ||
    response.status === 401 ||
    (response.status >= 300 && response.status < 400)
  )
}

/**
 * Missing (404), an SPA fallback page (HTML 200) or an unreachable file all mean the
 * public/manual mode. Only a JSON object is a deployment declaration.
 */
export async function loadDeploymentConfig(
  fetcher: typeof fetch = fetch,
  timeout = CONFIG_TIMEOUT,
): Promise<DeploymentState> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeout)
  try {
    const response = await fetcher(CONFIG_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'manual',
      signal: abort.signal,
    })
    if (isSignedOut(response)) return { status: 'signed-out' }
    if (!response.ok) return { status: 'public' }
    if (!/json/i.test(response.headers.get('content-type') ?? ''))
      return { status: 'public' }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { status: 'public' }
    }
    const config = parseDeploymentConfig(body)
    return Object.keys(config).length
      ? { status: 'private', config }
      : { status: 'public' }
  } catch {
    return { status: 'public', unreachable: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A deployment-adopted save address belongs to the private host. Where no private host is
 * declared (public Pages, or a restored backup elsewhere) it is never requested.
 */
export function sourceAvailable(
  source: { url?: string; origin?: string },
  deployment: DeploymentState,
): boolean {
  if (!source.url?.trim()) return false
  if (source.origin !== 'deployment') return true
  return (
    deployment.status === 'signed-out' ||
    (deployment.status === 'private' && !!deployment.config.saveUrl)
  )
}
