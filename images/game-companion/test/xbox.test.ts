import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/server/fetch-json.js";
import {
  normaliseXbox,
  XboxClient,
  XboxRateLimitError,
  type XboxAchievementList,
  type XboxTitleInfo,
} from "../src/server/xbox.js";
import { fixture } from "./helpers.js";

const XUID = "2535000000001";
const SESSION = {
  headers: { Authorization: "XBL3.0 x=fake-uhs;fake-xsts", "Accept-Language": "en-US" },
  xuid: XUID,
};

interface Call {
  url: string;
  headers: Record<string, string>;
}
type Answer = { status?: number; body?: string; headers?: Record<string, string> };

/** Answers by URL fragment; first match wins. */
function fakeXbox(routes: [string, Answer | (() => Answer)][]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string>) } });
    const hit = routes.find(([needle]) => u.includes(needle));
    if (!hit) return new Response("not routed", { status: 599 });
    const answer = typeof hit[1] === "function" ? hit[1]() : hit[1];
    return new Response(answer.body ?? "{}", {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function client(
  routes: [string, Answer | (() => Answer)][],
  opts: { session?: typeof SESSION | null; now?: () => number } = {},
) {
  const fake = fakeXbox(routes);
  const session = opts.session === undefined ? SESSION : opts.session;
  const xbox = new XboxClient({
    auth: { session: async () => session },
    fetch: fake.fetchFn,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { xbox, ...fake };
}

interface PresenceFixture {
  devices: { type: string; titles: Record<string, unknown>[] }[];
}
const presenceFixture = (): PresenceFixture =>
  JSON.parse(fixture("xbox-presence.json")) as PresenceFixture;

const presenceOk = { body: fixture("xbox-presence.json") };
const titlehubOk = { body: fixture("xbox-titlehub.json") };

describe("XboxClient.presence", () => {
  it("picks the Full title, ignores Background", async () => {
    const { xbox } = client([["userpresence", presenceOk]]);
    const p = await xbox.presence();
    expect(p?.title).toEqual({
      id: "2000000002",
      name: "Test Quest: Moon Edition",
      richPresence: "Exploring the Crater Level 4",
    });
  });

  it("maps device", async () => {
    const { xbox } = client([["userpresence", presenceOk]]);
    expect(await xbox.presence()).toMatchObject({ online: true, device: "WindowsOneCore" });
    const series = presenceFixture();
    series.devices[0]!.type = "Scarlett";
    const other = client([["userpresence", { body: JSON.stringify(series) }]]);
    expect((await other.xbox.presence())?.device).toBe("Scarlett");
  });

  it("Away is online: its Full title is the game being played", async () => {
    const body = { ...presenceFixture(), state: "Away" };
    const { xbox } = client([["userpresence", { body: JSON.stringify(body) }]]);
    expect(await xbox.presence()).toMatchObject({
      online: true,
      device: "WindowsOneCore",
      title: { id: "2000000002", name: "Test Quest: Moon Edition" },
    });
  });

  it("no state at all is offline", async () => {
    const body: Record<string, unknown> = { ...presenceFixture() };
    delete body.state;
    const { xbox } = client([["userpresence", { body: JSON.stringify(body) }]]);
    expect(await xbox.presence()).toEqual({ online: false, device: null, title: null });
  });

  it("offline → title null", async () => {
    const { xbox } = client([["userpresence", { body: fixture("xbox-presence-offline.json") }]]);
    expect(await xbox.presence()).toEqual({ online: false, device: null, title: null });
  });

  it("online with only a Background title → title null", async () => {
    const body = presenceFixture();
    body.devices[0]!.titles.pop();
    const { xbox } = client([["userpresence", { body: JSON.stringify(body) }]]);
    expect(await xbox.presence()).toEqual({ online: true, device: "WindowsOneCore", title: null });
  });

  it("takes the newest Full title when two devices report one", async () => {
    const body = presenceFixture();
    body.devices.push({
      type: "Scarlett",
      titles: [
        {
          id: "2000000009",
          name: "Newer Game",
          placement: "Full",
          state: "Active",
          lastModified: "2026-10-18T11:00:00.0000000Z",
        },
      ],
    });
    const { xbox } = client([["userpresence", { body: JSON.stringify(body) }]]);
    expect(await xbox.presence()).toMatchObject({
      device: "Scarlett",
      title: { id: "2000000009", richPresence: null },
    });
  });

  it("is null when not connected, without calling Xbox", async () => {
    const { xbox, calls } = client([["userpresence", presenceOk]], { session: null });
    expect(await xbox.presence()).toBeNull();
    expect(await xbox.titleInfo("1")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("fails achievements, rather than answering none, when not signed in", async () => {
    const { xbox, calls } = client([["achievements", { body: "{}" }]], { session: null });
    const failure = xbox.achievements("1");
    await expect(failure).rejects.toBeInstanceOf(UpstreamError);
    await expect(failure).rejects.toThrow("xbox is not signed in");
    expect(calls).toEqual([]);
  });

  it("rejects a body of the wrong shape without echoing it", async () => {
    const { xbox } = client([["userpresence", { body: "[1]" }]]);
    await expect(xbox.presence()).rejects.toThrow("unexpected response shape");
  });
});

describe("XboxClient headers", () => {
  it("headers carry contract versions", async () => {
    const { xbox, calls } = client([
      ["userpresence", presenceOk],
      ["titlehub", titlehubOk],
      ["achievements.xboxlive", { body: fixture("xbox-achievements.json") }],
    ]);
    await xbox.presence();
    await xbox.titleInfo("2000000002");
    await xbox.achievements("2000000002");
    const byHost = (h: string) => calls.find((c) => c.url.includes(h))!;

    const presence = byHost("userpresence");
    expect(presence.url).toBe(`https://userpresence.xboxlive.com/users/xuid(${XUID})?level=all`);
    expect(presence.headers["x-xbl-contract-version"]).toBe("3");

    const titlehub = byHost("titlehub");
    expect(titlehub.url).toContain(`/users/xuid(${XUID})/titles/titlehistory/decoration/`);
    expect(titlehub.url).toContain("achievement,image,detail");
    expect(titlehub.headers["x-xbl-contract-version"]).toBe("2");
    expect(titlehub.headers["x-xbl-client-name"]).toBe("XboxApp");
    expect(titlehub.headers["x-xbl-client-type"]).toBe("UWA");

    const achievements = byHost("achievements.xboxlive");
    expect(achievements.url).toBe(
      `https://achievements.xboxlive.com/users/xuid(${XUID})/achievements?titleId=2000000002&maxItems=1000`,
    );
    expect(achievements.headers["x-xbl-contract-version"]).toBe("4");

    for (const c of calls) {
      expect(c.headers.Authorization).toBe(SESSION.headers.Authorization);
      expect(c.headers["Accept-Language"]).toBe("en-US");
    }
  });
});

describe("XboxClient.titleInfo", () => {
  it("Win32-only is not Xbox Live", async () => {
    const { xbox } = client([["titlehub", titlehubOk]]);
    expect(await xbox.titleInfo("2000000003")).toMatchObject({
      id: "2000000003",
      name: "Plain Desktop Program",
      isXboxLive: false,
      image: null,
    });
  });

  it("with gamerscore is", async () => {
    const { xbox } = client([["titlehub", titlehubOk]]);
    expect(await xbox.titleInfo("2000000002")).toMatchObject({
      isXboxLive: true,
      totalGamerscore: 1000,
      image: "https://store-images.s-microsoft.com/image/apps.1.test-quest",
    });
  });

  it("an app is not Xbox Live, even on an Xbox", async () => {
    const { xbox } = client([["titlehub", titlehubOk]]);
    expect(await xbox.titleInfo("2000000005")).toMatchObject({
      name: "Sample Media Player",
      isXboxLive: false,
    });
    // `type` decides, not `mediaItemType` (games report "Application" there too).
    expect((await xbox.titleInfo("2000000002"))?.isXboxLive).toBe(true);
  });

  it("a type other than Game is not Xbox Live, whatever its achievements", async () => {
    const body = {
      titles: [
        {
          titleId: "8",
          name: "Odd App",
          type: "App",
          devices: ["XboxSeries"],
          achievement: { currentAchievements: 3, totalGamerscore: 100 },
        },
      ],
    };
    const { xbox } = client([["titlehub", { body: JSON.stringify(body) }]]);
    expect((await xbox.titleInfo("8"))?.isXboxLive).toBe(false);
  });

  it("an Xbox device alone is enough", async () => {
    const { xbox } = client([["titlehub", titlehubOk]]);
    expect((await xbox.titleInfo("2000000004"))?.isXboxLive).toBe(true);
  });

  it("achievements alone are enough, even on Win32", async () => {
    const body = {
      titles: [
        {
          titleId: "7",
          name: "Odd",
          devices: ["Win32"],
          achievement: { currentAchievements: 1, currentGamerscore: 5, totalGamerscore: 0 },
        },
      ],
    };
    const { xbox } = client([["titlehub", { body: JSON.stringify(body) }]]);
    expect((await xbox.titleInfo("7"))?.isXboxLive).toBe(true);
  });

  it("cached 24 h", async () => {
    const clock = { t: 1_000_000 };
    const { xbox, calls } = client([["titlehub", titlehubOk]], { now: () => clock.t });
    await xbox.titleInfo("2000000002");
    await xbox.titleInfo("2000000002");
    await xbox.titleInfo("2000000003"); // listed in the same response: no second call
    expect(calls).toHaveLength(1);
    clock.t += 23 * 3_600_000;
    await xbox.titleInfo("2000000002");
    expect(calls).toHaveLength(1);
    clock.t += 2 * 3_600_000;
    await xbox.titleInfo("2000000002");
    expect(calls).toHaveLength(2);
  });

  it("shares one call between concurrent lookups", async () => {
    const { xbox, calls } = client([["titlehub", titlehubOk]]);
    await Promise.all([xbox.titleInfo("2000000002"), xbox.titleInfo("2000000003")]);
    expect(calls).toHaveLength(1);
  });

  it("failures are cached 5 min", async () => {
    const clock = { t: 1_000_000 };
    let status = 500;
    const { xbox, calls } = client(
      [["titlehub", () => (status === 200 ? titlehubOk : { status })]],
      { now: () => clock.t },
    );
    expect(await xbox.titleInfo("2000000002")).toBeNull();
    clock.t += 4 * 60_000;
    expect(await xbox.titleInfo("2000000002")).toBeNull();
    expect(calls).toHaveLength(1);
    status = 200;
    clock.t += 2 * 60_000;
    expect((await xbox.titleInfo("2000000002"))?.name).toBe("Test Quest: Moon Edition");
    expect(calls).toHaveLength(2);
  });

  it("a title titlehub does not list yet is unknown for 5 min, then asked again", async () => {
    const clock = { t: 1_000_000 };
    const { xbox, calls } = client([["titlehub", titlehubOk]], { now: () => clock.t });
    expect(await xbox.titleInfo("9999")).toBeNull();
    expect(await xbox.titleInfo("9999")).toBeNull();
    expect(calls).toHaveLength(1);
    clock.t += 6 * 60_000;
    await xbox.titleInfo("9999");
    expect(calls).toHaveLength(2);
  });

  it("a 429 is a failure, cached like any other", async () => {
    const { xbox, calls } = client([
      ["titlehub", { status: 429, headers: { "retry-after": "5" } }],
    ]);
    expect(await xbox.titleInfo("1")).toBeNull();
    expect(await xbox.titleInfo("1")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("XboxClient errors", () => {
  it("429 carries retryAfterMs", async () => {
    const { xbox } = client([
      ["achievements.xboxlive", { status: 429, headers: { "retry-after": "12" } }],
      ["userpresence", { status: 429 }],
    ]);
    const err = await xbox.achievements("1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XboxRateLimitError);
    expect((err as XboxRateLimitError).retryAfterMs).toBe(12_000);
    expect(err).toBeInstanceOf(UpstreamError);
    const noHeader = await xbox.presence().catch((e: unknown) => e);
    expect((noHeader as XboxRateLimitError).retryAfterMs).toBe(60_000);
  });

  it("reads a Retry-After date", async () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    const { xbox } = client(
      [
        [
          "userpresence",
          { status: 429, headers: { "retry-after": "Sun, 18 Oct 2026 10:00:30 GMT" } },
        ],
      ],
      { now: () => now },
    );
    const err = await xbox.presence().catch((e: unknown) => e);
    expect((err as XboxRateLimitError).retryAfterMs).toBe(30_000);
  });

  it("other failures throw an UpstreamError with no URL, XUID or token in the message", async () => {
    const { xbox } = client([["userpresence", { status: 503 }]]);
    const err = (await xbox.presence().catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("upstream returned 503");
    expect(err.message).not.toContain(XUID);
    expect(err.message).not.toContain("fake-xsts");
  });

  it("an unreachable network is an UpstreamError", async () => {
    const xbox = new XboxClient({
      auth: { session: async () => SESSION },
      fetch: () => Promise.reject(new Error(`connect failed for xuid(${XUID})`)),
    });
    const err = (await xbox.presence().catch((e: unknown) => e)) as UpstreamError;
    expect(err.message).toBe("upstream unreachable");
  });

  it("an achievements body without a list is a shape error", async () => {
    const { xbox } = client([["achievements.xboxlive", { body: '{"foo":1}' }]]);
    await expect(xbox.achievements("1")).rejects.toThrow("unexpected response shape");
  });
});

describe("normaliseXbox", () => {
  const list = JSON.parse(fixture("xbox-achievements.json")) as XboxAchievementList;
  const info: XboxTitleInfo = {
    id: "2000000002",
    name: "Test Quest: Moon Edition",
    isXboxLive: true,
    image: null,
    totalGamerscore: 1000,
  };
  const r = normaliseXbox("2000000002", "Test Quest: Moon Edition", list, info);

  it("summarises the list", () => {
    expect(r).toMatchObject({
      source: "xbox",
      id: "2000000002",
      title: "Test Quest: Moon Edition",
      total: 3,
      unlocked: 1,
      stale: false,
      gamerscore: { current: 15, total: 95 },
    });
    expect(r.noList).toBeUndefined();
  });

  it("maps unlocked, time, rarity, gamerscore, progress, secret→hidden", () => {
    expect(r.achievements[0]).toEqual({
      id: "1",
      name: "First Steps",
      description: "Take your first step on the Moon.",
      icon: "https://images-eds-ssl.xboxlive.com/image?url=first",
      unlocked: true,
      unlockedAt: "2026-10-12T01:02:03.456Z",
      unlockPercent: 92.7,
      hidden: false,
      missable: false,
      kind: null,
      gamerscore: 15,
      progress: null, // a 1/1 requirement is not a counter
    });
    expect(r.achievements[1]).toMatchObject({
      unlocked: false,
      gamerscore: 30,
      progress: { current: 3, target: 10 },
      unlockPercent: 12.3,
    });
    expect(r.achievements[2]).toMatchObject({
      name: "The Far Side",
      hidden: true,
      unlocked: false,
      gamerscore: 50,
      progress: null,
      icon: null, // not an allowed image host
    });
  });

  it("year-0001 unlock time is null", () => {
    expect(r.achievements[1]?.unlockedAt).toBeNull();
    const odd = normaliseXbox(
      "1",
      "T",
      {
        achievements: [
          {
            id: "9",
            name: "Odd",
            progressState: "Achieved",
            progression: { timeUnlocked: "0001-01-01T00:00:00.0000000Z" },
          },
        ],
      },
      null,
    );
    expect(odd.achievements[0]).toMatchObject({ unlocked: true, unlockedAt: null });
  });

  it("empty list with gamerscore → noList", () => {
    const empty = JSON.parse(fixture("xbox-achievements-empty.json")) as XboxAchievementList;
    expect(normaliseXbox("2000000002", "T", empty, info)).toMatchObject({
      total: 0,
      noList: true,
    });
    expect(normaliseXbox("2000000002", "T", empty, { ...info, totalGamerscore: 0 }).noList).toBe(
      undefined,
    );
    expect(normaliseXbox("2000000002", "T", empty, null).noList).toBe(undefined);
  });

  it("reads fields defensively", () => {
    const messy = normaliseXbox(
      "1",
      "T",
      {
        achievements: [
          null,
          "x",
          { name: "no id" },
          { id: 5, name: "Numeric id", rewards: [{ type: "Other", value: "9" }], rarity: {} },
          { id: "6", progression: { requirements: [{ current: "abc", target: "10" }] } },
        ],
      },
      null,
    );
    expect(messy.achievements).toHaveLength(2);
    expect(messy.achievements[0]).toMatchObject({
      id: "5",
      description: null,
      icon: null,
      unlocked: false,
      unlockPercent: null,
      hidden: false,
      gamerscore: 0,
      progress: null,
    });
    expect(messy.achievements[1]?.progress).toBeNull();
  });
});
