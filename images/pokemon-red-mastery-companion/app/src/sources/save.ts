import type { ImportContext, ParseResult } from '../model'
import { parseRedSave } from '../save/parse'
import { SIGNED_OUT, isSignedOut } from './deployment'
/** Read only. Context is captured by the controller before this function is called. */
export async function refreshSave(
  _context: ImportContext,
  url: string,
  signal: AbortSignal,
): Promise<ParseResult> {
  let response: Response
  try {
    response = await fetch(url, {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      // An expired auth session redirects to sign-in; report it rather than following.
      redirect: 'manual',
    })
  } catch {
    throw new Error(
      signal.aborted
        ? 'Save refresh cancelled.'
        : 'Save unavailable — check your connection. Last good save retained.',
    )
  }
  if (isSignedOut(response))
    throw new Error(`${SIGNED_OUT} Last good save retained.`)
  if (!response.ok)
    throw new Error(
      `Save endpoint returned HTTP ${response.status}. Last good save retained.`,
    )
  if (
    /text\/html|application\/xhtml/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    throw new Error(
      'The save address returned a web page instead of a save. You may be signed out (reload to check), or the address is wrong. Last good save retained.',
    )
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (
    new TextDecoder().decode(bytes.subarray(0, 100)).trimStart().startsWith('<')
  )
    throw new Error(
      'Save endpoint returned HTML instead of battery-save bytes.',
    )
  return parseRedSave(bytes)
}
