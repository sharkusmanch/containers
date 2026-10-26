import { describe, expect, it } from "vitest";
import { checkboxItems, type PMNode } from "../src/web/guide-checkbox.js";
import { OutlineError, type GuideDocument, type OutlineApi } from "../src/web/outline-api.js";
import { tick } from "../src/web/guide-tick.js";

const MD = ["## Area", "", "- [ ] Potion", "- [ ] Ether", "- [x] Done"].join("\n");
const TWINS = ["## One", "", "- [ ] Potion", "", "## Two", "", "- [ ] Potion", ""].join("\n");

function docFor(md: string, revision: number): GuideDocument {
  const items: PMNode[] = [];
  for (const line of md.split("\n")) {
    const match = /^- \[([ x])\] (.*)$/.exec(line);
    if (match) {
      items.push({
        type: "checkbox_item",
        attrs: { checked: match[1] === "x" },
        content: [{ type: "paragraph", content: [{ type: "text", text: match[2] ?? "" }] }],
      });
    }
  }
  return {
    id: "doc-1",
    title: "Synthetic",
    url: "/doc/synthetic",
    revision,
    data: { type: "doc", content: [{ type: "checkbox_list", content: items }] },
  };
}

type Call = "markdown" | "document" | "patch";

interface Fake extends OutlineApi {
  md: string;
  revision: number;
  calls: Call[];
  patches: { id: string; findText: string; text: string; lastRevision: number }[];
  fail: Partial<Record<Call, Error[]>>;
  /** What a patch does to the stored page: apply it (default) or leave it alone. */
  land: boolean;
}

/** A page held as Markdown; `fail[call]` is a queue of errors, one thrown per call. */
function fake(md: string, revision = 5): Fake {
  const api: Fake = {
    md,
    revision,
    calls: [],
    patches: [],
    fail: {},
    land: true,
    async document() {
      api.calls.push("document");
      const err = api.fail.document?.shift();
      if (err !== undefined) throw err;
      return docFor(api.md, api.revision);
    },
    async markdown() {
      api.calls.push("markdown");
      const err = api.fail.markdown?.shift();
      if (err !== undefined) throw err;
      return { text: api.md, revision: api.revision };
    },
    async patch(id, edit) {
      api.calls.push("patch");
      api.patches.push({ id, ...edit });
      const err = api.fail.patch?.shift();
      if (err !== undefined) {
        if (api.land) apply(api, edit);
        throw err;
      }
      if (api.land) apply(api, edit);
    },
  };
  return api;
}

function apply(api: Fake, edit: { findText: string; text: string }): void {
  api.md = api.md.replace(edit.findText, () => edit.text);
  api.revision += 1;
}

const checkedAt = (doc: GuideDocument, index: number): boolean | undefined =>
  checkboxItems(doc.data)[index]?.attrs?.["checked"] as boolean | undefined;

