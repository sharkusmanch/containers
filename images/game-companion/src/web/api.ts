import type {
  AchievementsResponse,
  AskEvent,
  AskRequest,
  FindResponse,
  GuideMarksResponse,
  GuideProgressResponse,
  GuideWhereResponse,
  GuidesResponse,
  HubTreeResponse,
  NowResponse,
  Source,
} from "../shared/types.js";

export const REQUEST_TIMEOUT_MS = 8000;
/**
 * How long to wait before checking a 401 again. Sign-ins are refreshed hourly and a request
 * racing a refresh can get one 401, so only a second one in a row means the sign-in has lapsed.
 */
export const AUTH_RETRY_MS = 2000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Which question limit a 429 from the Ask route hit. */
    readonly limit?: "minute" | "day",
    /** The Retry-After seconds of a 429. */
    readonly retryAfter?: number,
  ) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
  }
}

export interface Api {
  now(): Promise<NowResponse>;
  guides(refresh?: boolean): Promise<GuidesResponse>;
  hubTree(hubId: string): Promise<HubTreeResponse>;
  /** Null when the server has no achievements for the game (404). */
  achievements(source: Source, id: string): Promise<AchievementsResponse | null>;
  /** Null when the guide is unknown (404). */
  find(hubId: string, query: string): Promise<FindResponse | null>;
  /** Null when the guide is unknown (404). */
  marks(hubId: string): Promise<GuideMarksResponse | null>;
  /** Null when the guide is unknown (404). */
  where(hubId: string): Promise<GuideWhereResponse | null>;
  /** Null when the guide is unknown (404). `refresh` asks the server for a fresh read. */
  progress(hubId: string, refresh?: boolean): Promise<GuideProgressResponse | null>;
  /**
   * Asks the assistant and hands each streamed event to `onEvent`; resolves when the stream ends.
   * Only `signal` cuts it short: an answer may take a while. A refused question is never re-sent:
   * after a 401 it rejects with that ApiError only when a GET of now answers 401 too, and with a
   * plain Error (unavailable) otherwise.
   */
  ask(req: AskRequest, signal: AbortSignal, onEvent: (e: AskEvent) => void): Promise<void>;
  /**
   * Adds a listener told false whenever a 401 is confirmed by a second one (the sign-in has
   * lapsed) and true whenever a response succeeds. Network failures and other statuses tell it
   * nothing.
   */
  onAuth?(listener: (signedIn: boolean) => void): void;
}

/** The ApiError for a refused question: a 429 carries the limit hit and when to retry. */
async function askError(res: Response): Promise<ApiError> {
  let limit: "minute" | "day" | undefined;
  try {
    const body = (await res.json()) as { limit?: unknown } | null;
    if (body?.limit === "minute" || body?.limit === "day") limit = body.limit;
  } catch {
    // Not JSON: no limit to report.
  }
  const seconds = Number(res.headers.get("retry-after"));
  const retryAfter = Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
  return new ApiError(res.status, limit, retryAfter);
}

/** Parses one NDJSON line; a line that is not a JSON object with a `type` is skipped. */
function emitLine(line: string, onEvent: (e: AskEvent) => void): void {
  if (line.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
    if (typeof parsed.type === "string") onEvent(parsed as AskEvent);
  }
}

export function createApi(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "api",
  timeoutMs = REQUEST_TIMEOUT_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Api {
  const authListeners: ((signedIn: boolean) => void)[] = [];
  /** Tells the listeners what a response says about the sign-in. */
  function noteAuth(res: Response): Response {
    const signedIn = res.status === 401 ? false : res.ok ? true : null;
    if (signedIn !== null) for (const listener of authListeners) listener(signedIn);
    return res;
  }

  const getOnce = (path: string): Promise<Response> =>
    fetchFn(`${base}/${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

  /** A GET, retried once after a 401: only a second 401 in a row is told as signed out. */
  async function get(path: string): Promise<Response> {
    const res = await getOnce(path);
    if (res.status !== 401) return noteAuth(res);
    await wait(AUTH_RETRY_MS);
    return noteAuth(await getOnce(path));
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await get(path);
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as T;
  }

  async function getJsonOrNull<T>(path: string): Promise<T | null> {
    const res = await get(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as T;
  }

  async function ask(
    req: AskRequest,
    signal: AbortSignal,
    onEvent: (e: AskEvent) => void,
  ): Promise<void> {
    const res = await fetchFn(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(req),
      signal,
    });
    if (res.status === 401) {
      // A question is never sent twice: the sign-in is checked with a GET of now instead.
      await wait(AUTH_RETRY_MS);
      if (noteAuth(await getOnce("now")).status === 401) throw new ApiError(401);
      throw new Error("question refused with 401 while signed in");
    }
    noteAuth(res);
    if (!res.ok) throw await askError(res);
    if (res.body === null) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // The part after the last newline is incomplete until the stream ends.
      buffered = done ? "" : (lines.pop() ?? "");
      for (const line of lines) emitLine(line, onEvent);
      if (done) return;
    }
  }

  return {
    ask,
    onAuth: (listener) => void authListeners.push(listener),
    now: () => getJson<NowResponse>("now"),
    guides: (refresh = false) => getJson<GuidesResponse>(refresh ? "guides?refresh=1" : "guides"),
    hubTree: (hubId) => getJson<HubTreeResponse>(`guides/${encodeURIComponent(hubId)}`),
    achievements: (source, id) =>
      getJsonOrNull<AchievementsResponse>(
        `achievements/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      ),
    find: (hubId, query) =>
      getJsonOrNull<FindResponse>(
        `guides/${encodeURIComponent(hubId)}/find?q=${encodeURIComponent(query)}`,
      ),
    marks: (hubId) =>
      getJsonOrNull<GuideMarksResponse>(`guides/${encodeURIComponent(hubId)}/marks`),
    where: (hubId) =>
      getJsonOrNull<GuideWhereResponse>(`guides/${encodeURIComponent(hubId)}/where`),
    progress: (hubId, refresh = false) =>
      getJsonOrNull<GuideProgressResponse>(
        `guides/${encodeURIComponent(hubId)}/progress${refresh ? "?refresh=1" : ""}`,
      ),
  };
}
