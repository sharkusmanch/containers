import { timingSafeEqual } from "node:crypto";

/**
 * The Model Context Protocol over plain JSON-RPC: one request per POST, answered with one JSON
 * object (no event streams, no sessions). Every tool is read-only.
 */

/** Newest first; an `initialize` asking for any other version is answered with the first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** The tool backends. `hub` is undefined when the caller left it out. */
export interface McpTools {
  status(hub: string | undefined): Promise<ToolResult>;
  listGuides(): Promise<ToolResult>;
  outline(hub: string | undefined): Promise<ToolResult>;
  search(query: string, hub: string | undefined): Promise<ToolResult>;
  read(page: string, section: string | undefined, hub: string | undefined): Promise<ToolResult>;
  xboxTitles(query: string | undefined): Promise<ToolResult>;
  xboxAchievements(titleId: string): Promise<ToolResult>;
}

type Id = string | number;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string } };

const HUB_PATTERN = "^[A-Za-z0-9-]{1,64}$";
const HUB_RE = new RegExp(HUB_PATTERN);
const TITLE_ID_PATTERN = "^[0-9]{1,20}$";
const TITLE_ID_RE = new RegExp(TITLE_ID_PATTERN);
/** Longest query, page or section name accepted, in characters (code points). */
const TEXT_MAX = 200;

const hubProp = {
  type: "string",
  pattern: HUB_PATTERN,
  description: "Guide id from list_guides; leave it out for the guide of the current game.",
};
const textProp = (description: string) => ({
  type: "string",
  minLength: 1,
  maxLength: TEXT_MAX,
  description,
});
const titleIdProp = {
  type: "string",
  pattern: TITLE_ID_PATTERN,
  description: "Xbox title id from xbox_titles.",
};
const schema = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS = [
  {
    name: "companion_status",
    description:
      "Get the player's game status: game, platform, play state, in-game status line, achievement progress, open missables, next story achievements and the guide section matching the status line.",
    inputSchema: schema({ hub: hubProp }, []),
  },
  {
    name: "list_guides",
    description: "List the player's game guides with their titles, platforms and guide ids.",
    inputSchema: schema({}, []),
  },
  {
    name: "guide_outline",
    description: "Get the outline of a game guide: every page with its length and its headings.",
    inputSchema: schema({ hub: hubProp }, []),
  },
  {
    name: "search_guide",
    description:
      "Search every page of a game guide for a word or short phrase (a place, item, enemy or character name works best) and get the matching lines with their page and section.",
    inputSchema: schema({ query: textProp("Word or short phrase to find."), hub: hubProp }, [
      "query",
    ]),
  },
  {
    name: "read_guide_page",
    description:
      "Read one page of a game guide, or only one section of it, using the page and section names from guide_outline.",
    inputSchema: schema(
      {
        page: textProp("Page title from guide_outline."),
        section: textProp("Section heading on that page; leave it out for the whole page."),
        hub: hubProp,
      },
      ["page"],
    ),
  },
  {
    name: "xbox_titles",
    description:
      "List the player's Xbox title history, newest first, with title ids, devices, last played times and Gamerscore, optionally only titles whose name contains the query.",
    inputSchema: schema({ query: textProp("Part of a game name to filter by.") }, []),
  },
  {
    name: "xbox_achievements",
    description:
      "Get every achievement of one Xbox title with its description, locked description, secret flag, unlock time, rarity, Gamerscore and progress.",
    inputSchema: schema({ titleId: titleIdProp }, ["titleId"]),
  },
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is Id =>
  typeof v === "string" || (typeof v === "number" && Number.isInteger(v));

const failure = (id: Id | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const invalidRequest = (): JsonRpcResponse => failure(null, -32600, "Invalid Request");
const invalidParams = (id: Id): JsonRpcResponse => failure(id, -32602, "Invalid params");

/** The tool's arguments checked against its schema: the values, or the text of a tool error. */
function checkArgs(
  args: Record<string, unknown>,
  tool: (typeof TOOLS)[number],
): { values: Record<string, string | undefined> } | { error: string } {
  const { properties, required } = tool.inputSchema as {
    properties: Record<string, object>;
    required: string[];
  };
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return { error: `Unknown argument "${key}".` };
  }
  for (const key of required) {
    if (args[key] === undefined) return { error: `Missing argument "${key}".` };
  }
  const values: Record<string, string | undefined> = {};
  for (const key of Object.keys(properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (typeof v !== "string") return { error: `Argument "${key}" must be a string.` };
    if (key === "hub") {
      if (!HUB_RE.test(v)) return { error: 'Argument "hub" must be a guide id from list_guides.' };
    } else if (key === "titleId") {
      if (!TITLE_ID_RE.test(v)) return { error: 'Argument "titleId" must be an Xbox title id.' };
    } else {
      if (v.trim() === "") return { error: `Argument "${key}" must not be empty.` };
      if ([...v].length > TEXT_MAX) {
        return { error: `Argument "${key}" is longer than ${TEXT_MAX} characters.` };
      }
    }
    values[key] = v;
  }
  return { values };
}

function runTool(
  tools: McpTools,
  name: string,
  v: Record<string, string | undefined>,
): Promise<ToolResult> {
  switch (name) {
    case "companion_status":
      return tools.status(v.hub);
    case "list_guides":
      return tools.listGuides();
    case "guide_outline":
      return tools.outline(v.hub);
    case "search_guide":
      return tools.search(v.query as string, v.hub);
    case "xbox_titles":
      return tools.xboxTitles(v.query);
    case "xbox_achievements":
      return tools.xboxAchievements(v.titleId as string);
    default:
      return tools.read(v.page as string, v.section, v.hub);
  }
}

async function callTool(
  id: Id,
  params: Record<string, unknown>,
  tools: McpTools,
): Promise<JsonRpcResponse> {
  const tool = TOOLS.find((t) => t.name === params.name);
  const args = "arguments" in params ? params.arguments : {};
  if (tool === undefined || !isObject(args)) return invalidParams(id);
  const checked = checkArgs(args, tool);
  let result: ToolResult;
  if ("error" in checked) {
    result = { text: checked.error, isError: true };
  } else {
    try {
      result = await runTool(tools, tool.name, checked.values);
    } catch {
      result = { text: "The tool failed. Try again shortly.", isError: true };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    },
  };
}

/** The answer to one parsed message, or null for a notification (answered 202, no body). */
export async function handleMessage(
  msg: unknown,
  ctx: { tools: McpTools; version: string },
): Promise<JsonRpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return invalidRequest();
  }
  if (!("id" in msg)) return null;
  const id = msg.id;
  if (!isId(id)) return invalidRequest();
  const params = "params" in msg ? msg.params : {};
  if (!isObject(params)) return invalidParams(id);

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      if (typeof asked !== "string") return invalidParams(id);
      const known = (PROTOCOL_VERSIONS as readonly string[]).includes(asked);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: known ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "game-companion", version: ctx.version },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call":
      return callTool(id, params, ctx.tools);
    default:
      return failure(id, -32601, "Method not found");
  }
}

/** Whether `header` is `Bearer <token>`; equal lengths are compared in constant time. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const m = /^bearer (.*)$/is.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1] as string, "utf8");
  const wanted = Buffer.from(token, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** An absent `mcp-protocol-version` header is allowed (the client predates it). */
export const protocolVersionOk = (header: string | undefined): boolean =>
  header === undefined || (PROTOCOL_VERSIONS as readonly string[]).includes(header);
