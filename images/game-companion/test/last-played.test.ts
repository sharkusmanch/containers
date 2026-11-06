import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastPlayedStore } from "../src/server/last-played.js";

// The real fs calls, with seams so a test can count writes or make a read or rename fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  };
});
const fsp = await import("node:fs/promises");

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60_000;

const steamGame = { source: "steam" as const, id: "1000001", title: "Test Game" };
const xboxGame = { source: "xbox" as const, id: "2000000002", title: "Test Quest: Moon Edition" };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "last-played-"));
  file = join(dir, "last-played.json");
  vi.mocked(fsp.rename).mockClear();
  vi.mocked(fsp.writeFile).mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(clock = { t: T0 }) {
  const log = vi.fn();
  return { s: new LastPlayedStore({ file, log, now: () => clock.t }), log, clock };
}

const writes = (): number => vi.mocked(fsp.writeFile).mock.calls.length;

describe("LastPlayedStore", () => {
  it("starts empty without a file, and a new store reads back what was recorded", async () => {
    const { s, log } = store();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.get("steam")).toBeNull();
    expect(s.get("xbox")).toBeNull();
    s.record("steam", { game: steamGame, at: T0 - 5 * MIN });
    s.record("xbox", { game: xboxGame, at: T0 - MIN });
    expect(s.get("steam")).toEqual({ game: steamGame, at: T0 - 5 * MIN });
    await s.settled();
    expect(log).not.toHaveBeenCalled();

    const again = store().s;
    await again.load();
    expect(again.get("steam")).toEqual({ game: steamGame, at: T0 - 5 * MIN });
    expect(again.get("xbox")).toEqual({ game: xboxGame, at: T0 - MIN });
  });

  it("returns copies, so a caller cannot change what is remembered", async () => {
    const { s } = store();
    await s.load();
    s.record("steam", { game: steamGame, at: T0 });
    const got = s.get("steam");
    if (got) got.game.title = "Changed";
    expect(s.get("steam")?.game.title).toBe("Test Game");
    await s.settled();
  });

  it("writes at once when the game changes, and a time-only change at most once a minute", async () => {
    const { s, clock } = store();
    await s.load();
    s.record("steam", { game: steamGame, at: T0 });
    await s.settled();
    expect(writes()).toBe(1);

    // The same reading again: nothing to write.
    s.record("steam", { game: steamGame, at: T0 });
    // Polls every 30 s while the game runs: only one write per minute.
    clock.t += 30_000;
    s.record("steam", { game: steamGame, at: clock.t });
    await s.settled();
    expect(writes()).toBe(1);
    clock.t += 30_000;
    s.record("steam", { game: steamGame, at: clock.t });
    await s.settled();
    expect(writes()).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      steam: { game: steamGame, at: T0 + MIN },
    });

    // Another game is written straight away, however soon.
    clock.t += 1_000;
    const other = { source: "steam" as const, id: "1000002", title: "Other Game" };
    s.record("steam", { game: other, at: clock.t });
    await s.settled();
    expect(writes()).toBe(3);

    // Each source has its own minute.
    s.record("xbox", { game: xboxGame, at: clock.t });
    clock.t += 1_000;
    s.record("xbox", { game: xboxGame, at: clock.t });
    await s.settled();
    expect(writes()).toBe(4);
  });

  it("close writes a time-only change the minute held back, and nothing when all is saved", async () => {
    const { s, clock } = store();
    await s.load();
    s.record("xbox", { game: xboxGame, at: T0 });
    clock.t += 30_000;
    s.record("xbox", { game: xboxGame, at: clock.t });
    await s.settled();
    expect(writes()).toBe(1);
    await s.close();
    expect(writes()).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      xbox: { at: T0 + 30_000 },
    });
    await s.close();
    expect(writes()).toBe(2);
  });

  it("atomic write: a temp file renamed over the target; a failed rename leaves the old file and is logged", async () => {
    const { s, clock, log } = store();
    await s.load();
    s.record("steam", { game: steamGame, at: T0 });
    await s.settled();
    const rename = vi.mocked(fsp.rename);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(to).toBe(file);
    expect(from.startsWith(join(dir, "last-played.json."))).toBe(true);
    expect(await readdir(dir)).toEqual(["last-played.json"]);
    const before = await readFile(file, "utf8");

    rename.mockRejectedValueOnce(new Error("disk full"));
    clock.t += MIN;
    s.record("xbox", { game: xboxGame, at: clock.t });
    await s.settled();
    expect(log).toHaveBeenCalledWith("last-played write failed");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["last-played.json"]);
    // Still known in memory; the next write saves it.
    expect(s.get("xbox")?.game).toEqual(xboxGame);
    clock.t += MIN;
    s.record("steam", { game: steamGame, at: clock.t });
    await s.settled();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ xbox: { game: xboxGame } });
  });

  it("serialises overlapping writes so the file ends with the newest state", async () => {
    const { s, clock } = store();
    await s.load();
    s.record("steam", { game: steamGame, at: T0 });
    s.record("xbox", { game: xboxGame, at: T0 });
    clock.t += MIN;
    const other = { source: "steam" as const, id: "1000002", title: "Other Game" };
    s.record("steam", { game: other, at: clock.t });
    await s.settled();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      steam: { game: other, at: T0 + MIN },
      xbox: { game: xboxGame, at: T0 },
    });
  });

  it.each([
    ["broken JSON", "{not json"],
    ["an array", "[1]"],
    ["null", "null"],
  ])(
    "starts empty, logs, and is replaced on the next write, with %s in the file",
    async (_n, body) => {
      await writeFile(file, body);
      const { s, log } = store();
      await expect(s.load()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith("last-played file unreadable; starting empty");
      expect(s.get("steam")).toBeNull();
      s.record("steam", { game: steamGame, at: T0 });
      await s.settled();
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        steam: { game: steamGame, at: T0 },
      });
    },
  );

  it("skips malformed entries in the file", async () => {
    await writeFile(
      file,
      JSON.stringify({
        steam: { game: { source: "xbox", id: "1000001", title: "Wrong source" }, at: T0 },
        xbox: { game: xboxGame, at: T0 },
      }),
    );
    const { s } = store();
    await s.load();
    expect(s.get("steam")).toBeNull();
    expect(s.get("xbox")).toEqual({ game: xboxGame, at: T0 });

    for (const bad of [
      { game: { source: "steam", id: "15564589419463376896", title: "Shortcut" }, at: T0 },
      { game: { source: "steam", id: "10", title: 3 }, at: T0 },
      { game: { source: "steam", id: "10", title: "x" }, at: "yesterday" },
      { game: { source: "steam", id: "10", title: "x" }, at: -1 },
      { game: { source: "steam", id: "10", title: "x" }, at: Number.MAX_VALUE },
      { game: "steam", at: T0 },
    ]) {
      await writeFile(file, JSON.stringify({ steam: bad }));
      const b = store().s;
      await b.load();
      expect(b.get("steam")).toBeNull();
    }
  });

  it("keeps working in memory but never writes when the file exists and cannot be read", async () => {
    await mkdir(file); // reading it fails with EISDIR, not ENOENT
    const { s, log } = store();
    await expect(s.load()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("last-played file unreadable; not saving");
    s.record("steam", { game: steamGame, at: T0 });
    expect(s.get("steam")).toEqual({ game: steamGame, at: T0 });
    await s.settled();
    await s.close();
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
  });

  it("removes stale temp files of its own on load, and nothing else", async () => {
    await writeFile(join(dir, "last-played.json.123.4.tmp"), "{");
    await writeFile(join(dir, "last-played.json.9.1.tmp"), "{");
    await writeFile(join(dir, "labels.json.1.1.tmp"), "{");
    await writeFile(join(dir, "platforms.json"), "{}");
    await writeFile(file, JSON.stringify({ xbox: { game: xboxGame, at: T0 } }));
    const { s } = store();
    await s.load();
    expect((await readdir(dir)).sort()).toEqual([
      "labels.json.1.1.tmp",
      "last-played.json",
      "platforms.json",
    ]);
    expect(s.get("xbox")).toEqual({ game: xboxGame, at: T0 });
  });

  it("does not overwrite a file that answers EACCES", async () => {
    await writeFile(file, JSON.stringify({ steam: { game: steamGame, at: T0 } }));
    vi.mocked(fsp.writeFile).mockClear();
    vi.mocked(fsp.readFile).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const { s, log } = store();
    await s.load();
    expect(log).toHaveBeenCalledWith("last-played file unreadable; not saving");
    s.record("xbox", { game: xboxGame, at: T0 });
    await s.settled();
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      steam: { game: steamGame, at: T0 },
    });
  });
});
