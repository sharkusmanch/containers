import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XboxAuth } from "../src/server/xbox-auth.js";

// The real rename, but with a seam so one test can make it fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const fsp = await import("node:fs/promises");

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "XboxLive.signin offline_access";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const DEVICE_CODE = "fake-device-code-secret";
const GAMERTAG = "TestGamer";
const XUID = "2535000000001";
const UHS = "fake-uhs-secret";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}
interface Canned {
  status: number;
  body: unknown;
}

/** Every Microsoft/Xbox endpoint the sign-in touches, faked. Nothing here is real. */
class FakeMs {
  calls: Call[] = [];
  /** Every secret the fake has handed out, so tests can prove none of them leak. */
  secrets: string[] = [DEVICE_CODE, UHS, XUID];
  /** Answers for successive device-code polls; pending once the queue runs dry. */
  devicePolls: Canned[] = [];
  validRefresh = new Set<string>();
  sentRefresh: string[] = [];
  refreshOverride: Canned | null = null;
  userOverride: Canned | null = null;
  xstsOverride: Canned | null = null;
  xstsLifetimeMs = 16 * 3_600_000;
  onUserAuth: (() => void) | null = null;
  /** Holds device-code poll answers back until released. */
  gate: Promise<void> | null = null;
  private n = 0;

  mint(prefix: string): string {
    this.n += 1;
    const value = `${prefix}-secret-${this.n}`;
    this.secrets.push(value);
    return value;
  }

  count(fragment: string, grant?: string): number {
    return this.calls.filter(
      (c) => c.url.includes(fragment) && (grant === undefined || c.body.includes(grant)),
    ).length;
  }

  fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    this.calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
    const json = (c: Canned): Response => Response.json(c.body, { status: c.status });

    if (url === `${AUTHORITY}/devicecode`) {
      return json({
        status: 200,
        body: {
          device_code: DEVICE_CODE,
          user_code: "ABCD1234",
          verification_uri: "https://www.microsoft.com/link",
          expires_in: 900,
          interval: 5,
        },
      });
    }
    if (url === `${AUTHORITY}/token`) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        const sent = form.get("refresh_token") ?? "";
        this.sentRefresh.push(sent);
        if (this.refreshOverride) return json(this.refreshOverride);
        if (!this.validRefresh.delete(sent)) {
          return json({ status: 400, body: { error: "invalid_grant" } });
        }
        const next = this.mint("rt");
        this.validRefresh.add(next);
        return json({
          status: 200,
          body: { access_token: this.mint("at"), refresh_token: next, expires_in: 3600 },
        });
      }
      if (this.gate) await this.gate;
      const polled = this.devicePolls.shift() ?? {
        status: 400,
        body: { error: "authorization_pending" },
      };
      if (polled.status === 200) {
        const next = this.mint("rt");
        this.validRefresh.add(next);
        return json({
          status: 200,
          body: { access_token: this.mint("at"), refresh_token: next, expires_in: 3600 },
        });
      }
      return json(polled);
    }
    if (url === "https://user.auth.xboxlive.com/user/authenticate") {
      this.onUserAuth?.();
      if (this.userOverride) return json(this.userOverride);
      return json({
        status: 200,
        body: {
          Token: this.mint("user"),
          NotAfter: new Date(Date.now() + 14 * 864e5).toISOString(),
        },
      });
    }
    if (url === "https://xsts.auth.xboxlive.com/xsts/authorize") {
      if (this.xstsOverride) return json(this.xstsOverride);
      return json({
        status: 200,
        body: {
          Token: this.mint("xsts"),
          NotAfter: new Date(Date.now() + this.xstsLifetimeMs).toISOString(),
          DisplayClaims: { xui: [{ uhs: UHS, xid: XUID, gtg: GAMERTAG }] },
        },
      });
    }
    return new Response("not routed", { status: 599 });
  };
}

let dir: string;
let ms: FakeMs;
let logs: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  dir = await mkdtemp(join(tmpdir(), "xbox-auth-"));
  ms = new FakeMs();
  logs = [];
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const tokenFile = (): string => join(dir, "xbox-token.json");

function makeAuth(clientId: string | null = CLIENT_ID, stateDir = dir): XboxAuth {
  return new XboxAuth({
    clientId,
    stateDir,
    fetch: ms.fn as typeof fetch,
    now: () => Date.now(),
    log: (line) => logs.push(line),
  });
}

