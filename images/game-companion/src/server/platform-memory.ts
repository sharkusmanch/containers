import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Source } from "../shared/types.js";

export interface PlatformRecord {
  /** The platform the hub's game was last detected on. */
  last: Source;
  /** The Xbox title found for the hub, by its row or by name; null when never seen on Xbox. */
  xboxTitleId: string | null;
  /** When this record last changed, ISO. */
  seenAt: string;
}

const SOURCES: readonly Source[] = ["steam", "ra", "xbox"];
const TITLE_ID = /^\d{1,10}$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function parseRecord(v: unknown): PlatformRecord | null {
  if (!isRec(v)) return null;
  const last = SOURCES.find((s) => s === v.last);
  const xboxTitleId =
    v.xboxTitleId === null ? null : typeof v.xboxTitleId === "string" ? v.xboxTitleId : undefined;
  if (last === undefined || xboxTitleId === undefined) return null;
  if (xboxTitleId !== null && !TITLE_ID.test(xboxTitleId)) return null;
  if (typeof v.seenAt !== "string") return null;
  return { last, xboxTitleId, seenAt: v.seenAt };
}

/**
 * Which platform each guide hub's game was last detected on, with the Xbox title ID found for it,
 * so a guide opened by hand shows the right platform. One small JSON file, replaced atomically
 * (temp file + rename) and only when a record changes.
 */
export class PlatformMemory {
  private readonly file: string;
  private readonly now: () => number;
  private readonly records = new Map<string, PlatformRecord>();
  /** Writes run one at a time; each saves every record as it is when it runs. */
  private writes: Promise<void> = Promise.resolve();
  private tempSeq = 0;

  constructor(opts: { file: string; now?: () => number }) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
  }

  /** A missing file means nothing is remembered yet. Rejects, keeping nothing, on a broken one. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("platform memory file is unreadable", { cause: err });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("platform memory file is not valid JSON");
    }
    if (!isRec(parsed)) throw new Error("platform memory file is not valid JSON");
    this.records.clear();
    for (const [hubId, value] of Object.entries(parsed)) {
      const record = parseRecord(value);
      if (record) this.records.set(hubId, record);
    }
  }

  get(hubId: string): PlatformRecord | null {
    const record = this.records.get(hubId);
    return record ? { ...record } : null;
  }

  /**
   * Remembers that the hub's game was detected on `source`. Without `xboxTitleId` a known one is
   * kept. Takes effect at once; the promise settles when the file is written (at once, with no
   * write, when nothing changed).
   */
  record(hubId: string, source: Source, xboxTitleId?: string): Promise<void> {
    const prev = this.records.get(hubId);
    const nextXbox = xboxTitleId ?? prev?.xboxTitleId ?? null;
    if (prev && prev.last === source && prev.xboxTitleId === nextXbox) return Promise.resolve();
    this.records.set(hubId, {
      last: source,
      xboxTitleId: nextXbox,
      seenAt: new Date(this.now()).toISOString(),
    });
    const write = this.writes.then(() => this.save());
    this.writes = write.catch(() => undefined);
    return write;
  }

  byXboxTitle(titleId: string): string[] {
    return [...this.records]
      .filter(([, record]) => record.xboxTitleId === titleId)
      .map(([hubId]) => hubId);
  }

  private async save(): Promise<void> {
    const dir = dirname(this.file);
    const temp = join(dir, `${basename(this.file)}.${process.pid}.${++this.tempSeq}.tmp`);
    const body = `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`;
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
