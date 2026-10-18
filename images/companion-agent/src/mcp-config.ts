/** The MCP servers the agent may use, the env that configures each, and its tool-name prefix. */
const SERVERS = [
  { key: "companion", urlEnv: "COMPANION_MCP_URL", tokenEnv: "COMPANION_MCP_TOKEN" },
  { key: "retroachievements", urlEnv: "RETROACHIEVEMENTS_MCP_URL", tokenEnv: null },
  { key: "romm", urlEnv: "ROMM_MCP_URL", tokenEnv: "ROMM_MCP_TOKEN" },
  { key: "syncthing", urlEnv: "SYNCTHING_MCP_URL", tokenEnv: "SYNCTHING_MCP_TOKEN" },
  { key: "outline", urlEnv: "OUTLINE_MCP_URL", tokenEnv: "OUTLINE_API_KEY" },
] as const;

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

interface HttpServer {
  type: "http";
  url: string;
  headers?: { authorization: string };
}

export interface McpSetup {
  /** The `--mcp-config` file's content. */
  config: { mcpServers: Record<string, HttpServer> };
  /** `mcp__<server>__<tool>` for every allowlisted tool of a configured server. */
  allowedTools: string[];
}

/** Validates allowed-tools.json: server → exact tool names, nothing else. */
function parseAllowlist(raw: unknown): Map<string, string[]> {
  const fail = (why: string): never => {
    throw new Error(`allowed-tools.json: ${why}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("must be an object");
  const known = new Set<string>(SERVERS.map((s) => s.key));
  const out = new Map<string, string[]>();
  for (const [server, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(server)) fail(`unknown server "${server}"`);
    if (!Array.isArray(names)) fail(`"${server}" must list tool names`);
    for (const name of names as unknown[]) {
      if (typeof name !== "string" || !TOOL_NAME.test(name)) {
        fail(`"${server}" has an invalid tool name`);
      }
    }
    out.set(server, names as string[]);
  }
  return out;
}

/**
 * The MCP config and tool allowlist for the servers whose URL is set. Throws, so the service
 * refuses to start, when a configured server lacks its token or has no allowed tools.
 */
export function buildMcp(env: Record<string, string | undefined>, allowlist: unknown): McpSetup {
  const allowed = parseAllowlist(allowlist);
  const mcpServers: Record<string, HttpServer> = {};
  const allowedTools: string[] = [];
  for (const { key, urlEnv, tokenEnv } of SERVERS) {
    const url = env[urlEnv];
    if (url === undefined || url === "") continue;
    const names = allowed.get(key) ?? [];
    if (names.length === 0) {
      throw new Error(`${urlEnv} is set but allowed-tools.json allows no ${key} tools`);
    }
    const server: HttpServer = { type: "http", url };
    if (tokenEnv !== null) {
      const token = env[tokenEnv];
      if (token === undefined || token === "")
        throw new Error(`${urlEnv} is set but ${tokenEnv} is not`);
      server.headers = { authorization: `Bearer ${token}` };
    }
    mcpServers[key] = server;
    allowedTools.push(...names.map((n) => `mcp__${key}__${n}`));
  }
  return { config: { mcpServers }, allowedTools };
}
