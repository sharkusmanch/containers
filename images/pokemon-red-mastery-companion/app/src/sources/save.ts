import type { ImportContext, ParseResult } from '../model'
import { parseRedSave } from '../save/parse'
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
      redirect: 'error',
    })
  } catch {
    throw new Error(
      signal.aborted
        ? 'Save refresh cancelled.'
        : 'Save endpoint unavailable. Check the private same-origin route and connection.',
    )
  }
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
      'Save endpoint returned HTML, possibly a login page. Use the private binary save route.',
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
