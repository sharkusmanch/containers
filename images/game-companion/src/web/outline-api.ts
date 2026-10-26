import type { PMNode } from "./guide-checkbox.js";

/** A guide page as Outline's v3 API answers it: the ProseMirror tree plus the revision it is at. */
export interface GuideDocument {
  id: string;
  title: string;
  url: string;
  revision: number;
  data: PMNode;
}

export type OutlineErrorKind = "signed-out" | "conflict" | "not-found" | "other";

export const OUTLINE_TIMEOUT_MS = 10_000;

export class OutlineError extends Error {
  constructor(
    /** The HTTP status, or 0 when no response arrived (and for a missing CSRF cookie). */
    readonly status: number,
    readonly kind: OutlineErrorKind,
  ) {
    super(`outline request failed with status ${status} (${kind})`);
    this.name = "OutlineError";
  }
}

export interface OutlineApi {
  /** Rejects with the abort error, not an OutlineError, when `signal` aborts. */
  document(id: string, signal?: AbortSignal): Promise<GuideDocument>;
  markdown(id: string): Promise<{ text: string; revision: number }>;
  /** Replaces `findText` with `text` if the page is still at `lastRevision` (409 otherwise). */
  patch(id: string, edit: { findText: string; text: string; lastRevision: number }): Promise<void>;
}

/** The CSRF token of Outline's double-submit cookie, or null when there is none. */
export function csrfToken(cookie: string): string | null {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!values.has(name)) values.set(name, part.slice(eq + 1).trim());
  }
  const raw = values.get("__Host-csrfToken") ?? values.get("csrfToken");
  if (raw === undefined || raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function kindOf(status: number): OutlineErrorKind {
  if (status === 401 || status === 403) return "signed-out";
  if (status === 409) return "conflict";
  if (status === 404) return "not-found";
  return "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `data.document` of a v3 documents.info answer (`{ data: { document }, policies }` on Outline
 * 1.12), checked down to what the reader uses. The flat `{ data: document }` shape of an
 * unversioned answer is rejected: it carries markdown, not the ProseMirror tree.
 */
function toGuideDocument(body: unknown, status: number): GuideDocument {
  const data = isRecord(body) ? body["data"] : undefined;
  const wrapped = isRecord(data) ? data["document"] : undefined;
  const doc = isRecord(wrapped) ? wrapped : undefined;
  if (
    doc !== undefined &&
    typeof doc["id"] === "string" &&
    typeof doc["title"] === "string" &&
    typeof doc["url"] === "string" &&
    typeof doc["revision"] === "number" &&
    Number.isInteger(doc["revision"]) &&
    isRecord(doc["data"]) &&
    typeof doc["data"]["type"] === "string"
  ) {
    return {
      id: doc["id"],
      title: doc["title"],
      url: doc["url"],
      revision: doc["revision"],
      data: doc["data"] as unknown as PMNode,
    };
  }
  throw new OutlineError(status, "other");
}

export function createOutlineApi(deps: {
  fetch: typeof fetch;
  cookie: () => string;
  timeoutMs?: number;
}): OutlineApi {
  const timeoutMs = deps.timeoutMs ?? OUTLINE_TIMEOUT_MS;

  /**
   * POSTs `body` to an Outline route and answers the parsed JSON with the status. Fails with an
   * OutlineError, except when the caller's `signal` aborts: that error passes through untouched.
   */
  async function post(
    route: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    signal?.throwIfAborted();
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error("outline request timed out")), timeoutMs);
    try {
      const res = await deps.fetch(`/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: ctl.signal,
      });
      if (!res.ok) throw new OutlineError(res.status, kindOf(res.status));
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        if (signal?.aborted === true) throw e;
        throw new OutlineError(res.status, "other");
      }
      return { status: res.status, json };
    } catch (e) {
      if (signal?.aborted === true || e instanceof OutlineError) throw e;
      throw new OutlineError(0, "other");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async document(id, signal) {
      const { status, json } = await post(
        "documents.info",
        { "x-api-version": "3" },
        { id },
        signal,
      );
      return toGuideDocument(json, status);
    },

    async markdown(id) {
      const { status, json } = await post("documents.info", {}, { id });
      const data = isRecord(json) ? json["data"] : undefined;
      if (
        isRecord(data) &&
        typeof data["text"] === "string" &&
        typeof data["revision"] === "number" &&
        Number.isInteger(data["revision"])
      ) {
        return { text: data["text"], revision: data["revision"] };
      }
      throw new OutlineError(status, "other");
    },

    // The v3 answer (`{ data: { document } }`) is not read: guide-tick reads the page back.
    async patch(id, edit) {
      const token = csrfToken(deps.cookie());
      if (token === null) throw new OutlineError(0, "signed-out");
      await post(
        "documents.update",
        { "x-api-version": "3", "x-csrf-token": token },
        {
          id,
          editMode: "patch",
          findText: edit.findText,
          text: edit.text,
          lastRevision: edit.lastRevision,
        },
      );
    },
  };
}
