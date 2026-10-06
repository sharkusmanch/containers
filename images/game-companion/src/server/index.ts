import { createServer } from "node:http";
import { AchievementService } from "./achievements.js";
import { buildDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { Detector } from "./detector.js";
import { GuideIndex } from "./guide-index.js";
import { OutlineClient } from "./outline.js";
import { RaClient } from "./ra.js";
import { createHandler } from "./routes.js";
import { SteamClient } from "./steam.js";

const config = loadConfig(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ msg, ...extra }));

const steam = new SteamClient({ apiKey: config.steamApiKey, steamId: config.steamId });
const ra = new RaClient({ apiKey: config.raApiKey, username: config.raUsername });
const outline = config.outlineApiKey
  ? new OutlineClient({ baseUrl: config.outlineBaseUrl, apiKey: config.outlineApiKey })
  : null;
if (!outline) log("outline key missing; guide index disabled");

// Fixed messages only: an upstream error can carry a URL with an API key in it.
const detector = new Detector({
  steam,
  ra,
  onStatus: (source, ok) => log(`${source} polling ${ok ? "recovered" : "failed"}`),
});
const index = new GuideIndex({
  source: outline,
  collectionId: config.outlineCollectionId,
  guidesParentId: config.outlineGuidesParentId,
  scheduleDocId: config.outlineScheduleDocId,
});
const achievements = new AchievementService({ steam, ra });

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
    detector,
    index,
    achievements,
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
