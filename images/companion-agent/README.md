# companion-agent

Answers the game companion's **Ask** questions with Claude Code. For each question the service
runs `claude -p` headless in a locked-down process: the player's guide and game status through
the companion's MCP endpoint, read-only RetroAchievements, RomM, Syncthing and Outline MCP tools,
web search and fetch, a shell for the skill plugins (redlib, vibepollo), and nothing that writes. The answer streams
back to the companion as NDJSON events.

The service is a small Node HTTP server with no runtime dependencies; Claude Code is installed in
the image at a pinned version.

## Upstream

- **Repository**: none. This directory is the source.
- **Version**: v0.2.0

## Usage

```bash
docker run --rm -p 8080:8080 \
  -e AGENT_TOKEN=... -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e COMPANION_MCP_URL=http://game-companion.games.svc:8080/companion/mcp \
  -e COMPANION_MCP_TOKEN=... \
  -v /path/to/redlib-plugin:/agent/skills/redlib:ro \
  -v /path/to/vibepollo-plugin:/agent/skills/vibepollo:ro \
  -e AGENT_SKILLS_DIRS=/agent/skills/redlib,/agent/skills/vibepollo \
  -e AGENT_CHILD_ENV=VIBEPOLLO_TOKEN,VIBEPOLLO_HOST -e VIBEPOLLO_TOKEN=... -e VIBEPOLLO_HOST=... \
  ghcr.io/sharkusmanch/containers/companion-agent:v0.2.0
```

In the cluster it runs as non-root (uid 10000) with a read-only root filesystem, `emptyDir`
volumes at `/home/agent` and `/tmp`, and no service-account token.

## Environment Variables

| Variable                    | Required | Description                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TOKEN`               | Yes      | Bearer token the companion sends to `POST /ask`                                                                                                                                                                                                                                                                                                                                                     |
| `CLAUDE_CODE_OAUTH_TOKEN`   | Yes      | Claude subscription token for `claude -p`                                                                                                                                                                                                                                                                                                                                                           |
| `HOME`                      | Yes      | Writable directory (image default `/home/agent`); each question gets its own HOME inside it                                                                                                                                                                                                                                                                                                         |
| `COMPANION_MCP_URL`         | No       | The companion's MCP endpoint. Needs `COMPANION_MCP_TOKEN`                                                                                                                                                                                                                                                                                                                                           |
| `COMPANION_MCP_TOKEN`       | No       | Bearer token for `COMPANION_MCP_URL`                                                                                                                                                                                                                                                                                                                                                                |
| `RETROACHIEVEMENTS_MCP_URL` | No       | RetroAchievements MCP server (no token)                                                                                                                                                                                                                                                                                                                                                             |
| `ROMM_MCP_URL`              | No       | RomM MCP server. Needs `ROMM_MCP_TOKEN`                                                                                                                                                                                                                                                                                                                                                             |
| `ROMM_MCP_TOKEN`            | No       | Bearer token for `ROMM_MCP_URL`                                                                                                                                                                                                                                                                                                                                                                     |
| `SYNCTHING_MCP_URL`         | No       | Syncthing MCP server. Needs `SYNCTHING_MCP_TOKEN`                                                                                                                                                                                                                                                                                                                                                   |
| `SYNCTHING_MCP_TOKEN`       | No       | Bearer token for `SYNCTHING_MCP_URL`                                                                                                                                                                                                                                                                                                                                                                |
| `OUTLINE_MCP_URL`           | No       | Outline MCP server. Needs `OUTLINE_API_KEY`                                                                                                                                                                                                                                                                                                                                                         |
| `OUTLINE_API_KEY`           | No       | Bearer token for `OUTLINE_MCP_URL` (a read-only key)                                                                                                                                                                                                                                                                                                                                                |
| `REDLIB_URL`                | No       | Redlib instance the redlib skill reads Reddit through                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_MODEL`               | No       | Model for `claude --model` (default `opus`)                                                                                                                                                                                                                                                                                                                                                         |
| `AGENT_PROJECT_DIR`         | No       | claude's working directory, holding the house rules in `CLAUDE.md` (default `/agent/project`)                                                                                                                                                                                                                                                                                                       |
| `AGENT_SKILLS_DIRS`         | No       | Comma-separated plugin directories, each loaded with its own `--plugin-dir` (e.g. `/agent/skills/redlib,/agent/skills/vibepollo`). Wins over `AGENT_SKILLS_DIR`                                                                                                                                                                                                                                     |
| `AGENT_SKILLS_DIR`          | No       | One plugin directory, used only when `AGENT_SKILLS_DIRS` is unset (default `/agent/skills/redlib`)                                                                                                                                                                                                                                                                                                  |
| `AGENT_CHILD_ENV`           | No       | Comma-separated names (`^[A-Z][A-Z0-9_]*$`) copied from the service environment into the claude child, on top of the fixed list (e.g. `VIBEPOLLO_TOKEN,VIBEPOLLO_HOST`). The service refuses to start on a name it controls (`HOME`, `PATH`, `LANG`, `TZ`, `CLAUDE_CODE_OAUTH_TOKEN`, `REDLIB_URL`, `CLAUDE_PLUGIN_ROOT`, `ENABLE_TOOL_SEARCH`, ...), on `AGENT_TOKEN`, or on an MCP token variable |
| `AGENT_TIMEOUT_MS`          | No       | Longest a question may run before its process group is killed (default `180000`)                                                                                                                                                                                                                                                                                                                    |
| `TZ`, `LANG`                | No       | Passed to claude when set                                                                                                                                                                                                                                                                                                                                                                           |
| `PORT`                      | No       | Listening port (default `8080`)                                                                                                                                                                                                                                                                                                                                                                     |
| `CLAUDE_BIN`                | No       | The `claude` executable (default `claude`; the tests point it at a fake)                                                                                                                                                                                                                                                                                                                            |

