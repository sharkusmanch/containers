/**
 * The guide reader's toast: a tick's outcome at the bottom of the reader's visible area. The
 * reader's status line is at the top of the page and has usually scrolled away on a long
 * checklist, so a refused or reverted tap looked like nothing more than a box changing back.
 */

/** How long an outcome stays on screen, unless a newer one replaces it or it is tapped away. */
export const TOAST_MS = 5000;

/** Writes `text` into `target`, followed by a link to sign in to Outline when `signIn`. */
export function writeMessage(target: HTMLElement, text: string, signIn = false): void {
  target.replaceChildren(text);
  if (!signIn) return;
  const link = target.ownerDocument.createElement("a");
  link.href = "/";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Sign in";
  target.append(" ", link);
}

export interface ReaderToast {
  element: HTMLElement;
  /** Shows `text` (with a Sign in link when `signIn`) for TOAST_MS, replacing any message shown. */
  show(text: string, signIn?: boolean): void;
  hide(): void;
}

export function createReaderToast(doc: Document): ReaderToast {
  const element = doc.createElement("div");
  element.className = "reader-toast";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.hidden = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Only hidden, never emptied: a tap on the Sign in link dismisses the toast too, and a link
  // taken out of the page would not open.
  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
    element.hidden = true;
  }

  element.addEventListener("click", hide);
  return {
    element,
    show(text, signIn = false) {
      clearTimeout(timer);
      writeMessage(element, text, signIn);
      element.hidden = false;
      timer = setTimeout(hide, TOAST_MS);
    },
    hide,
  };
}
