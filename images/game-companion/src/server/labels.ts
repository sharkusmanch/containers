import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GuidePage } from "../shared/types.js";
import { cleanLabel, knownLabel } from "../web/labels.js";
import type { LabelResult } from "./agent-client.js";

export type { LabelResult } from "./agent-client.js";

/** The agent's label endpoint, as the service uses it. */
export interface LabelAgent {
  label(titles: string[]): Promise<LabelResult>;
}

/** The most titles the agent takes in one request, and the longest one (code points). */
const BATCH_MAX = 40;
const TITLE_MAX = 200;
/** Titles seen within this long of each other go to the agent together. */
const DEBOUNCE_MS = 2000;
/** How long a title waits after a failed request, or an answer with no label for it. */
const BACKOFF_MS = 3_600_000;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The title as the agent would take it, or null when it would refuse it. */
function sendable(title: string): string | null {
  const t = title.trim();
  const n = Array.from(t).length;
  return n >= 1 && n <= TITLE_MAX && !t.includes("\u0000") ? t : null;
}

/**
 * Short rail labels for guide pages. A standard page gets the common mapping's name; any other
 * title gets the label the agent (Claude Haiku) generated for it once, cached by exact title in a
 * JSON file that is replaced atomically (temp file + rename). Titles with neither are asked for in
 * the background: debounced, in batches of at most 40, one request at a time. A failure backs a
 * title off for an hour (in memory); a busy agent is waited out. Without an agent there are no
 * labels beyond the mapping. Logs counts only, never a title or label.
 */
export class LabelService {
  private readonly file: string;
  private readonly agent: LabelAgent | null;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly cache = new Map<string, string>();
  /** Titles waiting for the next request, in the order they were seen. */
  private queue = new Set<string>();
  /** Titles in the request under way. */
  private readonly asking = new Set<string>();
  /** Title → when it may be asked for again. */
  private readonly backoff = new Map<string, number>();
  /** No request starts before this time (a busy agent's Retry-After). */
  private pausedUntil = 0;
  private cancelTimer: (() => void) | null = null;
  private running = false;
  private work: Promise<void> = Promise.resolve();
  /** Writes run one at a time; each saves the whole cache as it is when it runs. */
  private writes: Promise<void> = Promise.resolve();
  private tempSeq = 0;

  constructor(opts: {
    file: string;
    /** Null when no agent is configured. */
    agent: LabelAgent | null;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => () => void;
  }) {
    this.file = opts.file;
    this.agent = opts.agent;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? defaultTimer;
  }

  /**
   * Reads the cache file. A missing file means nothing is cached yet; an unreadable or broken one
   * is logged and ignored, and entries that are not valid labels are dropped. Never rejects.
   * Without an agent the file is not read.
   */
  async load(): Promise<void> {
    if (this.agent === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log("label cache unreadable; starting empty");
      }
      return;
    }
    if (!isRecord(parsed)) {
      this.log("label cache unreadable; starting empty");
      return;
    }
    for (const [title, value] of Object.entries(parsed)) {
      const label = cleanLabel(value);
      if (label !== null) this.cache.set(title, label);
    }
  }

  /**
   * Copies of the pages, each with a `label` when one is known; titles with none are queued for
   * the agent. Never waits for the agent.
   */
  annotate(pages: GuidePage[]): GuidePage[] {
    return pages.map((page) => {
      // The page before its children, so titles queue in reading order.
      const label = this.labelFor(page.title);
      const children = this.annotate(page.children);
      return label === null ? { ...page, children } : { ...page, label, children };
    });
  }

  /** Settles when the background work started so far (requests and writes) is done. */
  async settled(): Promise<void> {
    await this.work;
    await this.writes;
  }

  private labelFor(title: string): string | null {
    const known = knownLabel(title);
    if (known !== null) return known;
    if (this.agent === null) return null;
    const cached = this.cache.get(title);
    if (cached !== undefined) return cached;
    this.enqueue(title);
    return null;
  }

  private enqueue(title: string): void {
    if (this.queue.has(title) || this.asking.has(title) || sendable(title) === null) return;
    const until = this.backoff.get(title);
    if (until !== undefined) {
      if (until > this.now()) return;
      this.backoff.delete(title);
    }
    this.queue.add(title);
    this.schedule();
  }

  /** (Re)starts the debounce, unless a request is under way: its loop takes the new titles. */
  private schedule(): void {
    if (this.running) return;
    this.cancelTimer?.();
    const delay = Math.max(DEBOUNCE_MS, this.pausedUntil - this.now());
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      this.work = this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    const agent = this.agent;
    if (agent === null) return;
    this.running = true;
    try {
      while (this.queue.size > 0) {
        const batch = [...this.queue].slice(0, BATCH_MAX);
        for (const title of batch) {
          this.queue.delete(title);
          this.asking.add(title);
        }
        // Titles go out trimmed (as the agent keys its answer); the cache keeps the exact title.
        const sent = [...new Set(batch.map((t) => sendable(t) ?? t))];
        const result = await agent.label(sent).catch((): LabelResult => ({ kind: "failed" }));
        this.asking.clear();
        if (result.kind === "busy") {
          // The same titles go first once the agent's wait is over.
          this.queue = new Set([...batch, ...this.queue]);
          this.pausedUntil = this.now() + result.retryAfterMs;
          this.log("labels busy", { titles: batch.length, retryAfterMs: result.retryAfterMs });
          break;
        }
        if (result.kind === "failed") {
          this.backOff(batch);
          this.log("labels failed", { titles: batch.length });
          continue;
        }
        let added = 0;
        const missing: string[] = [];
        for (const title of batch) {
          const key = sendable(title) ?? title;
          const label = Object.hasOwn(result.labels, key) ? cleanLabel(result.labels[key]) : null;
          if (label === null) {
            missing.push(title);
          } else {
            this.cache.set(title, label);
            added += 1;
          }
        }
        this.backOff(missing);
        this.log("labels added", { titles: batch.length, labels: added });
        if (added > 0) this.save();
      }
    } finally {
      this.running = false;
    }
    if (this.queue.size > 0) this.schedule();
  }

  private backOff(titles: string[]): void {
    const until = this.now() + BACKOFF_MS;
    for (const title of titles) this.backoff.set(title, until);
  }

  /** Queues a write of the whole cache; a failure is logged and the labels stay in memory. */
  private save(): void {
    this.writes = this.writes
      .then(() => this.write())
      .catch(() => this.log("label cache write failed"));
  }

  private async write(): Promise<void> {
    const dir = dirname(this.file);
    const temp = join(dir, `${basename(this.file)}.${process.pid}.${++this.tempSeq}.tmp`);
    const body = `${JSON.stringify(Object.fromEntries(this.cache), null, 2)}\n`;
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(temp, body);
      await rename(temp, this.file);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