An MCP server is configured only when its URL is set. The service refuses to start when a
configured server lacks its token, or when `allowed-tools.json` allows none of its tools.

## Endpoints

- `GET /healthz` → `{"ok":true}`.
- `POST /ask` with `authorization: Bearer <AGENT_TOKEN>` and a JSON body of at most 64 KiB:
  `{"instructions", "statusBlock", "history": [{"question", "answer"}], "question",
"depth": "hint"|"full", "hub": string|null}`. Answers `200 application/x-ndjson` with one event
  per line: `text`, `search`, `lookup`, `ping` (every 15 s while nothing else was sent), and
  exactly one `done` (`{"type":"done","truncatedGuide":false}`) or `error` at the end. `401` for a
  missing or wrong token, `413` for a larger body, `400` for an invalid one, and
  `429 {"error":"busy"}` while two questions are already running.

## How a question runs

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --model <AGENT_MODEL> --mcp-config <file> --strict-mcp-config
  --tools Bash,WebSearch,WebFetch,Read,Grep,Glob,Skill
  --allowedTools <those tools + every allowlisted mcp__<server>__<tool>>
  --permission-mode dontAsk --no-session-persistence --setting-sources user,project
  --plugin-dir <each of AGENT_SKILLS_DIRS> [--append-system-prompt <instructions>] -- <prompt>
