import { fetchJson, UpstreamError, type FetchLike } from "./fetch-json.js";

const PAGE_SIZE = 100;

export interface OutlineDoc {
  id: string;
  title: string;
  url: string;
  text: string;
}
export interface OutlineNode {
  id: string;
  title: string;
  url: string;
  children: OutlineNode[];
}

type Rec = Record<string, unknown>;

const badShape = (): UpstreamError => new UpstreamError("unexpected response shape", null);
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function rec(v: unknown): Rec {
  if (!isRec(v)) throw badShape();
  return v;
}

function parseDoc(v: unknown): OutlineDoc {
  const d = rec(v);
  if (
    typeof d.id !== "string" ||
    typeof d.title !== "string" ||
    typeof d.url !== "string" ||
    typeof d.text !== "string"
  ) {
    throw badShape();
  }
  return { id: d.id, title: d.title, url: d.url, text: d.text };
}

function parseNode(v: unknown): OutlineNode {
  const n = rec(v);
  if (
    typeof n.id !== "string" ||
    typeof n.title !== "string" ||
    typeof n.url !== "string" ||
    !Array.isArray(n.children)
  ) {
    throw badShape();
  }
  return {
    id: n.id,
    title: n.title,
    url: n.url,
    children: (n.children as unknown[]).map(parseNode),
  };
}

export class OutlineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: { baseUrl: string; apiKey: string; fetchFn?: FetchLike }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private post(method: string, payload: Record<string, unknown>): Promise<Rec> {
    return fetchJson(this.fetchFn, `${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(rec);
  }

  async listChildren(parentDocumentId: string): Promise<OutlineDoc[]> {
    const docs: OutlineDoc[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const body = await this.post("documents.list", {
        parentDocumentId,
        limit: PAGE_SIZE,
        offset,
      });
      if (!Array.isArray(body.data)) throw badShape();
      const page = (body.data as unknown[]).map(parseDoc);
      docs.push(...page);
      // An empty page always ends the walk, so a wrong total can never loop forever.
      if (page.length === 0) break;
      const total = isRec(body.pagination) ? body.pagination.total : undefined;
      if (typeof total === "number" ? docs.length >= total : page.length < PAGE_SIZE) break;
    }
    return docs;
  }

  async collectionTree(collectionId: string): Promise<OutlineNode[]> {
    const body = await this.post("collections.documents", { id: collectionId });
    if (!Array.isArray(body.data)) throw badShape();
    return (body.data as unknown[]).map(parseNode);
  }

  async docText(id: string): Promise<string> {
    const text = rec((await this.post("documents.info", { id })).data).text;
    if (typeof text !== "string") throw badShape();
    return text;
  }
}
