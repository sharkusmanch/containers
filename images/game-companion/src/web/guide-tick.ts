/**
 * Saving one checkbox tick to Outline. Pure apart from the injected `OutlineApi`; the reader calls
 * `tick` on each tap and acts on the `TickResult`. It never throws, and it only reports `saved`
 * once a fresh read of the page shows the box in the requested state.
 */
import { checkboxItems, planCheckboxPatch } from "./guide-checkbox.js";
import { OutlineError, type GuideDocument, type OutlineApi } from "./outline-api.js";

export type TickResult =
  | { kind: "saved"; doc: GuideDocument }
  | { kind: "conflict"; doc: GuideDocument }
  | { kind: "refused"; reason: "count" | "state" | "ambiguous" }
  | { kind: "signed-out" }
  | { kind: "failed"; doc: GuideDocument | null };

type Fetched<T> = { ok: true; value: T } | { ok: false; result: TickResult };

const isSignedOut = (e: unknown): boolean => e instanceof OutlineError && e.kind === "signed-out";

/** Runs an Outline call, turning a rejection into the `TickResult` it means (never a throw). */
async function attempt<T>(run: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    return {
      ok: false,
      result: isSignedOut(e) ? { kind: "signed-out" } : { kind: "failed", doc: null },
    };
  }
}

const checkedAt = (doc: GuideDocument, index: number): boolean | undefined => {
  const value = checkboxItems(doc.data)[index]?.attrs?.["checked"];
  return typeof value === "boolean" ? value : undefined;
};

/**
 * Sets the `index`th checkbox of `shown` to `checked`. `shown` is what the reader displays: the
 * save is refused unless Outline's Markdown is still at that revision and has the same boxes.
 */
export async function tick(
  outline: OutlineApi,
  shown: GuideDocument,
  index: number,
  checked: boolean,
): Promise<TickResult> {
  const conflict = async (): Promise<TickResult> => {
    const fresh = await attempt(() => outline.document(shown.id));
    return fresh.ok ? { kind: "conflict", doc: fresh.value } : fresh.result;
  };

  const md = await attempt(() => outline.markdown(shown.id));
  if (!md.ok) return md.result;
  if (md.value.revision !== shown.revision) return conflict();

  const items = checkboxItems(shown.data);
  const shownChecked = items[index]?.attrs?.["checked"] === true;
  const plan = planCheckboxPatch(md.value.text, items.length, index, shownChecked, checked);
  if (!plan.ok) return { kind: "refused", reason: plan.reason };

  let patchError: unknown;
  try {
    await outline.patch(shown.id, {
      findText: plan.findText,
      text: plan.text,
      lastRevision: shown.revision,
    });
  } catch (e) {
    if (isSignedOut(e)) return { kind: "signed-out" };
    if (e instanceof OutlineError && e.kind === "conflict") return conflict();
    patchError = e;
  }

  const reread = await attempt(() => outline.document(shown.id));
  if (!reread.ok) return reread.result;
  const doc = reread.value;
  if (checkedAt(doc, index) !== checked) return { kind: "failed", doc };
  // A request that errored may still have landed; only count it when the page moved on.
  if (patchError !== undefined && doc.revision <= shown.revision) return { kind: "failed", doc };
  return { kind: "saved", doc };
}
