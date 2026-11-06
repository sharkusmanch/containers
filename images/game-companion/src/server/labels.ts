import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GuidePage } from "../shared/types.js";
import { cleanLabel, isKnownName, knownLabel } from "../web/labels.js";
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
/** How long a title waits after a failed request, or after an answer with no usable label. */
const BACKOFF_MS = 3_600_000;
/** Answers without a usable label after which a title is never sent again. */
const TRIES_MAX = 2;

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

/** A generated label the rail may show: valid, and not one of the common mapping's names. */
function usable(value: unknown): string | null {
  const label = cleanLabel(value);
  return label === null || isKnownName(label) ? null : label;
}

/**
 * Short rail labels for guide pages. A standard page gets the common mapping's name; any other
 * title gets the label the agent (Claude Haiku) generated for it once, cached by exact title in a
 * JSON file that is replaced atomically (temp file + rename). Titles with neither are asked for in
 * the background: debounced, in batches of at most 40, one request at a time.
 *
 * An answer without a usable label for a title counts a try, kept in the file; after two the
 * title is never sent again and keeps the fallback name. A failed request (network, 5xx, 404,
 * timeout) only backs its titles off for an hour, in memory; a busy agent is waited out. Without
 * an agent there are no labels beyond the mapping. Logs counts only, never a title or label.
 *
 * File shape: `{"labels": {title: label}, "unlabelled": {title: tries}}`; the older flat
 * `{title: label}` is read too.
 */
export class LabelService {
  private readonly file: string;
  private readonly agent: LabelAgent | null;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly cache = new Map<string, string>();
  /** Title → answers without a usable label so far. */
  private readonly tries = new Map<string, number>();
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
  private closed = false;
  /** False when the file exists but could not be read: it is then never overwritten. */
  private writable = true;
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
   * Removes temp files a crashed write left behind, then reads the cache file. A missing or
   * unparsable file starts empty and is replaced on the next save; a file that exists but cannot
   * be read (EACCES, EIO, ...) starts empty and is never written. Entries that are not usable
   * labels are dropped. Never rejects. Without an agent nothing is read or removed.
   */
  async load(): Promise<void> {
    if (this.agent === null) return;
    await this.removeStaleTemps();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.writable = false;
        this.log("label cache unreadable; not saving");
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) {
      this.log("label cache unreadable; starting empty");
      return;
    }
    // The current shape has a `labels` object; the older one is a flat map of strings.
    const labels = isRecord(parsed.labels) ? parsed.labels : parsed;
    for (const [title, value] of Object.entries(labels)) {
      const label = usable(value);
      if (label !== null) this.cache.set(title, label);
    }
    if (labels !== parsed && isRecord(parsed.unlabelled)) {
      for (const [title, n] of Object.entries(parsed.unlabelled)) {
        if (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && !this.cache.has(title)) {
          this.tries.set(title, n);
        }
      }
    }
  }

  /**
   * Copies of one guide's pages, each with a `label` when one is known; titles with none are
   * queued for the agent. A generated label already shown on an earlier page of the same tree is
   * left off (the page falls back). Never waits for the agent.
   */
  annotate(pages: GuidePage[]): GuidePage[] {
    return this.annotateWith(pages, new Set());
  }

  /** Whether any of these pages' titles is queued for the agent or being asked about now. */
  labelsPending(pages: GuidePage[]): boolean {
    return pages.some(
      (p) => this.queue.has(p.title) || this.asking.has(p.title) || this.labelsPending(p.children),
    );
  }

  /** Settles when the background work started so far (requests and writes) is done. */
  async settled(): Promise<void> {
    await this.work;
    await this.writes;
  }

  /** Stops asking: cancels a waiting request, then waits for the work under way. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.settled();
  }

  private annotateWith(pages: GuidePage[], used: Set<string>): GuidePage[] {
    return pages.map((page) => {
      // The page before its children, so titles queue in reading order.
      const label = this.labelFor(page.title, used);
      const children = this.annotateWith(page.children, used);
      return label === null ? { ...page, children } : { ...page, label, children };
    });
  }

  private labelFor(title: string, used: Set<string>): string | null {
    const known = knownLabel(title);
    if (known !== null) return known;
    if (this.agent === null) return null;
    const cached = this.cache.get(title);
    if (cached === undefined) {
      this.enqueue(title);
      return null;
    }
    const key = cached.toLocaleLowerCase();
    if (used.has(key)) return null;
    used.add(key);
    return cached;
  }

  private enqueue(title: string): void {
    if (this.closed || this.queue.has(title) || this.asking.has(title)) return;
    if (sendable(title) === null || (this.tries.get(title) ?? 0) >= TRIES_MAX) return;
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
    if (this.running || this.closed) return;
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
      while (this.queue.size > 0 && !this.closed) {
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
          const label = Object.hasOwn(result.labels, key) ? usable(result.labels[key]) : null;
          if (label === null) {
            missing.push(title);
            this.tries.set(title, (this.tries.get(title) ?? 0) + 1);
          } else {
            this.cache.set(title, label);
            this.tries.delete(title);
            added += 1;
          }
        }
        // A title with a try left waits an hour before it.
        this.backOff(missing.filter((t) => (this.tries.get(t) ?? 0) < TRIES_MAX));
        this.log("labels added", { titles: batch.length, labels: added });
        this.save();
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
    if (!this.writable) return;
    this.writes = this.writes
      .then(() => this.write())
      .catch(() => this.log("label cache write failed"));
  }

  private async write(): Promise<void> {
    const dir = dirname(this.file);
    const temp = join(dir, `${basename(this.file)}.${process.pid}.${++this.tempSeq}.tmp`);
    const body = {
      labels: Object.fromEntries(this.cache),
      unlabelled: Object.fromEntries(this.tries),
    };
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`);
      await rename(temp, this.file);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Deletes `<file>.*.tmp` beside the cache file; anything else in the directory stays. */
  private async removeStaleTemps(): Promise<void> {
    const dir = dirname(this.file);
    const prefix = `${basename(this.file)}.`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        await rm(join(dir, name), { force: true }).catch(() => undefined);
      }
    }
  }
}
