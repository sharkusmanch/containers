import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GameRef } from "../shared/types.js";

/** The sources whose last game is remembered here; RetroAchievements reports its own. */
export type LastPlayedSource = "steam" | "xbox";

export interface LastPlayed {
  game: GameRef;
  at: number;
}

/** A time-only change (the same game, played later) is written at most this often per source. */
const MIN_WRITE_GAP_MS = 60_000;
const SOURCES: readonly LastPlayedSource[] = ["steam", "xbox"];
/** A Steam app id or an Xbox title id, as the detector reports them. */
const GAME_ID = /^\d{1,10}$/;
/** Later than any real time (year 2100): a bigger one is not a time at all. */
const MAX_AT = Date.UTC(2100, 0, 1);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function parseEntry(source: LastPlayedSource, v: unknown): LastPlayed | null {
  if (!isRec(v) || !isRec(v.game)) return null;
  const { source: gameSource, id, title } = v.game;
  if (gameSource !== source || typeof id !== "string" || !GAME_ID.test(id)) return null;
  if (typeof title !== "string") return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0 || v.at > MAX_AT) return null;
  return { game: { source, id, title }, at: v.at };
}

const sameGame = (a: GameRef, b: GameRef): boolean => a.id === b.id && a.title === b.title;
const copy = (o: LastPlayed): LastPlayed => ({ game: { ...o.game }, at: o.at });

/**
 * The last Steam and Xbox game seen, with when, kept in one small JSON file so a restart does not
 * forget them: `{"steam": {game, at}, "xbox": {game, at}}`. The file is replaced atomically (temp
 * file + rename), one write at a time: at once when a source's game changes, at most once a
 * minute per source when only its time moves on (`close` writes what that held back).
 */
export class LastPlayedStore {
  private readonly file: string;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly slots: Record<LastPlayedSource, LastPlayed | null> = { steam: null, xbox: null };
  /** When each source last asked for a write. */
  private readonly writtenAt: Record<LastPlayedSource, number> = {
    steam: -Infinity,
    xbox: -Infinity,
  };
  /** A change is held back by the once-a-minute rule and not written yet. */
  private dirty = false;
  /** False when the file exists but could not be read: it is then never overwritten. */
  private writable = true;
  /** Writes run one at a time; each saves both sources as they are when it runs. */
  private writes: Promise<void> = Promise.resolve();
  private tempSeq = 0;

  constructor(opts: { file: string; log?: (msg: string) => void; now?: () => number }) {
    this.file = opts.file;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Removes temp files a crashed write left behind, then reads the file. A missing or unparsable file starts empty and is replaced on the next write;
   * one that exists but cannot be read (EACCES, EIO, ...) starts empty and is never written. An
   * entry of the wrong shape is dropped. Never rejects.
   */
  async load(): Promise<void> {
    await this.removeStaleTemps();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.writable = false;
        this.log("last-played file unreadable; not saving");
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isRec(parsed)) {
      this.log("last-played file unreadable; starting empty");
      return;
    }
    for (const source of SOURCES) this.slots[source] = parseEntry(source, parsed[source]);
  }

  get(source: LastPlayedSource): LastPlayed | null {
    const slot = this.slots[source];
    return slot ? copy(slot) : null;
  }

  /** Remembers the source's last game at once; the file follows by the rules above. */
  record(source: LastPlayedSource, seen: LastPlayed): void {
    const prev = this.slots[source];
    if (prev && sameGame(prev.game, seen.game) && prev.at === seen.at) return;
    this.slots[source] = copy(seen);
    const now = this.now();
    if (prev && sameGame(prev.game, seen.game) && now - this.writtenAt[source] < MIN_WRITE_GAP_MS) {
      this.dirty = true;
      return;
    }
    this.writtenAt[source] = now;
    this.save();
  }

  /** Settles when the writes queued so far are done. */
  settled(): Promise<void> {
    return this.writes;
  }

  /** Writes a change the once-a-minute rule held back, then waits for the writes under way. */
  async close(): Promise<void> {
    if (this.dirty) this.save();
    await this.writes;
  }

  /** Queues a write of both sources; a failure is logged and they stay in memory. */
  private save(): void {
    if (!this.writable) return;
    this.dirty = false;
    this.writes = this.writes
      .then(() => this.write())
      .catch(() => {
        // Not saved after all: `close` tries again.
        this.dirty = true;
        this.log("last-played write failed");
      });
  }

  /** Deletes `<file>.*.tmp` beside the file; anything else in the directory stays. */
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

  private async write(): Promise<void> {
    const dir = dirname(this.file);
    const temp = join(dir, `${basename(this.file)}.${process.pid}.${++this.tempSeq}.tmp`);
    const body: Partial<Record<LastPlayedSource, LastPlayed>> = {};
    for (const source of SOURCES) {
      const slot = this.slots[source];
      if (slot) body[source] = slot;
    }
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`);
      await rename(temp, this.file);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
