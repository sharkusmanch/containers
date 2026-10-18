import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, skillsStatus } from "./config.js";
import { buildMcp } from "./mcp-config.js";
import { AgentServer } from "./server.js";

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));
}

function main(): void {
  const env = process.env;
  const config = loadConfig(env);
  const allowlist: unknown = JSON.parse(
    readFileSync(new URL("../allowed-tools.json", import.meta.url), "utf8"),
  );
  const mcp = buildMcp(env, allowlist);
  // Holds the MCP tokens: readable by this user only.
  const mcpConfigPath = join(config.homeDir, "mcp-config.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcp.config), { mode: 0o600 });

  const agent = new AgentServer({
    config,
    mcpConfigPath,
    allowedTools: mcp.allowedTools,
    baseEnv: env,
    log,
  });
  const skills = skillsStatus(config.skillsDirs);
  agent.server.listen(config.port, () =>
    log("listening", {
      port: config.port,
      model: config.model,
      mcpServers: Object.keys(mcp.config.mcpServers),
      mcpTools: mcp.allowedTools.length,
      claudeMd: existsSync(join(config.projectDir, "CLAUDE.md")),
      skills: skills.loaded,
      skillsMissing: skills.missing,
    }),
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    log("stopping", { running: agent.running });
    void agent.shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  main();
} catch (err) {
  log("startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
