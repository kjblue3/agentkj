# AGENTS.md

This file is the shared source of truth for Claude Code and Codex working together on this
repository. It describes what this codebase actually is, right now — not an aspirational or
templated architecture. If you're an agent picking up work here, read this before touching code.

## What this is

**Slack Detective**: a Slack-native investigation bot. A user asks a question ("why did checkout
latency spike?", "why is my game all red?") and it produces an evidence-backed report (root cause,
confidence, citations, timeline) by pulling from GitHub, Slack, and other connectors.

Stack: Node + TypeScript (ESM, `"type": "module"`), Express, `@slack/bolt` in **Socket Mode** (no
public URL needed for Slack itself), `openai` npm SDK (pointed at either OpenAI or Groq), Zod for
schema validation, Vitest for tests. No database — everything is in-memory (see "Known
tradeoffs" below).

## Architecture

### Two investigation paths, one entry point

`src/investigation/pipeline.ts` (`InvestigationPipeline.investigate(question, opts?)`) is the only
entry point both `src/api/server.ts` (`POST /investigate`) and `src/slack/app.ts` (`/detective`,
`app_mention`) call. It picks one of two paths:

1. **Agentic path** (`src/agent/investigator.ts`, `AgentInvestigator`) — used whenever an LLM is
   configured (`AGENT_ENABLED !== "false"` and `LLM_API_KEY`/`OPENAI_API_KEY` set). This is a real
   tool-calling loop: the LLM gets tool schemas (`search_code`, `search_issues`,
   `list_recent_commits`, `get_commit`, `read_file`, `search_slack`, plus any MCP-registry tools),
   calls them (in parallel, up to `MAX_ITERATIONS`), reads the results, and keeps going until it
   calls `finish` with a structured verdict. This is what lets it answer "why is my game all red"
   by reading an actual commit diff that set an RGB value — it isn't matching the word "red"
   against anything, it's inspecting recent commits because the system prompt tells it to.
2. **Classic path** (`InvestigationPipeline.classicInvestigate`, unchanged from the original
   hackathon build) — literal keyword search across connectors (`src/connectors/*`), ranked by
   `src/investigation/ranker.ts`, narrated by `src/openai/synthesizer.ts`'s
   `responses.create`-based `ReportSynthesizer` (falls back to deterministic
   `src/investigation/fallbackSynthesis.ts` prose if no LLM key at all). This only ever sees
   issues + current file contents — **never commit history/diffs** — which is precisely the class
   of bug the agentic path was built to fix. Kept as the no-LLM-key fallback and for
   `AGENT_ENABLED=false`.

Why two paths instead of replacing the old one: the classic path needs zero configuration (no LLM
key at all) and is what keeps `/demo/questions` and tests deterministic.

### Why `chat.completions`, not `responses`

`src/openai/synthesizer.ts` uses OpenAI's `responses.create` API. **Groq does not implement that
API** — only `chat.completions.create`, which is OpenAI-compatible. So the agent loop
(`src/agent/investigator.ts`) is built entirely on `chat.completions.create` + `tools`, and
`src/llm/client.ts` just swaps `baseURL` to point the same `openai` SDK at Groq or OpenAI. Provider
choice is a config decision (`LLM_BASE_URL`), not a code fork.

### Per-user GitHub, not one shared repo

The original build pointed at one hardcoded `GITHUB_OWNER`/`GITHUB_DEMO_REPO` via a shared
`GITHUB_TOKEN`. That's still the fallback (used for `/investigate` with no per-user token, and by
`app_mention`), but each Slack user can instead connect **their own** GitHub account:

- `src/auth/githubOAuth.ts` registers `GET /auth/github` (redirect to GitHub's OAuth authorize
  screen, `state` = Slack user id) and `GET /auth/github/callback` (exchanges the code for a token,
  fetches the login, stores it).
- `src/auth/tokenStore.ts` is an in-memory `Map<slackUserId, {token, login}>` (see tradeoffs below).
- `src/slack/app.ts`'s `/detective` handler looks up the caller's token; if absent, it replies with
  a connect link (`${PUBLIC_BASE_URL}/auth/github?state=<slackUserId>`) instead of investigating.
- When a token is present, `pipeline.investigate(question, { githubToken, githubLogin, owner?,
  repo? })` is called with **no fixed owner/repo** unless the user typed a leading `owner/repo`
  token in their question (`parseOwnerRepo` in `src/slack/app.ts`) — the agent then searches across
  everything `login`'s token can see (`user:<login>` GitHub search qualifier, see
  `scopeQualifier()` in `investigator.ts`) rather than one hardcoded repo.

This requires a public HTTP callback endpoint for GitHub to redirect to
(`GET /auth/github/callback`), even though **Slack itself stays on Socket Mode** — those two are
orthogonal. In dev, tunnel just that one route with `ngrok http 3000` and set `PUBLIC_BASE_URL` to
the ngrok URL; Slack's websocket connection is unaffected.

### Self-service pluggable connectors (MCP)

Goal: a user can attach a product the team never wrote a connector for (Sheets, Notion, Forms...)
themselves, with no redeploy. This works because Model Context Protocol servers self-describe their
own tools (`tools/list` → name, description, JSON-Schema input) — see `src/connectors/mcpClient.ts`
(`StdioMcpClient.listTools()`).

- `src/mcp/registry.ts` (`McpToolRegistry`) spawns a list of MCP server specs, discovers their
  tools, **namespaces** them (`serverName__toolName`) so two servers can't collide, and exposes
  `listAgentTools()` (flat `ChatCompletionTool[]`) + `call(name, args)` dispatch. These get merged
  straight into the agent's toolbox via `AgentContext.externalTools`/`externalCall` in
  `src/agent/investigator.ts` — the agent loop has no idea these aren't "native" tools.
