import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformMemory } from "../src/server/platform-memory.js";

// The real rename and writeFile, with seams so tests can count writes or make a rename fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
const fsp = await import("node:fs/promises");

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platform-memory-"));
  file = join(dir, "platforms.json");
  vi.mocked(fsp.rename).mockClear();
  vi.mocked(fsp.writeFile).mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function memory(clock = { t: T0 }): PlatformMemory {
  return new PlatformMemory({ file, now: () => clock.t });
}

describe("PlatformMemory", () => {
  it("record + get round-trip, in memory and through the file", async () => {
    const m = memory();
    await m.load();
    expect(m.get("hub-a")).toBeNull();
    await m.record("hub-a", "xbox", "1000000001");
    await m.record("hub-b", "steam");
    const expected = {
      last: "xbox",
      xboxTitleId: "1000000001",
      seenAt: new Date(T0).toISOString(),
    };
    expect(m.get("hub-a")).toEqual(expected);
    expect(m.get("hub-b")).toEqual({
      last: "steam",
      xboxTitleId: null,
      seenAt: new Date(T0).toISOString(),
    });

    const reloaded = memory();
    await reloaded.load();
    expect(reloaded.get("hub-a")).toEqual(expected);
    expect(reloaded.get("hub-b")?.last).toBe("steam");
  });

  it("keeps a known Xbox title ID when Steam is detected later", async () => {
    const m = memory();
    await m.load();
    await m.record("hub-a", "xbox", "1000000001");
    await m.record("hub-a", "steam");
    expect(m.get("hub-a")).toMatchObject({ last: "steam", xboxTitleId: "1000000001" });
  });

  it("starts empty without a file, and rejects an unreadable one without keeping any of it", async () => {
    const m = memory();
    await expect(m.load()).resolves.toBeUndefined();
    expect(m.byXboxTitle("1")).toEqual([]);

    await writeFile(file, "{not json");
    const broken = memory();
    await expect(broken.load()).rejects.toThrow("platform memory file is not valid JSON");
    expect(broken.get("hub-a")).toBeNull();
  });

  it("skips malformed records in the file", async () => {
    await writeFile(
      file,
      JSON.stringify({
        good: { last: "steam", xboxTitleId: "42", seenAt: "2026-10-18T00:00:00.000Z" },
        badSource: { last: "psn", xboxTitleId: null, seenAt: "2026-10-18T00:00:00.000Z" },
        badId: { last: "xbox", xboxTitleId: "../x", seenAt: "2026-10-18T00:00:00.000Z" },
        notObject: 3,
      }),
    );
    const m = memory();
    await m.load();
    expect(m.get("good")?.xboxTitleId).toBe("42");
    expect(m.get("badSource")).toBeNull();
    expect(m.get("badId")).toBeNull();
    expect(m.get("notObject")).toBeNull();
  });

  it("atomic write: a temp file renamed over the target, and a failed rename leaves the old file", async () => {
    const m = memory();
    await m.load();
    await m.record("hub-a", "steam");
    const rename = vi.mocked(fsp.rename);
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(to).toBe(file);
    expect(from).not.toBe(file);
    expect(from.startsWith(join(dir, "platforms.json."))).toBe(true);
    expect(await readdir(dir)).toEqual(["platforms.json"]);
    const before = await readFile(file, "utf8");
    expect(JSON.parse(before)).toEqual({ "hub-a": m.get("hub-a") });
    expect((await stat(file)).isFile()).toBe(true);

    rename.mockRejectedValueOnce(new Error("disk full"));
    await expect(m.record("hub-a", "xbox", "77")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["platforms.json"]);
    // The memory still knows it; the next change writes everything.
    expect(m.get("hub-a")?.last).toBe("xbox");
    await m.record("hub-b", "steam");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object).sort()).toEqual([
      "hub-a",
      "hub-b",
    ]);
  });

  it("no write when unchanged, even as time passes", async () => {
    const clock = { t: T0 };
    const m = memory(clock);
    await m.load();
    await m.record("hub-a", "xbox", "1000000001");
    const writes = vi.mocked(fsp.writeFile).mock.calls.length;
    clock.t += 60_000;
    await m.record("hub-a", "xbox", "1000000001");
    await m.record("hub-a", "xbox");
    expect(vi.mocked(fsp.writeFile).mock.calls.length).toBe(writes);
    expect(m.get("hub-a")?.seenAt).toBe(new Date(T0).toISOString());

    await m.record("hub-a", "steam");
    expect(vi.mocked(fsp.writeFile).mock.calls.length).toBe(writes + 1);
    expect(m.get("hub-a")?.seenAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("serialises overlapping writes so the file ends with the newest state", async () => {
    const m = memory();
    await m.load();
    await Promise.all([
      m.record("hub-a", "steam"),
      m.record("hub-b", "xbox", "5"),
      m.record("hub-a", "xbox", "6"),
    ]);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, { last: string }>;
    expect(saved["hub-a"]?.last).toBe("xbox");
    expect(saved["hub-b"]?.last).toBe("xbox");
  });

  it("byXboxTitle", async () => {
    const m = memory();
    await m.load();
    await m.record("hub-a", "xbox", "1000000001");
    await m.record("hub-b", "xbox", "1000000002");
    await m.record("hub-c", "xbox", "1000000001");
    await m.record("hub-d", "steam");
    expect(m.byXboxTitle("1000000001").sort()).toEqual(["hub-a", "hub-c"]);
    expect(m.byXboxTitle("1000000002")).toEqual(["hub-b"]);
    expect(m.byXboxTitle("9")).toEqual([]);
  });
});
