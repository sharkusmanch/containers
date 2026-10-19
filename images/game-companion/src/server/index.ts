import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { AchievementService } from "./achievements.js";
import { AgentClient } from "./agent-client.js";
import { buildDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { Detector } from "./detector.js";
import { GuideIndex } from "./guide-index.js";
import { GuidePageService } from "./guide-pages.js";
import { OutlineClient } from "./outline.js";
import { PlatformMemory } from "./platform-memory.js";
import { AskLimiter } from "./rate-limit.js";
import { RaClient } from "./ra.js";
import { createHandler } from "./routes.js";
import { SteamClient } from "./steam.js";
import { XboxAuth } from "./xbox-auth.js";
import { XboxClient } from "./xbox.js";

const config = loadConfig(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ msg, ...extra }));

const steam = new SteamClient({ apiKey: config.steamApiKey, steamId: config.steamId });
const ra = new RaClient({ apiKey: config.raApiKey, username: config.raUsername });
const outline = config.outlineApiKey
  ? new OutlineClient({ baseUrl: config.outlineBaseUrl, apiKey: config.outlineApiKey })
  : null;
if (!outline) log("outline key missing; guide index disabled");

// Xbox exists only with a client ID: no sign-in, polling or memory file without one.
async function startXbox(clientId: string) {
  const auth = new XboxAuth({
    clientId,
    stateDir: config.xboxStateDir,
    log: (line) => log(line),
  });
  await auth.load();
  const memory = new PlatformMemory({ file: join(config.xboxStateDir, "platforms.json") });
  // A broken memory file only loses which platform each guide was last seen on.
  await memory.load().catch(() => log("platform memory unreadable; starting empty"));
  return { auth, client: new XboxClient({ auth }), memory };
}
const xbox = config.xboxClientId ? await startXbox(config.xboxClientId) : null;
log(xbox ? "xbox enabled" : "xbox disabled (no client id)");

// Fixed messages only: an upstream error can carry a URL with an API key in it.
const detector = new Detector({
  steam,
  ra,
  ...(xbox
    ? {
        xbox: xbox.client,
        xboxConnected: () => xbox.auth.status().state === "connected",
      }
    : {}),
  onStatus: (source, ok) => log(`${source} polling ${ok ? "recovered" : "failed"}`),
});
const index = new GuideIndex({
  source: outline,
  collectionId: config.outlineCollectionId,
  guidesParentId: config.outlineGuidesParentId,
  scheduleDocId: config.outlineScheduleDocId,
  memory: xbox?.memory ?? null,
});
const achievements = new AchievementService({
  steam,
  ra,
  ...(xbox ? { xbox: xbox.client } : {}),
});
const pages = new GuidePageService({ index, source: outline });

const ask =
  config.agentUrl && config.agentToken
    ? {
        origin: new URL(config.outlineBaseUrl).origin,
        limiter: new AskLimiter({
          perMinute: config.assistantPerMinute,
          perDay: config.assistantPerDay,
        }),
        agent: new AgentClient({ url: config.agentUrl, token: config.agentToken, log }),
      }
    : null;
log(ask ? "assistant enabled" : "assistant disabled (no agent)");

// package.json sits two levels above dist/server in the image and in a local build.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
const mcp = config.mcpToken ? { token: config.mcpToken, version } : null;
log(mcp ? "mcp endpoint enabled" : "mcp endpoint disabled (no token)");

detector.start();
// While Outline stays unreachable the index retries every few seconds; log only the first
// failure of a run, not every retry.
let lastRefreshFailed = false;
index.startAutoRefresh({
  onResult: (ok) => {
    if (ok || !lastRefreshFailed) log("guide index refresh", { ok, hubs: index.hubs().length });
    lastRefreshFailed = !ok;
  },
});

const handler = createHandler(
  buildDeps({
    staticDir: config.staticDir,
    defaultPins: config.defaultPinnedPages,
    editablePages: config.editablePages,
    additionalRaGameIds: config.additionalRaGameIds,
    detector,
    index,
    achievements,
    pages,
    ask,
    mcp,
    memory: xbox?.memory ?? null,
    // Starting a sign-in takes the Ask route's origin check: only the page itself may.
    xbox: xbox
      ? { origin: new URL(config.outlineBaseUrl).origin, auth: xbox.auth, client: xbox.client }
      : null,
    log,
  }),
);
const server = createServer((req, res) => void handler(req, res));
server.listen(config.port, "0.0.0.0", () => log("listening", { port: config.port }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    detector.stop();
    index.stopAutoRefresh();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
