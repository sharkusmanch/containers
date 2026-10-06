export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Shorter than the browser's own 8 s deadline, so the server can still answer from a stale copy. */
export const DEFAULT_TIMEOUT_MS = 4_000;

/** GET/POST returning parsed JSON. Errors never include the URL, which may carry an API key. */
export async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  // The deadline covers the body too: the timer is cleared only after the JSON is parsed.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchFn(url, { ...rest, signal: controller.signal });
    } catch {
      throw new UpstreamError(
        controller.signal.aborted ? "upstream timed out" : "upstream unreachable",
        null,
      );
    }
    if (!response.ok)
      throw new UpstreamError(`upstream returned ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) throw new UpstreamError("upstream timed out", null);
      throw new UpstreamError("upstream returned invalid JSON", response.status);
    }
  } finally {
    clearTimeout(timer);
  }
}
