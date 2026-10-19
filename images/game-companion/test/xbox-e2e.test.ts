import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AchievementService } from "../src/server/achievements.js";
import { buildDeps } from "../src/server/app.js";
import { Detector } from "../src/server/detector.js";
import { GuideIndex } from "../src/server/guide-index.js";
import { PlatformMemory } from "../src/server/platform-memory.js";
import { createHandler } from "../src/server/routes.js";
import { XboxAuth } from "../src/server/xbox-auth.js";
import { XboxClient } from "../src/server/xbox.js";
import { fixture } from "./helpers.js";

/*
 * The whole server with Xbox on — the real sign-in, Xbox client, detector, achievement service,
 * guide index, platform memory and request handler — against a fake Microsoft and Xbox Live.
 * Every value here is invented.
 */

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const CLIENT_ID = "00000000-1111-2222-3333-444444444444";
const ORIGIN = "https://wiki.example.test";
const MCP_TOKEN = "sample-mcp-token-0123456789";
const DEVICE_CODE = "fake-device-code-e2e-secret";
const XUID = "2535999999999";
const UHS = "fake-uhs-e2e-secret";
const GAMERTAG = "SampleGamer";
const TITLE_ID = "2000000002";
const TITLE = "Test Quest: Moon Edition";
const T0 = Date.UTC(2030, 0, 1, 12);

type Canned = { status: number; body: unknown };

/** Microsoft's sign-in and the three Xbox Live services, faked; every token handed out is kept. */
class FakeMicrosoft {
  /** Every secret handed out, so the test can prove none of them reaches anyone. */
  secrets: string[] = [DEVICE_CODE, UHS, XUID];
  /** The device-code poll answers pending this many times before it signs in. */
  pendingPolls = 1;
  validRefresh = new Set<string>();
  refreshOverride: Canned | null = null;
  xstsLifetimeMs = 16 * 3_600_000;
  private xsts: string | null = null;
  private n = 0;

  constructor(private readonly now: () => number) {}

  private mint(prefix: string): string {
    this.n += 1;
    const value = `${prefix}-e2e-secret-${this.n}`;
    this.secrets.push(value);
    return value;
  }

  private tokens(): Response {
    const refresh = this.mint("rt");
    this.validRefresh.add(refresh);
    return Response.json({
      access_token: this.mint("at"),
      refresh_token: refresh,
      expires_in: 3600,
    });
  }

  fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    if (url === `${AUTHORITY}/devicecode`) {
      return Response.json({
        device_code: DEVICE_CODE,
        user_code: "WXYZ-2345",
        verification_uri: "https://www.microsoft.com/link",
        expires_in: 900,
        // A real flow waits 5 s between polls; this one 10 ms.
        interval: 0.01,
      });
    }
    if (url === `${AUTHORITY}/token`) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        if (this.refreshOverride) {
          const { status, body: answer } = this.refreshOverride;
          return Response.json(answer, { status });
        }
        if (!this.validRefresh.delete(form.get("refresh_token") ?? "")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return this.tokens();
      }
      if (form.get("device_code") !== DEVICE_CODE) return new Response("{}", { status: 400 });
      if (this.pendingPolls > 0) {
        this.pendingPolls -= 1;
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      return this.tokens();
    }
    if (url === "https://user.auth.xboxlive.com/user/authenticate") {
      return Response.json({ Token: this.mint("user") });
    }
    if (url === "https://xsts.auth.xboxlive.com/xsts/authorize") {
      this.xsts = this.mint("xsts");
      return Response.json({
        Token: this.xsts,
        NotAfter: new Date(this.now() + this.xstsLifetimeMs).toISOString(),
        DisplayClaims: { xui: [{ uhs: UHS, xid: XUID, gtg: GAMERTAG }] },
      });
    }
    // Xbox Live answers only the current XSTS token.
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `XBL3.0 x=${UHS};${this.xsts}`) {
      return new Response("{}", { status: 401 });
    }
    if (url.startsWith(`https://userpresence.xboxlive.com/users/xuid(${XUID})`)) {
      return Response.json({
        xuid: XUID,
        state: "Online",
        devices: [
          {
            type: "Scarlett",
            titles: [
              {
                id: TITLE_ID,
                name: TITLE,
                placement: "Full",
                state: "Active",
                lastModified: "2030-01-01T11:59:00.0000000Z",
                activity: { richPresence: "Exploring the Crater" },
              },
            ],
          },
        ],
      });
    }
    if (url.startsWith(`https://titlehub.xboxlive.com/users/xuid(${XUID})`)) {
      return new Response(fixture("xbox-titlehub.json"));
    }
    if (url.startsWith(`https://achievements.xboxlive.com/users/xuid(${XUID})`)) {
      return new Response(fixture("xbox-achievements.json"));
    }
    return new Response("not routed", { status: 599 });
  };
}

