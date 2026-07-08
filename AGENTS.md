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
schema validation, Vitest for tests. No production database — hackathon state is split between
in-memory maps and gitignored local JSON files (see "Known tradeoffs" below).

## Architecture

### Two investigation paths, one entry point

`src/investigation/pipeline.ts` (`InvestigationPipeline.investigate(question, opts?)`) is the only
entry point both `src/api/server.ts` (`POST /investigate`) and `src/slack/app.ts` (`/detective`,
`app_mention`) call. It picks one of two paths:

1. **Agentic path** (`src/agent/investigator.ts`, `AgentInvestigator`) — used whenever an LLM is
   configured (`AGENT_ENABLED !== "false"` and `LLM_API_KEY`/`OPENAI_API_KEY` set). This is a real
   tool-calling loop: the LLM gets tool schemas (`search_code`, `search_issues`,
   `list_recent_commits`, `get_commit`, `read_file`, `search_slack`, plus any MCP-registry,
   public-web, or approved remote-connector tools), calls them (in parallel, up to
   `MAX_ITERATIONS`), reads the results, and keeps going until it
   calls `finish` with a structured verdict. This is what lets it answer "why is my game all red"
   by reading an actual commit diff that set an RGB value — it isn't matching the word "red"
   against anything, it's inspecting recent commits because the system prompt tells it to.
2. **Classic path** (`InvestigationPipeline.classicInvestigate`, mostly unchanged from the original
   hackathon build) — literal keyword search across connectors (`src/connectors/*`), ranked by
   `src/investigation/ranker.ts`, narrated by `src/openai/synthesizer.ts`'s
   `responses.create`-based `ReportSynthesizer` (falls back to deterministic
   `src/investigation/fallbackSynthesis.ts` prose if no LLM key at all). This only ever sees
   issues + current file contents — **never commit history/diffs** — which is precisely the class
   of bug the agentic path was built to fix. Kept as the no-LLM-key fallback and for
   `AGENT_ENABLED=false`. If the request contains a public URL but no agent LLM is available,
   `publicLinkInvestigate` fetches that one page and synthesizes from it without creating a
   permanent connector.

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
- `src/auth/tokenStore.ts` keeps a per-Slack-user token map and persists GitHub tokens under
  `STATE_DIR` (`data/` by default) so development restarts don't disconnect everyone (see
  tradeoffs below).
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

### Public links and self-service pluggable connectors

Goal: a user can paste a public link or attach a product the team never wrote a connector for
(Sheets, Notion, Forms, Strava...) with no redeploy.

**Public links** are one-request tools, not durable connectors:

- `src/connectors/publicWebTool.ts` detects an `http(s)` URL, validates it with
  `src/security/publicUrl.ts`, fetches at most 1 MB of HTML/text, strips scripts/styles/tags, and
  exposes the content as untrusted evidence.
- `src/investigation/pipeline.ts` also has a deterministic public-link fallback for no-agent mode.

**MCP connectors** rely on MCP self-description (`tools/list` → name, description, JSON-Schema
input):

- `src/mcp/registry.ts` (`McpToolRegistry`) handles admin/global and vetted catalog **stdio** MCP
  servers. It namespaces tool names (`serverName__toolName`), exposes `listAgentTools()` +
  `call(name, args)`, and redacts configured secret values before tool results are returned to the
  agent. `StdioMcpClient` also redacts configured env values from child-process stderr.
- `src/mcp/catalog.ts` remains the safe local-command model: users can pick a vetted fixed command,
  never a free-form command. Catalog setup values are collected through
  `/auth/catalog-connectors/:secret`, not pasted into Slack.
- `src/connectors/remoteMcpClient.ts` supports user-supplied **remote** MCP URLs over streamable
  HTTP. `src/security/publicUrl.ts` validates every URL/redirect and blocks localhost,
  private-network, link-local/cloud-metadata, multicast, reserved, and test-net addresses.
- `src/mcp/connections.ts` owns remote connector state. A user runs `@agentkj connect https://...`;
  the app validates and inspects the remote server, displays name/URL/tools/scopes as experimental
  and untrusted, then enables it only after `@agentkj approve ...`. Optional bearer credentials are
  entered via `/auth/connectors/:secret`, not Slack.

Remote connection scopes:

- **Personal**: owned by one Slack user, private by default, only delegated if the owner shares it.
- **Shared workspace**: intended for team-owned/service-account connectors, shareable with selected
  users, selected channels, or the workspace.

Every remote tool call rechecks the internal authorization model: requester, workspace/channel,
allowed tool name, read-only vs read-write mode, provider OAuth/API scopes advertised by the tool,
and active+approved status. Selection order is requester personal connection first, then approved
shared workspace connection, then explicitly delegated personal connection. The agent never silently
uses another person's private account.

Remote connector output is wrapped as experimental/untrusted data and redacted by key name
(`token`, `secret`, `authorization`, etc.) plus exact credential value before it can reach the LLM.
The system prompt also tells the agent not to follow instructions from webpages or connector output.

**Why local stdio still uses a catalog**: a stdio MCP "server" is `spawn(command, {shell:true})` —
an arbitrary local command. Letting Slack users register arbitrary local commands on a shared host is
remote code execution. Free-form self-service is only allowed for remote URLs after SSRF validation,
inspection, explicit approval, and per-call authorization.

