import type { AskEvent, AskHistoryEntry, AskRequest, Source } from "../shared/types.js";
import { ApiError, type Api } from "./api.js";
import type { StorageLike } from "./state.js";

export const ASK_STORAGE_PREFIX = "game-companion:v1:ask:";
export const QUESTION_MAX = 1000;
const COUNTER_FROM = 900;
const HISTORY_MAX = 10;
/** The most of an earlier answer the server accepts, in characters. */
const HISTORY_ANSWER_MAX = 8000;
/**
 * The most a request may take as JSON, in UTF-8 bytes: under the server's 32,768-byte limit,
 * with room to spare. The oldest history is left out of a request that would pass it.
 */
const REQUEST_BYTES_MAX = 30000;
export const STARTERS = [
  "What should I do next?",
  "Anything missable around here?",
  "Where do I go now?",
] as const;
export const FULL_ANSWER_QUESTION = "Give me the full answer.";
const PICK_A_GAME = "Pick a game first";
const UNAVAILABLE = "The assistant is unavailable right now.";
const STOPPED = "(stopped)";
/** Within this many pixels of the bottom, the conversation follows a growing answer. */
const FOLLOW_SLACK_PX = 48;

type AskTarget = Pick<AskRequest, "hubId" | "game">;

export interface AssistantView {
  element: HTMLElement;
  /** Switches conversation storage scope; null disables input ("Pick a game first"). */
  setScope(
    scope: string | null,
    request: { hubId: string | null; game: { source: Source; id: string } | null } | null,
  ): void;
  /** Sends `text` as a normal turn; false when it cannot be sent now (blank, streaming, no game). */
  ask(text: string, depth: AskRequest["depth"]): boolean;
  /** The depth typed questions and starters are sent at ("hint" until set); Full answer stays "full". */
  setDefaultDepth(depth: Exclude<AskRequest["depth"], "full">): void;
}

const blank = (s: string): boolean => s.trim() === "";

/** The stored conversation of a scope; anything malformed or blank is left out. */
export function loadHistory(storage: StorageLike, scope: string): AskHistoryEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(ASK_STORAGE_PREFIX + scope) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is AskHistoryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as AskHistoryEntry).question === "string" &&
        typeof (e as AskHistoryEntry).answer === "string" &&
        !blank((e as AskHistoryEntry).question) &&
        !blank((e as AskHistoryEntry).answer),
    )
    .map(({ question, answer }) => ({ question, answer }))
    .slice(-HISTORY_MAX);
}

function saveHistory(storage: StorageLike, scope: string, history: AskHistoryEntry[]): void {
  try {
    storage.setItem(ASK_STORAGE_PREFIX + scope, JSON.stringify(history));
  } catch {
    // Storage may be blocked or full; the conversation just will not survive a reload.
  }
}

/** The words shown for a request that failed before or while streaming. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return err.limit === "day"
        ? "Daily question limit reached. Try again after midnight."
        : `Too many questions. Try again in ${err.retryAfter ?? 60} seconds.`;
    }
    if (err.status === 503) return "The assistant isn't set up.";
    if (err.status === 413) return "This chat is too long. Start a New chat.";
  }
  return UNAVAILABLE;
}

/** Whether a request failed because the sign-in has lapsed (the server's 401). */
const signedOut = (thrown: { err: unknown } | null): boolean =>
  thrown !== null && thrown.err instanceof ApiError && thrown.err.status === 401;

/** Plain text as paragraphs (split by blank lines) and bullet lists (lines starting "- "). */
function answerNodes(doc: Document, text: string): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    let paragraph: string[] = [];
    let list: HTMLElement | null = null;
    const flush = (): void => {
      if (paragraph.length === 0) return;
      const p = doc.createElement("p");
      p.textContent = paragraph.join("\n");
      nodes.push(p);
      paragraph = [];
    };
    for (const line of block.split("\n")) {
      if (line.startsWith("- ")) {
        flush();
        if (list === null) {
          list = doc.createElement("ul");
          nodes.push(list);
        }
        const item = doc.createElement("li");
        item.textContent = line.slice(2);
        list.append(item);
      } else if (!blank(line)) {
        list = null;
        paragraph.push(line);
      }
    }
    flush();
  }
  return nodes;
}

/** Cuts text to `max` characters (code points), never splitting a surrogate pair. */
const cut = (text: string, max: number): string => [...text].slice(0, max).join("");

const requestBytes = (req: AskRequest): number =>
  new TextEncoder().encode(JSON.stringify(req)).length;

