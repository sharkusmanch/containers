import { describe, expect, it } from "vitest";
import {
  checkboxItems,
  checkboxLines,
  planCheckboxPatch,
  type PMNode,
} from "../src/web/guide-checkbox.js";

const MD = [
  "## Area One",
  "",
  "- [ ] Potion",
  "- [ ] Ether",
  "- [ ] Potion",
  "  - [ ] Nested",
  "",
  "## Area Two",
  "",
  "- [ ] Potion",
  "- [x] Done",
  "",
  "```",
  "- [ ] not a box",
  "```",
].join("\n");

describe("checkboxLines", () => {
  it("finds checkbox lines outside code fences, in order", () => {
    expect(checkboxLines(MD).map((l) => l.line)).toEqual([2, 3, 4, 5, 9, 10]);
    expect(checkboxLines(MD)[5]?.checked).toBe(true);
  });

  it("ignores boxes inside tilde fences and sees quoted boxes", () => {
    const md = "~~~\n- [ ] hidden\n~~~\n> - [X] Q\n";
    expect(checkboxLines(md)).toEqual([{ line: 3, checked: true }]);
  });
});

describe("checkboxItems", () => {
  it("lists checkbox_item nodes depth-first", () => {
    const item = (name: string, children: PMNode[] = []): PMNode => ({
      type: "checkbox_item",
      attrs: { name },
      content: [{ type: "paragraph" }, ...children],
    });
    const doc: PMNode = {
      type: "doc",
      content: [
        {
          type: "checkbox_list",
          content: [
            item("a", [{ type: "checkbox_list", content: [item("a1"), item("a2")] }]),
            item("b"),
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        { type: "checkbox_list", content: [item("c")] },
      ],
    };
    expect(checkboxItems(doc).map((n) => n.attrs?.name)).toEqual(["a", "a1", "a2", "b", "c"]);
  });

  it("is empty when there are no checkboxes", () => {
    expect(checkboxItems({ type: "doc", content: [{ type: "paragraph" }] })).toEqual([]);
  });
});

describe("planCheckboxPatch", () => {
  it("patches a unique line on its own", () => {
    expect(planCheckboxPatch(MD, 6, 1, false, true)).toEqual({
      ok: true,
      findText: "- [ ] Ether\n",
      text: "- [x] Ether\n",
    });
  });

  it("widens a duplicate to the following line first", () => {
    expect(planCheckboxPatch(MD, 6, 4, false, true)).toEqual({
      ok: true,
      findText: "- [ ] Potion\n- [x] Done\n",
      text: "- [x] Potion\n- [x] Done\n",
    });
  });

  it("widens to the preceding line when the item ends its list", () => {
    const tail = "- [ ] X\n- [ ] Potion\n\npara\n\n- [ ] Y\n- [ ] Potion\n";
    expect(planCheckboxPatch(tail, 4, 1, false, true)).toEqual({
      ok: true,
      findText: "- [ ] X\n- [ ] Potion\n",
      text: "- [ ] X\n- [x] Potion\n",
    });
  });

  it("refuses when no window inside the block is unique", () => {
    const twin = "- [ ] A\n- [ ] B\n\ntext\n\n- [ ] A\n- [ ] B\n";
    expect(planCheckboxPatch(twin, 4, 0, false, true)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("refuses a count mismatch", () => {
    expect(planCheckboxPatch(MD, 7, 0, false, true)).toEqual({ ok: false, reason: "count" });
  });

  it("refuses an index past the last checkbox", () => {
    expect(planCheckboxPatch(MD, 6, 6, false, true)).toEqual({ ok: false, reason: "count" });
  });

  it("refuses when the box is not in the state shown", () => {
    expect(planCheckboxPatch(MD, 6, 5, false, true)).toEqual({ ok: false, reason: "state" });
  });

  it("never returns a findText with a blank line", () => {
    for (let i = 0; i < 6; i++) {
      const plan = planCheckboxPatch(MD, 6, i, i === 5, i !== 5);
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.findText).not.toMatch(/\n\s*\n/);
    }
  });

  it("patches the last line of a document without a trailing newline", () => {
    expect(planCheckboxPatch("- [ ] A\n- [ ] B", 2, 1, false, true)).toEqual({
      ok: true,
      findText: "- [ ] B",
      text: "- [x] B",
    });
  });

  it("unticks a ticked box", () => {
    expect(planCheckboxPatch("- [X] A\n- [ ] B\n", 2, 0, true, false)).toEqual({
      ok: true,
      findText: "- [X] A\n",
      text: "- [ ] A\n",
    });
  });

  it("keeps a quoted item's quote marks", () => {
    expect(planCheckboxPatch("> - [ ] Q\n", 1, 0, false, true)).toEqual({
      ok: true,
      findText: "> - [ ] Q\n",
      text: "> - [x] Q\n",
    });
  });
});