- Two tiers of specs, both consumed by the same registry class:
  - **Global/admin** (`loadGlobalServerSpecs`): from `MCP_SERVERS` env (JSON array) or `mcp.json` at
    repo root. Available to every user. Only an admin can edit these.
  - **Per-user self-service** (`src/mcp/catalog.ts` + `/detective connect`/`connectors` in
    `src/slack/app.ts`): a user picks a **vetted catalog entry** (fixed `command`, e.g. the
    filesystem MCP server) and supplies only credential values, never a command. Stored via
    `setUserConnector`/`listUserConnectors` in `tokenStore.ts`, turned into an `McpToolRegistry` on
    demand in `src/slack/app.ts` (`userMcpRegistry`).

**Why the catalog, not free-form commands**: a stdio MCP "server" is `spawn(command, {shell:true})`
— an arbitrary local command. Letting any Slack user register an arbitrary command on a shared host
is remote code execution. The catalog model closes that off: the `command` is always fixed and
vetted by whoever maintains `src/mcp/catalog.ts`; the user only ever supplies credential *values*
(`credentialFields`), which get passed as that one child process's env (`StdioMcpClient`'s
`extraEnv` constructor param — merged as `{...process.env, ...extraEnv}` only for that spawn, so two
users' credentials for the same connector type never collide via a shared `process.env`). Free-form
local stdio specs would be fine for a single-user self-hosted install (Bob runs his own copy for
himself) but must never be exposed to arbitrary users on a shared deployment. Remote HTTP/SSE MCP
transport (a URL, no local spawn) would be the safer way to get true free-form self-service later,
but isn't implemented — the current client is stdio-only.

## Key files

| File | Role |
|---|---|
| `src/app.ts` | Wires everything together: connectors, `McpToolRegistry` (global), `InvestigationPipeline`, Express API, Slack app. Entry point for `npm run dev`/`start`. |
| `src/investigation/pipeline.ts` | `InvestigationPipeline` — picks agentic vs. classic path. |
| `src/agent/investigator.ts` | `AgentInvestigator` — the tool-calling loop. |
| `src/github/githubRest.ts` | `GitHubRest` — thin REST client, token passed in per-instance (works for both the shared demo token and per-user OAuth tokens). Includes `getCommit` (returns diffs) — the capability the old connectors lacked. |
| `src/llm/client.ts` | `createLlmClient`/`llmModel` — provider-agnostic (Groq/OpenAI) `openai` client construction. |
| `src/auth/tokenStore.ts` | In-memory per-Slack-user GitHub tokens + connected MCP catalog entries. |
| `src/auth/githubOAuth.ts` | `GET /auth/github`, `GET /auth/github/callback` — the OAuth web flow. |
| `src/mcp/registry.ts` | `McpToolRegistry` — spawns MCP servers, discovers + namespaces tools, dispatches calls. |
| `src/mcp/catalog.ts` | Vetted list of connectable products for self-service (fixed command, user supplies credentials only). |
| `src/connectors/mcpClient.ts` | `StdioMcpClient` — spawns and talks JSON-RPC to one MCP server over stdio. |
| `src/connectors/*Connector.ts` | Classic-path evidence connectors (keyword search only). |
| `src/openai/synthesizer.ts` | Classic-path narration (`responses.create`; OpenAI only, not Groq). |
| `src/slack/app.ts` | Slack commands/events: `/detective` (+ `connect`/`connectors` subcommands), `app_mention`, block actions. |
| `src/api/server.ts` | Express app: `/health`, `/investigate`, `/evidence/:id`, `/demo/questions`, mounts OAuth routes. |
| `src/types/schemas.ts` | Zod schemas (`EvidenceItem`, `InvestigationResult`, etc.) — `investigationResultSchema.parse(...)` is the final validation gate for *any* investigate() result, agentic or classic. |

## Env vars

See `.env.example` for the full annotated list. New in the agentic/OAuth/MCP work: `LLM_API_KEY`,
`LLM_BASE_URL`, `LLM_MODEL`, `AGENT_ENABLED`, `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `GITHUB_OAUTH_SCOPES`, `MCP_SERVERS`.
`OPENAI_API_KEY`/`OPENAI_MODEL` still work as a back-compat fallback for `LLM_API_KEY`/`LLM_MODEL`.

## Commands

- `npm run dev` — run with `tsx watch`.
- `npm run build` — `tsc -p tsconfig.json`.
- `npm test` / `npm run test:watch` — Vitest.
- `npm run check` — build + test; run this before considering a change done.
- `npm run seed`, `seed:github-demo`, `seed:slack-demo` — seed demo data.

## Known tradeoffs (deliberate, hackathon-scope)

- **No persistence**: `tokenStore.ts` (GitHub tokens, connected MCP catalog entries) and
  `reportCache.ts` are in-memory `Map`s — everything is lost on process restart. No encryption at
  rest. Fine for a hackathon demo; would need a real datastore before any real deployment.
- **Classic path never reads commit diffs**: this is intentional — it's the deterministic,
  zero-config fallback, not a second attempt at the same capability the agent has.
- **MCP self-service is catalog-only, not free-form**: see the RCE discussion above.

## Conventions for agents working on this repo

- Match existing style: no unnecessary comments, prefer small focused functions, reuse
  `connectorUtils.ts` helpers (`fetchJson`, `normalizeEvidenceItem`, `truncate`) instead of
  reimplementing fetch/truncation logic.
- Any change to what an `investigate()` call can return must still satisfy
  `investigationResultSchema` in `src/types/schemas.ts`.
- Don't put secrets in code or commit `.env` — it's gitignored; `.env.example` documents shape only.
- Run `npm run check` before calling a change done.
