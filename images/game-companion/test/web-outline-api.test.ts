import { describe, expect, it } from "vitest";
import { OutlineError, createOutlineApi, csrfToken } from "../src/web/outline-api.js";

interface Call {
  url: string;
  init: RequestInit;
}

function fake(
  status: number,
  body: unknown,
): { fn: typeof fetch; calls: Call[]; headers: (i: number) => Headers } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls, headers: (i) => new Headers(calls[i]?.init.headers) };
}

const COOKIE = "__Host-csrfToken=tok.sig; other=1";
const DOC = {
  id: "abc",
  title: "Act 1",
  url: "/doc/act-1-abc",
  revision: 7,
  data: { type: "doc", content: [] },
};
/** How Outline 1.12 wraps a v3 documents.info answer. */
const v3 = (document: unknown): unknown => ({ data: { document } });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
}

describe("csrfToken", () => {
  it("reads the plain-HTTP cookie", () => {
    expect(csrfToken("csrfToken=a.b")).toBe("a.b");
  });
  it("reads the __Host- cookie among others", () => {
    expect(csrfToken(COOKIE)).toBe("tok.sig");
  });
  it("prefers the __Host- cookie over the plain one", () => {
    expect(csrfToken("csrfToken=plain; __Host-csrfToken=host")).toBe("host");
  });
  it("returns null when absent", () => {
    expect(csrfToken("x=1")).toBeNull();
    expect(csrfToken("")).toBeNull();
  });
  it("URI-decodes the value", () => {
    expect(csrfToken("csrfToken=a%2Fb%3D")).toBe("a/b=");
  });
});

