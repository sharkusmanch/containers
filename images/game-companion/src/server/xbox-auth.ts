import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XboxAuthState, XboxAuthStatus } from "../shared/types.js";

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "XboxLive.signin offline_access";
const USER_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_FILE = "xbox-token.json";
const REQUEST_TIMEOUT_MS = 10_000;
/** An XSTS token is replaced this long before Microsoft says it expires. */
const XSTS_MARGIN_MS = 5 * 60_000;
const XSTS_FALLBACK_LIFETIME_MS = 10 * 60_000;
const SLOW_DOWN_STEP_S = 5;

// The browser's view of the sign-in is shared with the web client.
export type { XboxAuthState, XboxAuthStatus };

/** Headers for the Xbox Live APIs (Authorization + Accept-Language) and the account's XUID. */
export interface XboxSession {
  headers: Record<string, string>;
  xuid: string;
}

export interface XboxAuthOptions {
  clientId: string | null;
  stateDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

interface Reply {
  /** 0 when the request never completed (network failure or timeout). */
  status: number;
  json: Rec | null;
}

interface Flow {
  id: number;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAtMs: number;
  intervalS: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CachedSession {
  session: XboxSession;
  gamertag: string;
  refreshAtMs: number;
}

type Outcome = { kind: "ok"; session: CachedSession } | { kind: "lost" } | { kind: "transient" };

/**
 * Xbox Live sign-in: Microsoft's device-code flow, a rotating refresh token kept in one file
 * (mode 0600, replaced atomically), and the user-token -> XSTS chain built from it.
 *
 * Secrets stay inside this class: logs carry fixed text and status codes, `status()` carries
 * only what the browser may see, and the device code, refresh token and Xbox tokens never leave.
 */
export class XboxAuth {
  private readonly clientId: string | null;
  private readonly file: string;
  private readonly dir: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly logLine: (line: string) => void;

  /** What is stored, ignoring any sign-in flow in progress. */
  private base: "disconnected" | "connected" | "lost" = "disconnected";
  private refreshToken: string | null = null;
  private gamertag: string | null = null;
  private lostSinceMs: number | null = null;
  private cached: CachedSession | null = null;
  private flow: Flow | null = null;
  private starting: Promise<XboxAuthStatus> | null = null;
  private inflight: Promise<XboxSession | null> | null = null;
  /** Bumped by anything that invalidates in-flight work (disconnect, new credentials). */
  private generation = 0;
  private nextFlowId = 0;
  /** File writes and the disconnect delete run one at a time, so a late write cannot undo one. */
  private fileQueue: Promise<void> = Promise.resolve();

  constructor(opts: XboxAuthOptions) {
    this.clientId = opts.clientId;
    this.dir = opts.stateDir;
    this.file = join(opts.stateDir, TOKEN_FILE);
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.logLine = opts.log ?? (() => {});
  }

  async load(): Promise<void> {
    if (this.clientId === null) return;
    await this.probeStateDir();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if (errCode(err) !== "ENOENT") this.log(`xbox token file unreadable (${errCode(err)})`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("xbox token file is not valid JSON; ignoring it");
      return;
    }
    const token = isRec(parsed) ? str(parsed.refreshToken) : null;
    if (!isRec(parsed) || token === null) {
      this.log("xbox token file has no refresh token; ignoring it");
      return;
    }
    this.refreshToken = token;
    this.gamertag = str(parsed.gamertag);
    this.base = "connected";
  }

  status(): XboxAuthStatus {
    if (this.clientId === null) return statusOf("off");
    this.expireFlowIfDue();
    const flow = this.flow;
    if (flow !== null) {
      return {
        ...statusOf("connecting"),
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAt: new Date(flow.expiresAtMs).toISOString(),
      };
    }
    return {
      ...statusOf(this.base),
      gamertag: this.base === "disconnected" ? null : this.gamertag,
      lostSince:
        this.base === "lost" && this.lostSinceMs !== null
          ? new Date(this.lostSinceMs).toISOString()
          : null,
    };
  }