```

- **Tools.** Never Agent/Task, Write, Edit or NotebookEdit. MCP tools are allowed by exact name
  from `allowed-tools.json`; anything else an MCP server offers (its write tools) is denied by
  `dontAsk`. The built-in list is the `BUILTIN_TOOLS` constant in `src/argv.ts`.
- **House rules.** claude runs in `AGENT_PROJECT_DIR`, so its `CLAUDE.md` loads as project
  memory. The image ships a default (`project/CLAUDE.md`); the deploy mounts its own copy. Only
  when that folder has no `CLAUDE.md` is the request's `instructions` passed with
  `--append-system-prompt`.
- **Skills.** Each plugin directory gets its own `--plugin-dir`; Claude Code reports them as
  `redlib@inline` (skill `redlib:browsing-reddit-via-redlib`), `vibepollo@inline` (skill
  `vibepollo:operating-vibepollo`) and so on. The `Skill` tool is what shows the model the skill
  list: without it the model sees no skills at all, and with it the model also sees Claude Code's
  built-in skills (house rules tell it which to use). To drop skills, remove `Skill` from
  `BUILTIN_TOOLS`. The service does not set `CLAUDE_PLUGIN_ROOT`: Claude Code 2.1.302 expands
  `${CLAUDE_PLUGIN_ROOT}` inside each skill's text to that plugin's own directory when the skill
  loads (verified with two `--plugin-dir`s: the model is handed the absolute path, and the
  variable is unset in the Bash environment), so `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/redlib.py`
  and the vibepollo script each resolve to their own plugin. A skill's script reads its own
  settings from the child environment: the redlib skill `REDLIB_URL` (always passed), the
  vibepollo skill `VIBEPOLLO_TOKEN` (a read-only token) and optionally `VIBEPOLLO_HOST`,
  `VIBEPOLLO_PORT` and `VIBEPOLLO_CERT_SHA256`, which the deploy lists in `AGENT_CHILD_ENV` and
  sets on the service.
- **Prompt.** The status block, earlier questions and answers, `Answer depth: <depth>`,
  `Guide hub id: <hub or none>`, then `Question: <question>`.
- **Process.** stdin is `/dev/null`; claude runs in its own process group with an allowlisted
  environment (`PATH`, `LANG`, `TZ`, `CLAUDE_CODE_OAUTH_TOKEN`, `REDLIB_URL`, the names listed in
  `AGENT_CHILD_ENV`, its own `HOME`). `AGENT_TOKEN` and the MCP tokens are not in the child's
  environment, but the child runs as the same uid as the server, so a shell command can still
  read them (`/proc/<pid>/environ`, the MCP config file). That is an accepted risk: the tokens
  are scoped (read-only tools, or a GET-only token). Claude Code runs
  each Bash command in a session of its own, which a process-group kill does not reach, so the
  run's processes are found by their `HOME` (unique per run, read from `/proc/<pid>/environ`).
  When the client disconnects, the question times out or the service shuts down, the group and
  every process with that `HOME` get SIGTERM, then SIGKILL after 3 s. After claude exits,
  anything still running with that `HOME` (a background command) is killed the same way; then
  the run's HOME is removed and its slot freed.
- **Plugin directories.** A plugin directory must contain only skills and scripts: no hooks,
  agents, commands or `.mcp.json`. Hooks run outside the tool allowlist, so a plugin that ships
  one would escape it.
- **What the screen shows.** Text streams as it arrives, except a short text block (280
  characters or less) followed by a tool call, which is narration and dropped. Tool calls show
  as: `Searched your guide: …`, `Read guide: page › section`, `Checked your guide` (other
  companion tools), `RomM: search roms` and the like for the other MCP servers, a `search`
  event for WebSearch, `Opened: <host>` for WebFetch and `Ran a command` for the shell. Read,
  Grep, Glob and Skill show nothing. An error result ends the answer with "The assistant is
  unavailable right now. Try again in a minute.", and a refusal with "I can't help with that
  one."

## Logging

At startup one `listening` line names the plugin directories found (`skills`, by basename) and
those missing (`skillsMissing`). One JSON line per question: outcome, duration, turns, tool
calls by name, the result subtype, `total_cost_usd` and token totals. Question, answer and tool
input text never appear in a log line. Refused requests are logged by status code only.

## Development

```bash
npm ci
npm test          # vitest; a fake claude (test/fake-claude.mjs) replays recorded stream-json
npm run typecheck && npm run lint && npm run format:check
npm run build     # compiles to dist/
```

The fixtures in `test/fixtures` were recorded with Claude Code 2.1.302 and scrubbed. `.ci-test`
runs the same checks in CI before the image is built. Bump `COMPANION_AGENT_VERSION` in the
`Dockerfile` for every change that should ship.

## Modifications from Upstream

- None. Original code.