describe("OutlineApi.document", () => {
  it("posts documents.info with the v3 header and returns the document", async () => {
    const f = fake(200, v3({ ...DOC, extra: 1 }));
    const doc = await createOutlineApi({ fetch: f.fn, cookie: () => COOKIE }).document("abc");
    expect(doc).toEqual(DOC);
    expect(f.calls[0]?.url).toBe("/api/documents.info");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(f.calls[0]?.init.body).toBe('{"id":"abc"}');
    expect(f.calls[0]?.init.credentials).toBe("same-origin");
    expect(f.headers(0).get("content-type")).toBe("application/json");
    expect(f.headers(0).get("x-api-version")).toBe("3");
    expect(f.headers(0).get("x-csrf-token")).toBeNull();
  });

  it("rejects a response without data", async () => {
    for (const body of [{}, { data: {} }, { data: { document: null } }]) {
      const f = fake(200, body);
      const err = await rejection(
        createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("a"),
      );
      expect(err).toBeInstanceOf(OutlineError);
      expect(err).toMatchObject({ status: 200, kind: "other" });
    }
  });

  it("rejects the flat { data: document } shape of an unversioned answer", async () => {
    const f = fake(200, { data: DOC });
    const err = await rejection(createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("a"));
    expect(err).toBeInstanceOf(OutlineError);
    expect(err).toMatchObject({ status: 200, kind: "other" });
  });

  it("parses a realistic Outline 1.12 v3 answer with extra fields and policies", async () => {
    const body = {
      data: {
        document: {
          id: "9f3c2a1e-0b4d-4c8e-9a7f-1d2e3f4a5b6c",
          url: "/doc/chapter-1-walkthrough-Xy12AbC9dE",
          urlId: "Xy12AbC9dE",
          title: "Chapter 1 walkthrough",
          icon: null,
          color: null,
          revision: 42,
          fullWidth: false,
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-26T08:30:00.000Z",
          publishedAt: "2026-10-01T12:05:00.000Z",
          archivedAt: null,
          deletedAt: null,
          collectionId: "11111111-2222-3333-4444-555555555555",
          parentDocumentId: null,
          isCollectionDeleted: false,
          tasks: { completed: 1, total: 3 },
          createdBy: { id: "u1", name: "Marcus" },
          updatedBy: { id: "u1", name: "Marcus" },
          collaboratorIds: ["u1"],
          data: {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 1 },
                content: [{ type: "text", text: "Area One" }],
              },
              {
                type: "checkbox_list",
                content: [
                  {
                    type: "checkbox_item",
                    attrs: { checked: true },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }],
                  },
                ],
              },
            ],
          },
        },
      },
      policies: [
        {
          id: "9f3c2a1e-0b4d-4c8e-9a7f-1d2e3f4a5b6c",
          abilities: { read: true, update: true, delete: true },
        },
      ],
      status: 200,
      ok: true,
    };
    const f = fake(200, body);
    const doc = await createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("Xy12AbC9dE");
    expect(doc).toEqual({
      id: "9f3c2a1e-0b4d-4c8e-9a7f-1d2e3f4a5b6c",
      title: "Chapter 1 walkthrough",
      url: "/doc/chapter-1-walkthrough-Xy12AbC9dE",
      revision: 42,
      data: body.data.document.data,
    });
  });

  it("rejects a non-integer revision", async () => {
    const f = fake(200, v3({ ...DOC, revision: 1.5 }));
    const err = await rejection(createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("a"));
    expect(err).toMatchObject({ status: 200, kind: "other" });
  });

  it("rejects a document whose data is not a node", async () => {
    for (const data of [null, "x", {}, { type: 3 }]) {
      const f = fake(200, v3({ ...DOC, data }));
      const err = await rejection(
        createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("a"),
      );
      expect(err).toMatchObject({ status: 200, kind: "other" });
    }
  });

  it("rejects a body that is not JSON", async () => {
    const fn = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    const err = await rejection(createOutlineApi({ fetch: fn, cookie: () => "" }).document("a"));
    expect(err).toMatchObject({ status: 200, kind: "other" });
  });

  it("rejects with the abort error, not an OutlineError, when the caller aborts", async () => {
    const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as typeof fetch;
    const ctl = new AbortController();
    const p = rejection(
      createOutlineApi({ fetch: fn, cookie: () => "" }).document("a", ctl.signal),
    );
    ctl.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(OutlineError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("rejects at once when the signal is already aborted", async () => {
    const f = fake(200, v3(DOC));
    const ctl = new AbortController();
    ctl.abort();
    const err = await rejection(
      createOutlineApi({ fetch: f.fn, cookie: () => "" }).document("a", ctl.signal),
    );
    expect(err).not.toBeInstanceOf(OutlineError);
  });
});

describe("OutlineApi.markdown", () => {
  it("posts documents.info without the v3 header and returns text and revision", async () => {
    const f = fake(200, { data: { text: "- [ ] a", revision: 4, id: "abc" } });
    const out = await createOutlineApi({ fetch: f.fn, cookie: () => COOKIE }).markdown("abc");
    expect(out).toEqual({ text: "- [ ] a", revision: 4 });
    expect(f.calls[0]?.url).toBe("/api/documents.info");
    expect(f.calls[0]?.init.body).toBe('{"id":"abc"}');
    expect(f.calls[0]?.init.credentials).toBe("same-origin");
    expect(f.headers(0).get("content-type")).toBe("application/json");
    expect(f.headers(0).has("x-api-version")).toBe(false);
  });

  it("rejects a response missing the text or an integer revision", async () => {
    for (const data of [{ revision: 1 }, { text: "x" }, { text: "x", revision: "1" }, null]) {
      const f = fake(200, { data });
      const err = await rejection(
        createOutlineApi({ fetch: f.fn, cookie: () => "" }).markdown("a"),
      );
      expect(err).toMatchObject({ status: 200, kind: "other" });
    }
  });
});

describe("OutlineApi.patch", () => {
  const edit = { findText: "- [ ] a", text: "- [x] a", lastRevision: 4 };

  it("posts a patch edit with the v3 header and the CSRF token from the cookie", async () => {
    const f = fake(200, { data: {} });
    await createOutlineApi({ fetch: f.fn, cookie: () => COOKIE }).patch("abc", edit);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("/api/documents.update");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(f.calls[0]?.init.credentials).toBe("same-origin");
    expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({
      id: "abc",
      editMode: "patch",
      findText: "- [ ] a",
      text: "- [x] a",
      lastRevision: 4,
    });
    expect(f.headers(0).get("content-type")).toBe("application/json");
    expect(f.headers(0).get("x-api-version")).toBe("3");
    expect(f.headers(0).get("x-csrf-token")).toBe("tok.sig");
  });

  it("sends only the edit's own fields and ignores the v3 answer body", async () => {
    const f = fake(200, v3({ ...DOC, revision: 5 }));
    const extra = { ...edit, collectionId: "c", publish: true } as typeof edit;
    await expect(
      createOutlineApi({ fetch: f.fn, cookie: () => COOKIE }).patch("abc", extra),
    ).resolves.toBeUndefined();
    expect(Object.keys(JSON.parse(f.calls[0]?.init.body as string) as object).sort()).toEqual([
      "editMode",
      "findText",
      "id",
      "lastRevision",
      "text",
    ]);
  });

  it("reads the cookie at call time", async () => {
    const f = fake(200, {});
    let cookie = "";
    const api = createOutlineApi({ fetch: f.fn, cookie: () => cookie });
    cookie = "csrfToken=late";
    await api.patch("abc", edit);
    expect(f.headers(0).get("x-csrf-token")).toBe("late");
  });

  it("rejects as signed out without a request when there is no CSRF cookie", async () => {
    const f = fake(200, {});
    const err = await rejection(
      createOutlineApi({ fetch: f.fn, cookie: () => "x=1" }).patch("abc", edit),
    );
    expect(err).toBeInstanceOf(OutlineError);
    expect(err).toMatchObject({ status: 0, kind: "signed-out" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("OutlineError mapping", () => {
  const cases: [number, string][] = [
    [401, "signed-out"],
    [403, "signed-out"],
    [409, "conflict"],
    [404, "not-found"],
    [500, "other"],
  ];

  for (const [status, kind] of cases) {
    it(`maps ${status} to ${kind} for every call`, async () => {
      const api = (): ReturnType<typeof createOutlineApi> =>
        createOutlineApi({ fetch: fake(status, {}).fn, cookie: () => COOKIE });
      const edit = { findText: "a", text: "b", lastRevision: 1 };
      for (const p of [api().document("a"), api().markdown("a"), api().patch("a", edit)]) {
        const err = await rejection(p);
        expect(err).toBeInstanceOf(OutlineError);
        expect(err).toMatchObject({ status, kind });
      }
    });
  }

  it("maps a network error to status 0, other", async () => {
    const fn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const err = await rejection(
      createOutlineApi({ fetch: fn, cookie: () => COOKIE }).document("a"),
    );
    expect(err).toBeInstanceOf(OutlineError);
    expect(err).toMatchObject({ status: 0, kind: "other" });
  });

  it("maps a timeout to status 0, other", async () => {
    const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as typeof fetch;
    const api = createOutlineApi({ fetch: fn, cookie: () => COOKIE, timeoutMs: 10 });
    const err = await rejection(api.document("a"));
    expect(err).toBeInstanceOf(OutlineError);
    expect(err).toMatchObject({ status: 0, kind: "other" });
  });

  it("has a name and message", () => {
    const e = new OutlineError(409, "conflict");
    expect(e.name).toBe("OutlineError");
    expect(e.message).toContain("409");
  });
});