  startConnect(): Promise<XboxAuthStatus> {
    if (this.clientId === null) return Promise.reject(new Error("Xbox is not configured"));
    this.expireFlowIfDue();
    if (this.flow !== null || this.base === "connected") return Promise.resolve(this.status());
    this.starting ??= this.beginFlow().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  cancelConnect(): void {
    this.endFlow();
  }

  /**
   * Forgets the sign-in and deletes the token file. If the file cannot be deleted the stored
   * sign-in would come back on restart, so the previous state is restored and this rejects (a
   * code being entered stays cancelled).
   */
  async disconnect(): Promise<void> {
    const previous = {
      base: this.base,
      refreshToken: this.refreshToken,
      gamertag: this.gamertag,
      lostSinceMs: this.lostSinceMs,
      cached: this.cached,
    };
    this.generation += 1;
    const generation = this.generation;
    this.endFlow();
    this.cached = null;
    this.refreshToken = null;
    this.gamertag = null;
    this.lostSinceMs = null;
    this.base = "disconnected";
    try {
      await this.enqueue(() => rm(this.file, { force: true }));
    } catch (err) {
      this.log(`xbox token file could not be removed (${errCode(err)})`);
      // Unless something newer (a sign-in, another disconnect) has taken over meanwhile.
      if (generation === this.generation) {
        ({
          base: this.base,
          refreshToken: this.refreshToken,
          gamertag: this.gamertag,
          lostSinceMs: this.lostSinceMs,
          cached: this.cached,
        } = previous);
      }
      throw new Error("Could not remove the stored Xbox sign-in", { cause: err });
    }
  }

  session(): Promise<XboxSession | null> {
    if (this.clientId === null || this.base !== "connected") return Promise.resolve(null);
    if (this.cached !== null && this.now() < this.cached.refreshAtMs) {
      return Promise.resolve(this.cached.session);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // --- sign-in flow ---------------------------------------------------------------------

  private async beginFlow(): Promise<XboxAuthStatus> {
    const generation = this.generation;
    const reply = await this.post(`${AUTHORITY}/devicecode`, {
      client_id: this.clientId ?? "",
      scope: SCOPE,
    });
    const body = reply.json;
    const deviceCode = body && str(body.device_code);
    const userCode = body && str(body.user_code);
    const verificationUri = body && str(body.verification_uri);
    const expiresIn = body && typeof body.expires_in === "number" ? body.expires_in : null;
    if (
      reply.status !== 200 ||
      !deviceCode ||
      !userCode ||
      !verificationUri ||
      expiresIn === null ||
      expiresIn <= 0
    ) {
      this.log(`xbox device code request failed (${reply.status})`);
      throw new Error("Xbox sign-in could not be started");
    }
    if (generation !== this.generation) throw new Error("Xbox sign-in was cancelled");
    const interval =
      body && typeof body.interval === "number" && body.interval > 0 ? body.interval : 5;
    const flow: Flow = {
      id: (this.nextFlowId += 1),
      deviceCode,
      userCode,
      verificationUri,
      expiresAtMs: this.now() + expiresIn * 1000,
      intervalS: interval,
      timer: null,
    };
    this.flow = flow;
    this.schedulePoll(flow);
    return this.status();
  }

  private schedulePoll(flow: Flow): void {
    const timer = setTimeout(() => void this.poll(flow), flow.intervalS * 1000);
    timer.unref?.();
    flow.timer = timer;
  }

  private async poll(flow: Flow): Promise<void> {
    if (this.flow !== flow) return;
    flow.timer = null;
    if (this.expireFlowIfDue()) return;

    const reply = await this.post(`${AUTHORITY}/token`, {
      grant_type: DEVICE_GRANT,
      client_id: this.clientId ?? "",
      device_code: flow.deviceCode,
    });
    if (this.flow !== flow) return; // cancelled or disconnected while the request was out

    if (reply.status === 200) {
      const accessToken = str(reply.json?.access_token);
      const refreshToken = str(reply.json?.refresh_token);
      if (accessToken === null || refreshToken === null) {
        this.log("xbox sign-in finished without usable tokens");
        this.endFlow();
        return;
      }
      await this.completeFlow(flow, accessToken, refreshToken);
      return;
    }

    const error = str(reply.json?.error);
    if (reply.status === 400 && error === "authorization_pending") {
      this.schedulePoll(flow);
    } else if (reply.status === 400 && error === "slow_down") {
      flow.intervalS += SLOW_DOWN_STEP_S;
      this.schedulePoll(flow);
    } else if (reply.status === 0 || reply.status >= 500 || reply.status === 429) {
      this.log(`xbox sign-in poll failed (${reply.status}); will retry`);
      this.schedulePoll(flow);
    } else {
      // expired_token, access_denied, authorization_declined, bad_verification_code, ...
      this.log(`xbox sign-in ended (${reply.status})`);
      this.endFlow();
    }
  }

  private async completeFlow(flow: Flow, accessToken: string, refreshToken: string): Promise<void> {
    this.endFlow();
    this.generation += 1;
    const generation = this.generation;
    this.cached = null;
    this.refreshToken = refreshToken;
    this.gamertag = null;
    this.lostSinceMs = null;
    this.base = "connected";
    await this.persist(this.generation);
    const outcome = await this.buildSession(accessToken, generation);
    if (generation !== this.generation) return;
    await this.applyOutcome(outcome);
  }

  private endFlow(): void {
    if (this.flow?.timer) clearTimeout(this.flow.timer);
    this.flow = null;
  }

  private expireFlowIfDue(): boolean {
    if (this.flow === null || this.now() < this.flow.expiresAtMs) return false;
    this.endFlow();
    return true;
  }

  // --- refresh and the Xbox token chain ---------------------------------------------------

  private async refresh(): Promise<XboxSession | null> {
    const generation = this.generation;
    const current = this.refreshToken;
    if (current === null) return null;

    const reply = await this.post(`${AUTHORITY}/token`, {
      grant_type: "refresh_token",
      client_id: this.clientId ?? "",
      refresh_token: current,
      scope: SCOPE,
    });
    if (generation !== this.generation) return null;

    const accessToken = reply.status === 200 ? str(reply.json?.access_token) : null;
    if (accessToken === null) {
      // Any OAuth error on a 400/401 is Microsoft refusing this sign-in (invalid_grant, a
      // disabled app's invalid_client or unauthorized_client, ...): retrying cannot fix it.
      // 429, 5xx and network failures are transient.
      const rejected =
        (reply.status === 400 || reply.status === 401) && str(reply.json?.error) !== null;
      if (rejected) this.markLost();
      else this.log(`xbox token refresh failed (${reply.status})`);
      return null;
    }

    // Microsoft rotates the refresh token: the new one is on disk before anything uses the
    // access token, so a crash from here on cannot strand us with a spent token.
    const rotated = str(reply.json?.refresh_token);
    if (rotated !== null && rotated !== current) {
      this.refreshToken = rotated;
      await this.persist(this.generation);
      if (generation !== this.generation) return null;
    }

    const outcome = await this.buildSession(accessToken, generation);
    if (generation !== this.generation) return null;
    return this.applyOutcome(outcome);
  }

  private async applyOutcome(outcome: Outcome): Promise<XboxSession | null> {
    if (outcome.kind === "lost") {
      this.markLost();
      return null;
    }
    if (outcome.kind === "transient") return null;
    this.cached = outcome.session;
    if (this.gamertag !== outcome.session.gamertag) {
      this.gamertag = outcome.session.gamertag;
      await this.persist(this.generation);
    }
    return outcome.session.session;
  }

  private async buildSession(accessToken: string, generation: number): Promise<Outcome> {
    const user = await this.post(
      USER_AUTH_URL,
      {
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT",
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: `d=${accessToken}`,
        },
      },
      "json",
    );
    if (generation !== this.generation) return { kind: "transient" };
    if (user.status === 401 || user.status === 403) {
      this.log(`xbox user token refused (${user.status})`);
      return { kind: "lost" };
    }
    const userToken = user.status === 200 ? str(user.json?.Token) : null;
    if (userToken === null) {
      this.log(`xbox user token request failed (${user.status})`);
      return { kind: "transient" };
    }

    const xsts = await this.post(
      XSTS_URL,
      {
        RelyingParty: "http://xboxlive.com",
        TokenType: "JWT",
        Properties: { UserTokens: [userToken], SandboxId: "RETAIL" },
      },
      "json",
    );
    if (generation !== this.generation) return { kind: "transient" };
    if (xsts.status === 401 || xsts.status === 403) {
      const code = xsts.json?.XErr;
      this.log(
        `xbox xsts refused (${xsts.status}${typeof code === "number" ? `, XErr ${code}` : ""})`,
      );
      return { kind: "lost" };
    }
    const token = xsts.status === 200 ? str(xsts.json?.Token) : null;
    const claim = xsts.json?.DisplayClaims;
    const xui = isRec(claim) && Array.isArray(claim.xui) ? (claim.xui[0] as unknown) : undefined;
    const uhs = isRec(xui) ? str(xui.uhs) : null;
    const xuid = isRec(xui) ? str(xui.xid) : null;
    const gamertag = isRec(xui) ? str(xui.gtg) : null;
    if (token === null || uhs === null || xuid === null || gamertag === null) {
      this.log(`xbox xsts request failed (${xsts.status})`);
      return { kind: "transient" };
    }
    const notAfter = Date.parse(str(xsts.json?.NotAfter) ?? "");
    const lifetimeEnd = Number.isNaN(notAfter) ? this.now() + XSTS_FALLBACK_LIFETIME_MS : notAfter;
    return {
      kind: "ok",
      session: {
        session: {
          headers: { Authorization: `XBL3.0 x=${uhs};${token}`, "Accept-Language": "en-US" },
          xuid,
        },
        gamertag,
        refreshAtMs: lifetimeEnd - XSTS_MARGIN_MS,
      },
    };
  }

  private markLost(): void {
    this.cached = null;
    this.base = "lost";
    this.lostSinceMs ??= this.now();
    this.log("xbox sign-in lost; sign in again to reconnect");
  }

  // --- storage and HTTP -----------------------------------------------------------------

  /**
   * A state directory that cannot be written would lose every rotated token on restart, so it
   * is said at start-up, once, in fixed words (no path, no error text).
   */
  private async probeStateDir(): Promise<void> {
    const probe = join(this.dir, `.write-probe.${process.pid}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(probe, "", { mode: 0o600 });
    } catch {
      this.log("xbox state directory is not writable");
      return;
    }
    await rm(probe, { force: true }).catch(() => {});
  }

  /** Write-then-rename, so a failure at any point leaves the previous file whole. */
  private persist(generation: number): Promise<void> {
    // Skipped if a disconnect (or newer credentials) came in while this waited its turn.
    const write = (): Promise<void> =>
      generation === this.generation ? this.writeTokenFile() : Promise.resolve();
    return this.enqueue(write);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.fileQueue.then(job);
    this.fileQueue = run.catch(() => {});
    return run;
  }

  private async writeTokenFile(): Promise<void> {
    if (this.refreshToken === null) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify({
      refreshToken: this.refreshToken,
      gamertag: this.gamertag ?? "",
      savedAt: new Date(this.now()).toISOString(),
    });
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, body, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      // The in-memory token keeps this run going; the file just stays one rotation behind.
      this.log(`xbox token file could not be saved (${errCode(err)})`);
    }
  }

  private async post(url: string, payload: Rec, as: "form" | "json" = "form"): Promise<Reply> {
    const headers: Record<string, string> =
      as === "form"
        ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
        : {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xbl-contract-version": "1",
          };
    const body =
      as === "form"
        ? new URLSearchParams(payload as Record<string, string>).toString()
        : JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      let json: Rec | null = null;
      try {
        const parsed: unknown = await response.json();
        json = isRec(parsed) ? parsed : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch {
      return { status: 0, json: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private log(line: string): void {
    this.logLine(line);
  }
}

function statusOf(state: XboxAuthState): XboxAuthStatus {
  return {
    state,
    gamertag: null,
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    lostSince: null,
  };
}

function errCode(err: unknown): string {
  return isRec(err) && typeof err.code === "string" ? err.code : "error";
}
