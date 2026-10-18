# companion-agent

Answers the game companion's **Ask** questions with Claude Code. For each question the service
runs `claude -p` headless in a locked-down process: the player's guide and game status through
the companion's MCP endpoint, read-only RetroAchievements, RomM, Syncthing and Outline MCP tools,
web search and fetch, a shell for the redlib skill, and nothing that writes. The answer streams
back to the companion as NDJSON events.

The service is a small Node HTTP server with no runtime dependencies; Claude Code is installed in
the image at a pinned version.

## Upstream

- **Repository**: none. This directory is the source.
- **Version**: v0.1.0

## Usage

```bash
docker run --rm -p 8080:8080 \
  -e AGENT_TOKEN=... -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e COMPANION_MCP_URL=http://game-companion.games.svc:8080/companion/mcp \
  -e COMPANION_MCP_TOKEN=... \
  -v /path/to/redlib-plugin:/agent/skills/redlib:ro \
  ghcr.io/sharkusmanch/containers/companion-agent:v0.1.0
```

In the cluster it runs as non-root (uid 10000) with a read-only root filesystem, `emptyDir`
volumes at `/home/agent` and `/tmp`, and no service-account token.

## Environment Variables

| Variable                    | Required | Description                                                                                   |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `AGENT_TOKEN`               | Yes      | Bearer token the companion sends to `POST /ask`                                               |
| `CLAUDE_CODE_OAUTH_TOKEN`   | Yes      | Claude subscription token for `claude -p`                                                     |
| `HOME`                      | Yes      | Writable directory (image default `/home/agent`); each question gets its own HOME inside it   |
| `COMPANION_MCP_URL`         | No       | The companion's MCP endpoint. Needs `COMPANION_MCP_TOKEN`                                     |
| `COMPANION_MCP_TOKEN`       | No       | Bearer token for `COMPANION_MCP_URL`                                                          |
| `RETROACHIEVEMENTS_MCP_URL` | No       | RetroAchievements MCP server (no token)                                                       |
| `ROMM_MCP_URL`              | No       | RomM MCP server. Needs `ROMM_MCP_TOKEN`                                                       |
| `ROMM_MCP_TOKEN`            | No       | Bearer token for `ROMM_MCP_URL`                                                               |
| `SYNCTHING_MCP_URL`         | No       | Syncthing MCP server. Needs `SYNCTHING_MCP_TOKEN`                                             |
| `SYNCTHING_MCP_TOKEN`       | No       | Bearer token for `SYNCTHING_MCP_URL`                                                          |
| `OUTLINE_MCP_URL`           | No       | Outline MCP server. Needs `OUTLINE_API_KEY`                                                   |
| `OUTLINE_API_KEY`           | No       | Bearer token for `OUTLINE_MCP_URL` (a read-only key)                                          |
| `REDLIB_URL`                | No       | Redlib instance the redlib skill reads Reddit through                                         |
| `AGENT_MODEL`               | No       | Model for `claude --model` (default `opus`)                                                   |
| `AGENT_PROJECT_DIR`         | No       | claude's working directory, holding the house rules in `CLAUDE.md` (default `/agent/project`) |
| `AGENT_SKILLS_DIR`          | No       | The redlib plugin directory, mounted read-only (default `/agent/skills/redlib`)               |
| `AGENT_TIMEOUT_MS`          | No       | Longest a question may run before its process group is killed (default `180000`)              |
| `TZ`, `LANG`                | No       | Passed to claude when set                                                                     |
| `PORT`                      | No       | Listening port (default `8080`)                                                               |
| `CLAUDE_BIN`                | No       | The `claude` executable (default `claude`; the tests point it at a fake)                      |

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
  --plugin-dir <AGENT_SKILLS_DIR> [--append-system-prompt <instructions>] -- <prompt>
```

- **Tools.** Never Agent/Task, Write, Edit or NotebookEdit. MCP tools are allowed by exact name
  from `allowed-tools.json`; anything else an MCP server offers (its write tools) is denied by
  `dontAsk`. The built-in list is the `BUILTIN_TOOLS` constant in `src/argv.ts`.
- **House rules.** claude runs in `AGENT_PROJECT_DIR`, so its `CLAUDE.md` loads as project
  memory. The image ships a default (`project/CLAUDE.md`); the deploy mounts its own copy. Only
  when that folder has no `CLAUDE.md` is the request's `instructions` passed with
  `--append-system-prompt`.
- **Skills.** `--plugin-dir` loads the redlib plugin; Claude Code reports it as `redlib@inline`
  with the skill `redlib:browsing-reddit-via-redlib`. The `Skill` tool is what shows the model
  the skill list: without it the model sees no skills at all, and with it the model also sees
  Claude Code's built-in skills (house rules tell it to use only redlib). To drop skills, remove
  `Skill` from `BUILTIN_TOOLS`. The child's `CLAUDE_PLUGIN_ROOT` is `AGENT_SKILLS_DIR`, so the
  skill's `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/redlib.py` works in the shell.
- **Prompt.** The status block, earlier questions and answers, `Answer depth: <depth>`,
  `Guide hub id: <hub or none>`, then `Question: <question>`.
- **Process.** stdin is `/dev/null`; claude runs in its own process group with an allowlisted
  environment (`PATH`, `LANG`, `TZ`, `CLAUDE_CODE_OAUTH_TOKEN`, `REDLIB_URL`, its own `HOME`;
  never `AGENT_TOKEN` or the MCP tokens). Claude Code runs each Bash command in a session of its
  own, which a process-group kill does not reach, so the run's processes are found by their
  `HOME` (unique per run, read from `/proc/<pid>/environ`). When the client disconnects, the
  question times out or the service shuts down, the group and every process with that `HOME` get
  SIGTERM, then SIGKILL after 3 s. After claude exits, anything still running with that `HOME`
  (a background command) is killed the same way; then the run's HOME is removed and its slot
  freed.
- **What the screen shows.** Text streams as it arrives, except a short text block (280
  characters or less) followed by a tool call, which is narration and dropped. Tool calls show
  as: `Searched your guide: …`, `Read guide: page › section`, `Checked your guide` (other
  companion tools), `RomM: search roms` and the like for the other MCP servers, a `search`
  event for WebSearch, `Opened: <host>` for WebFetch and `Ran a command` for the shell. Read,
  Grep, Glob and Skill show nothing. An error result ends the answer with "The assistant is
  unavailable right now. Try again in a minute.", and a refusal with "I can't help with that
  one."

## Logging

One JSON line per question: outcome, duration, turns, tool calls by name, the result subtype,
`total_cost_usd` and token totals. Question, answer and tool input text never appear in a log
line. Refused requests are logged by status code only.

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