let dir: string;
let server: Server | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xbox-e2e-"));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = null;
  await rm(dir, { recursive: true, force: true });
});

/** The server as index.ts wires it, with Steam and RetroAchievements idle. */
async function startServer() {
  const clock = { t: T0 };
  const now = () => clock.t;
  const ms = new FakeMicrosoft(now);
  const logs: string[] = [];
  const log = (line: string, fields?: unknown): void => {
    logs.push(fields === undefined ? line : `${line} ${JSON.stringify(fields)}`);
  };

  const auth = new XboxAuth({ clientId: CLIENT_ID, stateDir: dir, fetch: ms.fn, now, log });
  await auth.load();
  const memory = new PlatformMemory({ file: join(dir, "platforms.json"), now });
  await memory.load();
  const client = new XboxClient({ auth, fetch: ms.fn, now });

  const steam = {
    presence: async () => ({ appId: null, name: null }),
    gameData: async () => null,
  };
  const ra = {
    summary: async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    gameProgress: async () => null,
  };
  const detector = new Detector({
    steam,
    ra,
    xbox: client,
    xboxConnected: () => auth.status().state === "connected",
    now,
    onStatus: (source, ok) => log(`${source} polling ${ok ? "recovered" : "failed"}`),
  });
  const docs = [
    {
      id: "hub-moon",
      title: "Test Quest: Moon Edition",
      url: "/doc/moon-aaa",
      text: "| **Steam App ID** | 1000001 |\n",
    },
  ];
  const index = new GuideIndex({
    source: {
      listChildren: async () => docs,
      collectionTree: async () => [
        {
          id: "p1",
          title: "Guides",
          url: "/doc/guides-ppp",
          children: docs.map((d) => ({ id: d.id, title: d.title, url: d.url, children: [] })),
        },
      ],
      docText: async () => "",
    },
    collectionId: "c",
    guidesParentId: "p1",
    scheduleDocId: null,
    memory,
  });
  await index.refresh();
  const achievements = new AchievementService({ steam, ra, xbox: client, now });

  const handler = createHandler(
    buildDeps({
      staticDir: "/nonexistent",
      defaultPins: [],
      editablePages: [],
      additionalRaGameIds: [],
      detector,
      index,
      achievements,
      pages: {
        find: async () => null,
        marks: async () => null,
        where: async () => null,
        progress: async () => null,
        texts: async () => [],
      },
      ask: null,
      mcp: { token: MCP_TOKEN, version: "9.9.9" },
      memory,
      xbox: { origin: ORIGIN, auth },
      log,
    }),
  );
  const s = createServer((req, res) => void handler(req, res));
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/companion`;

  /** Every response body, for the leak check. */
  const bodies: string[] = [];
  const record = async (res: Response): Promise<{ status: number; text: string }> => {
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text };
  };
  const http = {
    get: (path: string) => fetch(`${base}${path}`).then(record),
    action: (action: string) =>
      fetch(`${base}/api/xbox/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }).then(record),
    status: async () => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${MCP_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "companion_status", arguments: {} },
        }),
      }).then(record);
      const parsed = JSON.parse(r.text) as { result?: { content?: { text?: string }[] } };
      return parsed.result?.content?.[0]?.text ?? "";
    },
  };

  /** Signs in through the routes, as the page does, and waits for Microsoft to answer. */
  const signIn = async (): Promise<void> => {
    const started = await http.action("connect");
    expect(started.status).toBe(200);
    expect(JSON.parse(started.text)).toMatchObject({ state: "connecting", userCode: "WXYZ-2345" });
    await vi.waitFor(async () => {
      expect(JSON.parse((await http.get("/api/xbox")).text)).toMatchObject({
        state: "connected",
      });
    });
    // The gamertag arrives once the first Xbox Live session is built.
    await detector.pollXbox();
  };

  return { ms, clock, logs, auth, detector, http, bodies, signIn };
}