## Key files

| File | Role |
|---|---|
| `src/app.ts` | Wires everything together: connectors, `McpToolRegistry` (global), `InvestigationPipeline`, Express API, Slack app. Entry point for `npm run dev`/`start`. |
| `src/investigation/pipeline.ts` | `InvestigationPipeline` — picks agentic vs. classic path. |
| `src/agent/investigator.ts` | `AgentInvestigator` — the tool-calling loop. |
| `src/github/githubRest.ts` | `GitHubRest` — thin REST client, token passed in per-instance (works for both the shared demo token and per-user OAuth tokens). Includes `getCommit` (returns diffs) — the capability the old connectors lacked. |
| `src/llm/client.ts` | `createLlmClient`/`llmModel` — provider-agnostic (Groq/OpenAI) `openai` client construction. |
| `src/agent/toolProvider.ts` | Common interface for dynamically supplied agent tools. |
| `src/auth/tokenStore.ts` | Per-Slack-user GitHub tokens + connected MCP catalog entries + short-lived catalog setup intents. |
| `src/auth/githubOAuth.ts` | `GET /auth/github`, `GET /auth/github/callback` — the OAuth web flow. |
| `src/auth/connectorCredentials.ts` | Backend-only credential/setup forms for remote and vetted catalog connectors. |
| `src/mcp/registry.ts` | `McpToolRegistry` — spawns vetted/admin stdio MCP servers, discovers + namespaces tools, dispatches calls. |
| `src/mcp/catalog.ts` | Vetted list of connectable products for self-service (fixed command, setup values collected via backend form). |
| `src/mcp/connections.ts` | Remote MCP connection inspection, approval, sharing, selection, authorization, metadata persistence, and credential vault. |
| `src/connectors/mcpClient.ts` | `StdioMcpClient` — spawns and talks JSON-RPC to one MCP server over stdio. |
| `src/connectors/remoteMcpClient.ts` | Remote streamable-HTTP MCP client with SSRF-safe fetch. |
| `src/connectors/publicWebTool.ts` | One-request public webpage reader/tool for pasted links. |
| `src/security/publicUrl.ts` | Public URL validation and redirect-safe fetch. |
| `src/security/redaction.ts` | Shared secret redaction for connector logs/tool results. |
| `src/connectors/*Connector.ts` | Classic-path evidence connectors (keyword search only). |
| `src/openai/synthesizer.ts` | Classic-path narration (`responses.create`; OpenAI only, not Groq). |
| `src/slack/app.ts` | Slack commands/events: `/detective` (+ `connect`/`connectors` subcommands), `app_mention`, block actions. |
| `src/api/server.ts` | Express app: `/health`, `/investigate`, `/evidence/:id`, `/demo/questions`, mounts OAuth routes. |
| `src/types/schemas.ts` | Zod schemas (`EvidenceItem`, `InvestigationResult`, etc.) — `investigationResultSchema.parse(...)` is the final validation gate for *any* investigate() result, agentic or classic. |

## Env vars

See `.env.example` for the full annotated list. New in the agentic/OAuth/MCP work: `LLM_API_KEY`,
`LLM_BASE_URL`, `LLM_MODEL`, `AGENT_ENABLED`, `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `GITHUB_OAUTH_SCOPES`, `MCP_SERVERS`.
`PUBLIC_BASE_URL` is also used for remote/catalog connector credential forms.
`HOST` controls the HTTP bind address, and `STATE_DIR` moves hackathon-persistent JSON state outside
the checkout for hosted deployments.
`OPENAI_API_KEY`/`OPENAI_MODEL` still work as a back-compat fallback for `LLM_API_KEY`/`LLM_MODEL`.

## Commands

- `npm run dev` — run with `tsx watch`.
- `npm run build` — `tsc -p tsconfig.json`.
- `npm test` / `npm run test:watch` — Vitest.
- `npm run check` — build + test; run this before considering a change done.
- `npm run seed`, `seed:github-demo`, `seed:slack-demo` — seed demo data.

## Known tradeoffs (deliberate, hackathon-scope)

- **Hackathon persistence only**: GitHub tokens and remote connection metadata are stored under
  `STATE_DIR` (`data/` by default); catalog connector credentials, remote bearer credentials,
  pending approval requests, and report cache are in-memory. Remote connections with credential
  refs are marked inactive after restart because the credential vault is not persisted. No
  encryption at rest. Fine for a hackathon demo; use a real secret manager/datastore before any
  real deployment.
- **Classic path never reads commit diffs**: this is intentional — it's the deterministic,
  zero-config fallback, not a second attempt at the same capability the agent has.
- **Remote connectors are experimental/untrusted**: the prototype validates public URLs and enforces
  approval/authorization, but it is not a production connector security model.

## Conventions for agents working on this repo

- Match existing style: no unnecessary comments, prefer small focused functions, reuse
  `connectorUtils.ts` helpers (`fetchJson`, `normalizeEvidenceItem`, `truncate`) instead of
  reimplementing fetch/truncation logic.
- Any change to what an `investigate()` call can return must still satisfy
  `investigationResultSchema` in `src/types/schemas.ts`.
- Don't put secrets in code or commit `.env` — it's gitignored; `.env.example` documents shape only.
- Run `npm run check` before calling a change done.