export function createAssistantView(
  doc: Document,
  opts: {
    api: Pick<Api, "ask">;
    storage: StorageLike;
    /** Called whenever an answer starts or stops streaming. */
    onBusyChange?: (busy: boolean) => void;
  },
): AssistantView {
  const { api, storage } = opts;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text = "",
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    e.classList.add(className);
    e.textContent = text;
    return e;
  };
  const buttonEl = (className: string, text: string): HTMLButtonElement => {
    const b = el("button", className, text);
    b.setAttribute("type", "button");
    return b;
  };

  const element = el("section", "ask");
  const log = el("div", "ask-log");
  log.setAttribute("aria-live", "polite");
  const notice = el("p", "ask-notice", PICK_A_GAME);

  // What typed questions and starters are sent at; main sets it from the Ask answers setting.
  let defaultDepth: Exclude<AskRequest["depth"], "full"> = "hint";
  const starterRow = el("div", "ask-starters");
  const starters = STARTERS.map((text) => {
    const b = buttonEl("ask-starter", text);
    b.addEventListener("click", () => send(text, defaultDepth));
    return b;
  });
  starterRow.append(...starters);

  const input = el("textarea", "ask-input");
  input.maxLength = QUESTION_MAX;
  input.rows = 2;
  input.setAttribute("aria-label", "Your question");
  input.setAttribute("enterkeyhint", "send");
  const counter = el("span", "ask-counter");
  counter.hidden = true;
  const sendButton = buttonEl("ask-send", "Send");
  const stopButton = buttonEl("ask-stop", "Stop");
  stopButton.hidden = true;
  const newChat = buttonEl("ask-new", "New chat");
  const inputRow = el("div", "ask-input-row");
  inputRow.append(input, counter, sendButton, stopButton, newChat);

  const fullButton = buttonEl("ask-full", "Full answer");
  fullButton.addEventListener("click", () => send(FULL_ANSWER_QUESTION, "full"));

  element.append(log, starterRow, inputRow);

  let scope: string | null = null;
  let target: AskTarget | null = null;
  let history: AskHistoryEntry[] = [];
  // Bumped whenever the conversation on screen is replaced, so a late answer only touches storage.
  let generation = 0;
  let streaming: AbortController | null = null;
  // The last turn on screen, when it is the newest stored answer and that answer was a hint.
  let fullFor: HTMLElement | null = null;
  let reportedBusy = false;

  const refreshControls = (): void => {
    const off = scope === null || streaming !== null;
    if ((streaming !== null) !== reportedBusy) {
      reportedBusy = streaming !== null;
      opts.onBusyChange?.(reportedBusy);
    }
    input.disabled = off;
    input.placeholder = scope === null ? PICK_A_GAME : "Ask about this game";
    for (const b of [...starters, sendButton, newChat]) b.disabled = off;
    sendButton.hidden = streaming !== null;
    stopButton.hidden = streaming === null;
    if (fullFor !== null && !off) fullFor.append(fullButton);
    else fullButton.remove();
  };

  const nearBottom = (): boolean =>
    log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PX;
  const toBottom = (): void => {
    log.scrollTop = log.scrollHeight;
  };

  const turnEl = (
    question: string,
  ): { turn: HTMLElement; searches: HTMLElement; body: HTMLElement; answer: HTMLElement } => {
    const turn = el("div", "ask-turn");
    const answer = el("div", "ask-answer");
    const searches = el("div", "ask-searches");
    const body = el("div", "ask-body");
    answer.append(searches, body);
    turn.append(el("p", "ask-question", question), answer);
    return { turn, searches, body, answer };
  };

  /** The newest stored entry offers a full answer unless it already is one. */
  const offersFull = (entry: AskHistoryEntry | undefined): boolean =>
    entry !== undefined && entry.question !== FULL_ANSWER_QUESTION;

  const showHistory = (): void => {
    fullFor = null;
    const turns = history.map((entry) => {
      const t = turnEl(entry.question);
      t.body.append(...answerNodes(doc, entry.answer));
      return t.turn;
    });
    log.replaceChildren(...(scope === null ? [notice] : turns));
    if (offersFull(history.at(-1))) fullFor = turns.at(-1) ?? null;
    refreshControls();
    toBottom();
  };

  /** Adds an entry to the conversation of `entryScope`, the one on screen or one switched away from. */
  const remember = (entryScope: string, mine: number, entry: AskHistoryEntry): void => {
    const onScreen = mine === generation;
    const base = onScreen ? history : loadHistory(storage, entryScope);
    const next = [...base, entry].slice(-HISTORY_MAX);
    saveHistory(storage, entryScope, next);
    if (onScreen) history = next;
  };

  /** Starts a question; false when there is nothing to send or it cannot be sent now. */
  function send(text: string, depth: AskRequest["depth"]): boolean {
    const question = text.trim();
    if (blank(question) || streaming !== null || scope === null || target === null) return false;
    const req: AskRequest = {
      ...target,
      history: history.map((h) => ({
        question: h.question,
        answer: cut(h.answer, HISTORY_ANSWER_MAX),
      })),
      question,
      depth,
    };
    // Left out of this request only: the conversation stays stored and on screen. With no
    // history left the request goes as it is, and the server decides.
    while (req.history.length > 0 && requestBytes(req) > REQUEST_BYTES_MAX) req.history.shift();
    const controller = new AbortController();
    streaming = controller;
    const mine = generation;
    const askedIn = scope;
    // Offered again if this turn ends with nothing kept, since the newest stored answer is unchanged.
    const fullBefore = fullFor;
    fullFor = null;
    const { turn, searches, body, answer } = turnEl(question);
    log.append(turn);
    toBottom();
    refreshControls();

    let received = "";
    let outcome: { error: string } | "done" | null = null;
    const onEvent = (e: AskEvent): void => {
      if (e.type === "ping") return;
      if (outcome !== null || controller.signal.aborted || mine !== generation) return;
      const follow = nearBottom();
      if (e.type === "text" && typeof e.text === "string") {
        received += e.text;
        body.replaceChildren(...answerNodes(doc, received));
      } else if (e.type === "search" && typeof e.query === "string") {
        searches.append(el("p", "ask-search", `Searched the web: ${e.query}`));
      } else if (e.type === "lookup" && typeof e.label === "string") {
        searches.append(el("p", "ask-search", e.label));
      } else if (e.type === "done") {
        outcome = "done";
      } else if (e.type === "error") {
        outcome = {
          error: typeof e.message === "string" && !blank(e.message) ? e.message : UNAVAILABLE,
        };
      }
      if (follow) toBottom();
    };

    // The words of the failure, or null for a complete answer.
    const failure = (thrown: { err: unknown } | null): string | null => {
      if (thrown !== null) return errorText(thrown.err);
      if (outcome === "done") return blank(received) ? UNAVAILABLE : null;
      return outcome?.error ?? UNAVAILABLE;
    };

    const finish = (thrown: { err: unknown } | null): void => {
      if (streaming === controller) streaming = null;
      const onScreen = mine === generation;
      const follow = onScreen && nearBottom();
      let kept: string | null = null;
      if (controller.signal.aborted) {
        // What arrived is kept with a note; when nothing arrived there is nothing to keep.
        const shown = blank(received) ? STOPPED : `${received} ${STOPPED}`;
        if (!blank(received)) kept = shown;
        if (onScreen) body.replaceChildren(...answerNodes(doc, shown));
      } else {
        const failed = failure(thrown);
        if (failed === null) kept = received;
        // A lapsed sign-in is told by the page's signed-out banner, not under the answer.
        else if (onScreen && !signedOut(thrown)) answer.append(el("p", "ask-error", failed));
      }
      if (kept !== null) remember(askedIn, mine, { question, answer: kept });
      if (!onScreen) return;
      if (kept === null) fullFor = fullBefore;
      else if (offersFull(history.at(-1))) fullFor = turn;
      refreshControls();
      if (follow) toBottom();
    };

    api.ask(req, controller.signal, onEvent).then(
      () => finish(null),
      (err: unknown) => finish({ err }),
    );
    return true;
  }

  const syncCounter = (): void => {
    const length = input.value.length;
    counter.hidden = length < COUNTER_FROM;
    counter.textContent = counter.hidden ? "" : `${length}/${QUESTION_MAX}`;
  };
  input.addEventListener("input", () => {
    if (input.value.length > QUESTION_MAX) {
      // A paste the browser let past maxlength; never split a surrogate pair.
      let end = QUESTION_MAX;
      const code = input.value.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      input.value = input.value.slice(0, end);
    }
    syncCounter();
  });

  const sendTyped = (): void => {
    if (!send(input.value, defaultDepth)) return;
    input.value = "";
    syncCounter();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    sendTyped();
  });
  sendButton.addEventListener("click", sendTyped);
  stopButton.addEventListener("click", () => streaming?.abort());
  newChat.addEventListener("click", () => {
    if (scope === null || streaming !== null) return;
    generation += 1;
    history = [];
    saveHistory(storage, scope, history);
    showHistory();
  });

  showHistory();

  return {
    element,
    ask: (text, depth) => send(cut(text.trim(), QUESTION_MAX), depth),
    setDefaultDepth(depth) {
      defaultDepth = depth;
    },
    setScope(next, request) {
      target = next === null ? null : request;
      if (next === scope) {
        refreshControls();
        return;
      }
      // The answer streaming for the previous game stops and is filed under that game.
      streaming?.abort();
      streaming = null;
      generation += 1;
      scope = next;
      history = next === null ? [] : loadHistory(storage, next);
      showHistory();
    },
  };
}