describe("tick", () => {
  it("saves and returns the read-back document", async () => {
    const api = fake(MD);
    const shown = docFor(MD, 5);
    const result = await tick(api, shown, 0, true);
    expect(api.patches).toEqual([
      { id: "doc-1", findText: "- [ ] Potion\n", text: "- [x] Potion\n", lastRevision: 5 },
    ]);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(checkedAt(result.doc, 0)).toBe(true);
    expect(result.doc.revision).toBe(6);
    expect(api.calls).toEqual(["markdown", "patch", "document"]);
  });

  it("unticks a ticked box", async () => {
    const api = fake(MD);
    const result = await tick(api, docFor(MD, 5), 2, false);
    expect(result.kind).toBe("saved");
    expect(api.md).toContain("- [ ] Done");
  });

  it("reports a conflict when the Markdown revision moved", async () => {
    const api = fake(MD, 7);
    const result = await tick(api, docFor(MD, 5), 0, true);
    expect(api.patches).toHaveLength(0);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.doc.revision).toBe(7);
    expect(api.calls).toEqual(["markdown", "document"]);
  });

  it("reports a conflict on 409 with a fresh document", async () => {
    const api = fake(MD);
    api.land = false;
    api.fail.patch = [new OutlineError(409, "conflict")];
    const result = await tick(api, docFor(MD, 5), 0, true);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(checkedAt(result.doc, 0)).toBe(false);
    expect(api.calls).toEqual(["markdown", "patch", "document"]);
  });

  it("fails with no document when the conflict refresh fails", async () => {
    const stale = fake(MD, 7);
    stale.fail.document = [new OutlineError(0, "other")];
    expect(await tick(stale, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });

    const raced = fake(MD);
    raced.land = false;
    raced.fail.patch = [new OutlineError(409, "conflict")];
    raced.fail.document = [new OutlineError(500, "other")];
    expect(await tick(raced, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });
  });

  it("passes a refusal through without patching", async () => {
    const api = fake(TWINS);
    const result = await tick(api, docFor(TWINS, 5), 0, true);
    expect(result).toEqual({ kind: "refused", reason: "ambiguous" });
    expect(api.patches).toHaveLength(0);
    expect(api.calls).toEqual(["markdown"]);
  });

  it("refuses when the box is not as shown", async () => {
    const shown = docFor(MD, 5);
    const api = fake(MD.replace("- [ ] Potion", "- [x] Potion"));
    expect(await tick(api, shown, 0, true)).toEqual({ kind: "refused", reason: "state" });
    expect(api.patches).toHaveLength(0);
  });

  it("refuses when the box count differs", async () => {
    const shown = docFor(MD, 5);
    const api = fake(`${MD}\n- [ ] Extra`);
    expect(await tick(api, shown, 0, true)).toEqual({ kind: "refused", reason: "count" });
  });

  it("answers signed-out from any call", async () => {
    const signedOut = new OutlineError(401, "signed-out");

    const md = fake(MD);
    md.fail.markdown = [signedOut];
    expect(await tick(md, docFor(MD, 5), 0, true)).toEqual({ kind: "signed-out" });
    expect(md.patches).toHaveLength(0);

    const patch = fake(MD);
    patch.land = false;
    patch.fail.patch = [new OutlineError(403, "signed-out")];
    expect(await tick(patch, docFor(MD, 5), 0, true)).toEqual({ kind: "signed-out" });

    const refresh = fake(MD, 7);
    refresh.fail.document = [signedOut];
    expect(await tick(refresh, docFor(MD, 5), 0, true)).toEqual({ kind: "signed-out" });

    const readBack = fake(MD);
    readBack.fail.document = [signedOut];
    expect(await tick(readBack, docFor(MD, 5), 0, true)).toEqual({ kind: "signed-out" });
  });

  it("fails with no document when the Markdown cannot be read", async () => {
    const api = fake(MD);
    api.fail.markdown = [new OutlineError(500, "other")];
    expect(await tick(api, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });
    expect(api.patches).toHaveLength(0);
    expect(api.calls).toEqual(["markdown"]);

    const odd = fake(MD);
    odd.fail.markdown = [new TypeError("boom")];
    expect(await tick(odd, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });
  });

  it("treats a failed request that did land as saved", async () => {
    const api = fake(MD);
    api.fail.patch = [new OutlineError(0, "other")];
    const result = await tick(api, docFor(MD, 5), 0, true);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(checkedAt(result.doc, 0)).toBe(true);
      expect(result.doc.revision).toBe(6);
    }
  });

  it("treats a thrown non-OutlineError on a landed patch as saved", async () => {
    const api = fake(MD);
    api.fail.patch = [new Error("timeout")];
    expect((await tick(api, docFor(MD, 5), 0, true)).kind).toBe("saved");
  });

  it("fails when a failed request did not land", async () => {
    for (const err of [new OutlineError(500, "other"), new OutlineError(404, "not-found")]) {
      const api = fake(MD);
      api.land = false;
      api.fail.patch = [err];
      const result = await tick(api, docFor(MD, 5), 0, true);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(checkedAt(result.doc as GuideDocument, 0)).toBe(false);
    }
  });

  it("fails when the state matches but the revision did not advance", async () => {
    // The failed patch did not land and the read-back is still at the shown revision: a matching
    // box is not our write, so it is not a save.
    const ticked = MD.replace("- [ ] Potion", "- [x] Potion");
    const api = fake(MD);
    api.land = false;
    api.fail.patch = [new OutlineError(500, "other")];
    api.document = async () => docFor(ticked, 5);
    const result = await tick(api, docFor(MD, 5), 0, true);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.doc?.revision).toBe(5);
  });

  it("fails with that document when the read-back disagrees", async () => {
    const api = fake(MD);
    api.land = false;
    const result = await tick(api, docFor(MD, 5), 0, true);
    expect(api.patches).toHaveLength(1);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(checkedAt(result.doc as GuideDocument, 0)).toBe(false);
  });

  it("fails with no document when the re-read also fails", async () => {
    const afterOk = fake(MD);
    afterOk.fail.document = [new OutlineError(0, "other")];
    expect(await tick(afterOk, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });

    const afterError = fake(MD);
    afterError.fail.patch = [new OutlineError(500, "other")];
    afterError.fail.document = [new Error("offline")];
    expect(await tick(afterError, docFor(MD, 5), 0, true)).toEqual({ kind: "failed", doc: null });
  });

  it("uses the shown document's id for every call", async () => {
    const calls: string[] = [];
    const api = fake(MD);
    const spy: OutlineApi = {
      document: (id, s) => (calls.push(id), api.document(id, s)),
      markdown: (id) => (calls.push(id), api.markdown(id)),
      patch: (id, e) => (calls.push(id), api.patch(id, e)),
    };
    await tick(spy, docFor(MD, 5), 1, true);
    expect(calls).toEqual(["doc-1", "doc-1", "doc-1"]);
  });
});