describe("Xbox end to end", () => {
  it("never lets a token, the device code or the XUID out", async () => {
    const { ms, logs, http, bodies, signIn } = await startServer();

    expect(JSON.parse((await http.get("/api/xbox")).text)).toMatchObject({
      state: "disconnected",
    });
    await signIn();
    expect(JSON.parse((await http.get("/api/xbox")).text)).toEqual({
      state: "connected",
      gamertag: GAMERTAG,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    });

    const now = JSON.parse((await http.get("/api/now")).text) as Record<string, unknown>;
    expect(now).toMatchObject({
      game: { source: "xbox", id: TITLE_ID, title: TITLE },
      state: "playing",
      presence: "Exploring the Crater",
      device: "Series X",
      hubs: [{ hubId: "hub-moon", xboxTitleId: TITLE_ID, platforms: ["steam", "xbox"] }],
    });
    const list = await http.get(`/api/achievements/xbox/${TITLE_ID}`);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text)).toMatchObject({ source: "xbox", total: 3, stale: false });
    const metrics = await http.get("/metrics");
    expect(metrics.text).toContain("game_companion_xbox_connected 1");

    const status = await http.status();
    expect(status).toContain("Source: Xbox (Series X)");
    expect(status).toContain("Hidden achievements still locked: 1");
    // A locked secret achievement is counted, never named.
    expect(status).not.toContain("The Far Side");
    expect(status).not.toContain("hidden base");

    // Cancel is a no-op while connected; disconnect forgets everything.
    expect(JSON.parse((await http.action("cancel")).text)).toMatchObject({ state: "connected" });
    expect(JSON.parse((await http.action("disconnect")).text)).toMatchObject({
      state: "disconnected",
      gamertag: null,
    });
    expect(await readdir(dir)).not.toContain("xbox-token.json");
    // And a second sign-in, cancelled while its code waits to be entered.
    ms.pendingPolls = 1_000_000;
    expect(JSON.parse((await http.action("connect")).text)).toMatchObject({
      state: "connecting",
    });
    expect(JSON.parse((await http.action("cancel")).text)).toMatchObject({
      state: "disconnected",
    });
    await http.get("/api/now");
    await http.get(`/api/achievements/xbox/${TITLE_ID}`);
    await http.get("/metrics");
    await http.status();

    const haystack = [...bodies, ...logs].join("\n");
    expect(bodies.length).toBeGreaterThan(14);
    // Device code, UHS and XUID, plus every kind of token minted along the way.
    for (const kind of ["rt", "at", "user", "xsts"]) {
      expect(
        ms.secrets.some((x) => x.startsWith(`${kind}-e2e-secret-`)),
        kind,
      ).toBe(true);
    }
    for (const secret of ms.secrets) expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(CLIENT_ID);
  });

  it("falls back sensibly when the sign-in is lost mid-play", async () => {
    const { ms, clock, logs, auth, detector, http, signIn } = await startServer();
    await signIn();
    expect(JSON.parse((await http.get("/api/now")).text)).toMatchObject({
      game: { source: "xbox", id: TITLE_ID },
      state: "playing",
    });
    const before = JSON.parse((await http.get(`/api/achievements/xbox/${TITLE_ID}`)).text) as {
      achievements: unknown[];
    };

    // The XSTS token comes due and Microsoft rejects the refresh (the app was disabled, say).
    clock.t += 20 * 3_600_000;
    ms.refreshOverride = { status: 400, body: { error: "invalid_client" } };
    await detector.pollXbox();
    expect(auth.status()).toMatchObject({
      state: "lost",
      gamertag: GAMERTAG,
      lostSince: new Date(clock.t).toISOString(),
    });
    clock.t += 30_000;
    await detector.pollXbox();

    const now = JSON.parse((await http.get("/api/now")).text) as Record<string, unknown>;
    expect(now).toMatchObject({
      game: { source: "xbox", id: TITLE_ID, title: TITLE },
      state: "last-played",
      stale: false,
      presence: null,
      device: null,
    });
    const after = await http.get(`/api/achievements/xbox/${TITLE_ID}`);
    expect(after.status).toBe(200);
    const stale = JSON.parse(after.text) as { stale: boolean; achievements: unknown[] };
    expect(stale.stale).toBe(true);
    expect(stale.achievements).toEqual(before.achievements);
    const metrics = (await http.get("/metrics")).text;
    expect(metrics).toContain("game_companion_xbox_signin_lost 1");
    expect(metrics).toContain("game_companion_xbox_connected 0");
    expect(JSON.parse((await http.get("/api/xbox")).text)).toMatchObject({
      state: "lost",
      gamertag: GAMERTAG,
    });
    expect(logs).toContain("xbox sign-in lost; sign in again to reconnect");
  });
});