/** Let real file I/O and chained promises settle while the fake clock stays put. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(5); // node:timers is not faked, so real I/O gets to finish
    await vi.advanceTimersByTimeAsync(0);
  }
}
async function advance(ms_: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms_);
  await settle();
}

async function seedFile(refreshToken = "rt-seed"): Promise<void> {
  await writeFile(
    tokenFile(),
    JSON.stringify({ refreshToken, gamertag: GAMERTAG, savedAt: "2029-12-01T00:00:00.000Z" }),
    { mode: 0o600 },
  );
  ms.validRefresh.add(refreshToken);
}

async function connectedAuth(): Promise<XboxAuth> {
  await seedFile();
  const auth = makeAuth();
  await auth.load();
  return auth;
}

describe("XboxAuth when Xbox is not configured", () => {
  it("is off and refuses to start a sign-in", async () => {
    const auth = makeAuth(null);
    await auth.load();
    expect(auth.status()).toEqual({
      state: "off",
      gamertag: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    });
    await expect(auth.startConnect()).rejects.toThrow();
    expect(await auth.session()).toBeNull();
    expect(ms.calls).toHaveLength(0);
  });
});

describe("XboxAuth.load", () => {
  it("is disconnected when there is no token file", async () => {
    const auth = makeAuth();
    await auth.load();
    expect(auth.status().state).toBe("disconnected");
  });

  it("is connected, with the stored gamertag, when a token file exists, without calling out", async () => {
    const auth = await connectedAuth();
    expect(auth.status()).toMatchObject({
      state: "connected",
      gamertag: GAMERTAG,
      lostSince: null,
    });
    expect(ms.calls).toHaveLength(0);
  });

  it("treats an unreadable token file as disconnected", async () => {
    await writeFile(tokenFile(), "{ not json");
    const auth = makeAuth();
    await auth.load();
    expect(auth.status().state).toBe("disconnected");
  });

  it("treats a token file without a refresh token as disconnected", async () => {
    await writeFile(tokenFile(), JSON.stringify({ gamertag: GAMERTAG, savedAt: "x" }));
    const auth = makeAuth();
    await auth.load();
    expect(auth.status().state).toBe("disconnected");
  });
});

describe("XboxAuth.startConnect", () => {
  it("returns the code and link, never the device code", async () => {
    const auth = makeAuth();
    await auth.load();
    const status = await auth.startConnect();
    expect(status).toEqual({
      state: "connecting",
      gamertag: null,
      userCode: "ABCD1234",
      verificationUri: "https://www.microsoft.com/link",
      expiresAt: "2030-01-01T00:15:00.000Z",
      lostSince: null,
    });
    expect(JSON.stringify(status)).not.toContain(DEVICE_CODE);
    expect(JSON.stringify(auth.status())).not.toContain(DEVICE_CODE);
    auth.cancelConnect();
  });

  it("asks Microsoft for exactly the Xbox sign-in scope as a public client", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    const call = ms.calls[0];
    expect(call?.url).toBe(`${AUTHORITY}/devicecode`);
    const form = new URLSearchParams(call?.body);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("scope")).toBe(SCOPE);
    expect(call?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    auth.cancelConnect();
  });

  it("returns the same code to a second call while connecting", async () => {
    const auth = makeAuth();
    await auth.load();
    const [a, b] = await Promise.all([auth.startConnect(), auth.startConnect()]);
    const c = await auth.startConnect();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(ms.count("/devicecode")).toBe(1);
    auth.cancelConnect();
  });

  it("fails without leaking detail when Microsoft refuses the request", async () => {
    const auth = makeAuth();
    await auth.load();
    const failing = new XboxAuth({
      clientId: CLIENT_ID,
      stateDir: dir,
      fetch: async () => new Response("nope", { status: 500 }),
      log: (line) => logs.push(line),
    });
    await expect(failing.startConnect()).rejects.toThrow(/sign-in/i);
    expect(failing.status().state).toBe("disconnected");
  });

  it("does nothing, and keeps the connection, when already connected", async () => {
    const auth = await connectedAuth();
    const status = await auth.startConnect();
    expect(status.state).toBe("connected");
    expect(ms.calls).toHaveLength(0);
  });
});

describe("XboxAuth device-code polling", () => {
  it("saves the refresh token 0600 and connects on success", async () => {
    const stateDir = join(dir, "not-yet-created");
    const auth = makeAuth(CLIENT_ID, stateDir);
    await auth.load();
    await auth.startConnect();
    ms.devicePolls.push({ status: 200, body: {} });

    await advance(4_999);
    expect(ms.count("/token")).toBe(0);
    await advance(1);

    expect(auth.status()).toMatchObject({
      state: "connected",
      gamertag: GAMERTAG,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
    });
    const file = join(stateDir, "xbox-token.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["gamertag", "refreshToken", "savedAt"]);
    expect(saved).toMatchObject({ gamertag: GAMERTAG, refreshToken: "rt-secret-1" });
    expect(await readdir(stateDir)).toEqual(["xbox-token.json"]);

    const form = new URLSearchParams(ms.calls.find((c) => c.url.endsWith("/token"))?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("device_code")).toBe(DEVICE_CODE);

    // The chain ran once, and the session it built is ready without another trip.
    const session = await auth.session();
    expect(session?.xuid).toBe(XUID);
    expect(ms.count("/user/authenticate")).toBe(1);
    expect(ms.count("/xsts/authorize")).toBe(1);
  });

  it("keeps polling through authorization_pending", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    await advance(5_000);
    await advance(5_000);
    expect(ms.count("/token")).toBe(2);
    expect(auth.status().state).toBe("connecting");
    auth.cancelConnect();
  });

  it("waits five seconds longer after slow_down", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    ms.devicePolls.push({ status: 400, body: { error: "slow_down" } });
    await advance(5_000);
    expect(ms.count("/token")).toBe(1);
    await advance(9_999);
    expect(ms.count("/token")).toBe(1);
    await advance(1);
    expect(ms.count("/token")).toBe(2);
    auth.cancelConnect();
  });

  it("keeps polling after a transient failure", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    ms.devicePolls.push({ status: 503, body: {} });
    await advance(5_000);
    expect(auth.status().state).toBe("connecting");
    await advance(5_000);
    expect(ms.count("/token")).toBe(2);
    auth.cancelConnect();
  });

  it("returns to disconnected when the flow runs out", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    await advance(900_000);
    expect(auth.status().state).toBe("disconnected");
    const polls = ms.count("/token");
    await advance(60_000);
    expect(ms.count("/token")).toBe(polls);
  });

  it.each(["expired_token", "access_denied", "authorization_declined"])(
    "returns to disconnected on %s",
    async (error) => {
      const auth = makeAuth();
      await auth.load();
      await auth.startConnect();
      ms.devicePolls.push({ status: 400, body: { error } });
      await advance(5_000);
      expect(auth.status()).toMatchObject({ state: "disconnected", userCode: null });
      await advance(60_000);
      expect(ms.count("/token")).toBe(1);
    },
  );

  it("stops polling on cancel", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    await advance(5_000);
    auth.cancelConnect();
    expect(auth.status()).toMatchObject({ state: "disconnected", userCode: null });
    await advance(120_000);
    expect(ms.count("/token")).toBe(1);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("drops a sign-in that completes after cancel", async () => {
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    ms.devicePolls.push({ status: 200, body: {} });
    let release = (): void => {};
    ms.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(5_000); // the poll is out, its answer held back
    expect(ms.count("/token")).toBe(1);
    auth.cancelConnect();
    release();
    await settle();
    expect(auth.status().state).toBe("disconnected");
    expect(ms.count("/user/authenticate")).toBe(0);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("stops polling on disconnect and touches only its own file", async () => {
    const other = join(dir, "someone-elses.json");
    await writeFile(other, "{}");
    const auth = makeAuth();
    await auth.load();
    await auth.startConnect();
    await advance(5_000);
    await auth.disconnect();
    expect(auth.status().state).toBe("disconnected");
    await advance(120_000);
    expect(ms.count("/token")).toBe(1);
    await expect(readdir(dir)).resolves.toEqual(["someone-elses.json"]);
  });

  it("reconnects from lost and clears lostSince", async () => {
    await seedFile();
    ms.refreshOverride = { status: 400, body: { error: "invalid_grant" } };
    const auth = makeAuth();
    await auth.load();
    await auth.session();
    expect(auth.status().state).toBe("lost");

    await auth.startConnect();
    expect(auth.status()).toMatchObject({ state: "connecting", gamertag: null, lostSince: null });
    ms.devicePolls.push({ status: 200, body: {} });
    await advance(5_000);
    expect(auth.status()).toMatchObject({
      state: "connected",
      gamertag: GAMERTAG,
      lostSince: null,
    });
  });

  it("falls back to lost, not disconnected, when a lost sign-in is cancelled", async () => {
    await seedFile();
    ms.refreshOverride = { status: 400, body: { error: "invalid_grant" } };
    const auth = makeAuth();
    await auth.load();
    await auth.session();
    await auth.startConnect();
    auth.cancelConnect();
    expect(auth.status()).toMatchObject({ state: "lost", gamertag: GAMERTAG });
  });
});

describe("XboxAuth.session", () => {
  it("builds the headers and returns the XUID", async () => {
    const auth = await connectedAuth();
    const session = await auth.session();
    expect(session).toEqual({
      headers: {
        Authorization: `XBL3.0 x=${UHS};xsts-secret-4`,
        "Accept-Language": "en-US",
      },
      xuid: XUID,
    });

    const refresh = ms.calls.find((c) => c.url === `${AUTHORITY}/token`);
    const refreshForm = new URLSearchParams(refresh?.body);
    expect(refreshForm.get("grant_type")).toBe("refresh_token");
    expect(refreshForm.get("refresh_token")).toBe("rt-seed");
    expect(refreshForm.get("client_id")).toBe(CLIENT_ID);
    expect(refreshForm.get("scope")).toBe(SCOPE);

    const user = ms.calls.find((c) => c.url.endsWith("/user/authenticate"));
    expect(user?.headers["x-xbl-contract-version"]).toBe("1");
    expect(JSON.parse(user?.body ?? "{}")).toEqual({
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
      Properties: {
        AuthMethod: "RPS",
        SiteName: "user.auth.xboxlive.com",
        RpsTicket: "d=at-secret-2",
      },
    });
    const xsts = ms.calls.find((c) => c.url.endsWith("/xsts/authorize"));
    expect(xsts?.headers["x-xbl-contract-version"]).toBe("1");
    expect(JSON.parse(xsts?.body ?? "{}")).toEqual({
      RelyingParty: "http://xboxlive.com",
      TokenType: "JWT",
      Properties: { UserTokens: ["user-secret-3"], SandboxId: "RETAIL" },
    });
  });

  it("is null unless connected", async () => {
    const auth = makeAuth();
    await auth.load();
    expect(await auth.session()).toBeNull();
    await auth.startConnect();
    expect(await auth.session()).toBeNull();
    auth.cancelConnect();
    expect(ms.count("/user/authenticate")).toBe(0);
  });

  it("persists the rotated refresh token before using the new access token", async () => {
    const auth = await connectedAuth();
    let onDiskAtFirstUse = "";
    ms.onUserAuth = () => {
      onDiskAtFirstUse = readFileSyncJson().refreshToken;
    };
    await auth.session();
    expect(onDiskAtFirstUse).toBe("rt-secret-1");
    expect(readFileSyncJson().refreshToken).toBe("rt-secret-1");
  });

  it("serves the cached XSTS token until five minutes before it expires", async () => {
    const auth = await connectedAuth();
    const first = await auth.session();
    await advance(15 * 3_600_000 + 54 * 60_000); // 16 h lifetime - 5 min margin is 15 h 55 min
    expect(await auth.session()).toEqual(first);
    expect(ms.count("/xsts/authorize")).toBe(1);
  });

  it("rotates again once the XSTS token is due, and never reuses a refresh token", async () => {
    const auth = await connectedAuth();
    const first = await auth.session();
    await advance(15 * 3_600_000 + 56 * 60_000);
    const second = await auth.session();
    expect(second).not.toEqual(first);
    expect(ms.sentRefresh).toEqual(["rt-seed", "rt-secret-1"]);
    expect(new Set(ms.sentRefresh).size).toBe(ms.sentRefresh.length);
    expect(readFileSyncJson().refreshToken).toBe("rt-secret-5");
    expect(auth.status().state).toBe("connected");
  });

  it("shares one refresh between concurrent callers", async () => {
    const auth = await connectedAuth();
    const [a, b, c] = await Promise.all([auth.session(), auth.session(), auth.session()]);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(ms.count("/token", "grant_type=refresh_token")).toBe(1);
    expect(ms.count("/user/authenticate")).toBe(1);
    expect(ms.count("/xsts/authorize")).toBe(1);
  });

  it("stays connected, returning null, on a transient failure", async () => {
    const auth = await connectedAuth();
    ms.refreshOverride = { status: 503, body: {} };
    expect(await auth.session()).toBeNull();
    expect(auth.status()).toMatchObject({ state: "connected", lostSince: null });
    ms.refreshOverride = null;
    expect(await auth.session()).not.toBeNull();
  });

  it("goes lost on invalid_grant, keeping the file and the gamertag", async () => {
    const auth = await connectedAuth();
    ms.refreshOverride = { status: 400, body: { error: "invalid_grant" } };
    expect(await auth.session()).toBeNull();
    expect(auth.status()).toEqual({
      state: "lost",
      gamertag: GAMERTAG,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: "2030-01-01T00:00:00.000Z",
    });
    expect(readFileSyncJson().refreshToken).toBe("rt-seed");
  });

  it("sets lostSince once", async () => {
    const auth = await connectedAuth();
    ms.refreshOverride = { status: 400, body: { error: "invalid_grant" } };
    await auth.session();
    await advance(3_600_000);
    expect(await auth.session()).toBeNull();
    expect(auth.status().lostSince).toBe("2030-01-01T00:00:00.000Z");
    expect(ms.count("/token")).toBe(1);
  });

  it("goes lost when the user token is refused", async () => {
    const auth = await connectedAuth();
    ms.userOverride = { status: 401, body: {} };
    expect(await auth.session()).toBeNull();
    expect(auth.status().state).toBe("lost");
  });

  it("goes lost on an XSTS error without leaking its text", async () => {
    const auth = await connectedAuth();
    ms.xstsOverride = {
      status: 401,
      body: { Identity: "0", XErr: 2148916233, Message: "", Redirect: "https://example.test/x" },
    };
    expect(await auth.session()).toBeNull();
    const status = auth.status();
    expect(status.state).toBe("lost");
    const everything = JSON.stringify(status) + logs.join("\n");
    expect(everything).not.toContain("example.test");
  });

  it("does not use a refresh that finishes after disconnect", async () => {
    const auth = await connectedAuth();
    const pending = auth.session();
    await auth.disconnect();
    expect(await pending).toBeNull();
    await settle();
    expect(auth.status().state).toBe("disconnected");
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe("XboxAuth.disconnect", () => {
  it("deletes the file and forgets the session", async () => {
    const auth = await connectedAuth();
    expect(await auth.session()).not.toBeNull();
    await auth.disconnect();
    expect(auth.status()).toEqual({
      state: "disconnected",
      gamertag: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    });
    expect(await auth.session()).toBeNull();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("is fine when there is nothing to delete", async () => {
    const auth = makeAuth();
    await auth.load();
    await expect(auth.disconnect()).resolves.toBeUndefined();
  });
});

describe("XboxAuth secrecy and durability", () => {
  it("puts no token in the logs or in any status", async () => {
    const seen: string[] = [];
    const auth = makeAuth();
    await auth.load();
    seen.push(JSON.stringify(await auth.startConnect()));
    ms.devicePolls.push({ status: 400, body: { error: "slow_down" } }, { status: 200, body: {} });
    await advance(5_000);
    seen.push(JSON.stringify(auth.status()));
    await advance(10_000);
    seen.push(JSON.stringify(auth.status()));
    ms.xstsLifetimeMs = 60_000;
    await auth.session();
    await advance(120_000);
    await auth.session();
    seen.push(JSON.stringify(auth.status()));
    ms.refreshOverride = { status: 400, body: { error: "invalid_grant" } };
    ms.xstsLifetimeMs = 60_000;
    await advance(120_000);
    await auth.session();
    seen.push(JSON.stringify(auth.status()));
    ms.refreshOverride = { status: 503, body: { error: DEVICE_CODE } };
    await auth.disconnect();

    const haystack = seen.join("\n") + "\n" + logs.join("\n");
    expect(ms.secrets.length).toBeGreaterThan(6);
    for (const secret of [...ms.secrets, "rt-seed"]) expect(haystack).not.toContain(secret);
  });

  it("leaves the previous file intact when the rename fails", async () => {
    const auth = await connectedAuth();
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error("disk says no rt-secret-1"));
    const session = await auth.session();

    expect(session).not.toBeNull(); // the new token still works for this run
    expect(readFileSyncJson().refreshToken).toBe("rt-seed");
    expect(await readdir(dir)).toEqual(["xbox-token.json"]);
    expect(logs.join("\n")).not.toContain("rt-secret-1");
    expect(logs.join("\n")).not.toContain("rt-seed");
  });
});

import { readFileSync } from "node:fs";
function readFileSyncJson(): { refreshToken: string; gamertag: string; savedAt: string } {
  return JSON.parse(readFileSync(tokenFile(), "utf8")) as {
    refreshToken: string;
    gamertag: string;
    savedAt: string;
  };
}
