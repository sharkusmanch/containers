import type {
  AchievementsResponse,
  GuidesResponse,
  HubTreeResponse,
  NowResponse,
  Source,
} from "../shared/types.js";

export const REQUEST_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(readonly status: number) {
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
}

export function createApi(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "api",
  timeoutMs = REQUEST_TIMEOUT_MS,
): Api {
  async function get(path: string): Promise<Response> {
    return fetchFn(`${base}/${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await get(path);
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as T;
  }

  return {
    now: () => getJson<NowResponse>("now"),
    guides: (refresh = false) => getJson<GuidesResponse>(refresh ? "guides?refresh=1" : "guides"),
    hubTree: (hubId) => getJson<HubTreeResponse>(`guides/${encodeURIComponent(hubId)}`),
    async achievements(source, id) {
      const res = await get(`achievements/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError(res.status);
      return (await res.json()) as AchievementsResponse;
    },
  };
}
