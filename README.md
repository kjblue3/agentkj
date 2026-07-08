# Slack Detective

**Tagline:** Scattered clues in. Evidence-backed answers out.

Slack Detective investigates workplace questions whose answers are split across chat, code, tickets, docs, and incident reports. Ask `/detective Why did checkout latency spike?` and it searches every source, ranks the clues, reconstructs the causal timeline, and returns a concise Slack-native report with citations and actions.

Local search and synthesis work without paid services. Production-style Slack, GitHub through MCP, Jira, Google Drive, incident connectors, public-link reading, and experimental remote MCP connections can be enabled while preserving the deterministic demo fallback.

## What the demo includes

- `/detective` and `@Slack Detective` entry points
- Block Kit “Detective Report” with evidence, timeline, confidence, and next moves
- Interactive **Show evidence**, **Show timeline**, **Create follow-up**, and **Mark solved** actions
- Replaceable real connectors for Slack, GitHub MCP, GitHub REST fallback, Jira, Google Docs/Drive, and incident reports
- Public URL reading without creating a permanent connector
- User-supplied remote MCP URL inspection, explicit approval, secure credential entry, and personal/shared/delegated use
- Keyword, entity, tag, recency, confidence, and source-authority ranking
- Optional OpenAI report polishing with deterministic fallback
- Express API and a realistic 18-record ecommerce dataset
- Three complete investigations, not one hardcoded response

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm install
npm run seed
npm run dev
```

No credentials are required for API-only demo mode. Try:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/demo/questions
curl -X POST http://localhost:3000/investigate ^
  -H "Content-Type: application/json" ^
  -d "{\"question\":\"Why did checkout latency spike?\"}"
```

PowerShell equivalent:

```powershell
Invoke-RestMethod http://localhost:3000/investigate `
  -Method Post `
  -ContentType application/json `
  -Body '{"question":"Why did checkout latency spike?"}'
```

The JSON response includes `sourceMode` and `connectors`, so judges can see whether a report came from demo, hybrid, or real connector mode.

## Slack setup

1. Create a Slack app from [manifest.json](./manifest.json).
2. Create an app-level token with `connections:write`.
3. Copy `.env.example` to `.env`.
4. Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET`.
5. Run `npm run dev`, then use `/detective` or mention the bot.

Socket Mode means the Slack websocket itself does not need a public tunnel. Set `PUBLIC_BASE_URL`
only when using GitHub OAuth or the backend connector credential/setup forms.

## Optional OpenAI setup

Set `OPENAI_API_KEY` to enable final report polishing. `OPENAI_MODEL` defaults to `gpt-4.1-mini`. Search and ranking remain local, and any API error automatically falls back to deterministic synthesis.

## Connector setup

`CONNECTOR_MODE` controls evidence sources:

- `demo`: local bundled or `DATA_PATH` evidence only. This is the default.
- `real`: only configured production connectors. If none are configured, the app warns and falls back to demo evidence.
- `hybrid`: configured production connectors plus local evidence fallback.

Real connectors are configured through `.env` and skipped gracefully when credentials are missing:

- Slack: `SLACK_BOT_TOKEN`
- GitHub MCP sandbox: `MCP_GITHUB_ENABLED=true`, `MCP_GITHUB_COMMAND`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_DEMO_REPO`
- GitHub REST fallback: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPOS`
- Jira: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, optional `JIRA_PROJECTS`
- Google Drive: `GOOGLE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_ACCESS_TOKEN`, or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`
- Incidents: `INCIDENT_API_URL` and optional `INCIDENT_API_TOKEN`, or `INCIDENT_DATA_PATH`

See [CONNECTORS.md](./CONNECTORS.md) for credential creation, required scopes, verification steps, and common fixes.

For hackathon judging, `CONNECTOR_MODE=demo` is the safest default: it proves the full Slack workflow without relying on external accounts. The recommended live demo is `CONNECTOR_MODE=hybrid` with seeded Slack messages and a real `slack-detective-demo` GitHub sandbox repository queried through MCP.

## Dynamic connector demo

In Slack, users can:

- Paste a public `https://...` link in a question. The agent validates the URL, fetches bounded HTML/text, strips markup, treats the page as untrusted evidence, and does not save a connector.
- Run `@agentkj connect https://remote-mcp.example/mcp`. The app validates the URL against localhost/private/cloud-metadata SSRF targets, inspects advertised MCP tools, shows the connector name/URL/tools/scopes, and enables it only after `@agentkj approve ...`.
- Add `bearer` to approval when the remote service needs a token. The token is entered through `${PUBLIC_BASE_URL}/auth/connectors/...`, never pasted into Slack.
- Share approved connections with selected users or channels using `@agentkj share <connection-id> user <U...>` or `channel <C...>`. Every tool call rechecks user, channel, allowed tool, provider scope, read-only/read-write mode, and active approval.

Remote connector metadata is stored in `data/remoteConnections.local.json`; bearer credentials are in-memory only for the hackathon prototype.

## Real sandbox demo

Create or seed fictional checkout incident evidence into real Slack and GitHub objects:

```bash
npm run seed:github-demo
npm run seed:slack-demo
```

Required environment:

```env
CONNECTOR_MODE=hybrid
MCP_GITHUB_ENABLED=true
MCP_GITHUB_COMMAND=npx -y @modelcontextprotocol/server-github
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=your-user-or-org
GITHUB_DEMO_REPO=slack-detective-demo
SLACK_BOT_TOKEN=xoxb-...
DEMO_SLACK_CHANNEL_ID=C0123456789
```

The seeded content is fictional, but the GitHub repo, issues, PR, comments, files, Slack messages, API calls, MCP tool path, and evidence IDs are real. If any credential is missing, demo mode and local fallback evidence still work.

## Demo cases

1. **Why did checkout latency spike?** An N+1 tax lookup shipped, p95 rose, customers timed out, and rollback restored service.
2. **Why was the recommendations launch delayed?** A consent-aware data dependency slipped, blocking privacy approval and release.
3. **Why are we still using Redis for sessions?** Immediate revocation remains a hard requirement; alternatives have not removed that lookup without unacceptable tradeoffs.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/demo/questions` | Demo-ready prompts |
| POST | `/investigate` | Run a case with `{ "question": "..." }` |
| GET | `/evidence/:id` | Retrieve one normalized evidence record |

## Scripts

```bash
npm run seed       # write data/evidence.json
npm run seed:github-demo  # create/update fictional evidence in a real GitHub sandbox repo
npm run seed:slack-demo   # post fictional incident messages into a real Slack sandbox channel
npm run dev        # watch-mode API and optional Slack app
npm run build      # strict TypeScript compile
npm test           # Vitest suite
npm run check      # build and test
```

## Project structure

```text
src/
  api/             Express endpoints
  connectors/      Replaceable evidence adapters
  mcp/             Admin/catalog MCP registries and dynamic remote connection state
  security/        Public URL validation and secret redaction
  data/            Dataset, loader, and seed command
  investigation/   Parse, rank, cluster, timeline, fallback
  openai/          Optional synthesis
  slack/           Bolt listeners and Block Kit views
  types/           Zod schemas and inferred types
tests/             Ranking, normalization, pipeline, fallback, API
```

## Real versus demo

Implemented end to end: pipeline, normalized schemas, local multi-source search, production-style source connectors, ranking, timeline creation, fallback synthesis, OpenAI integration, API, Slack commands/events/actions, seed command, tests, and docs.

Demo mode reads the local dataset and needs no credentials. Real and hybrid modes search each configured external source directly through its connector, normalize the returned records, and preserve the same `search`/`getById` contract used by the pipeline.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [DEMO_SCRIPT.md](./DEMO_SCRIPT.md), and [SUBMISSION_NOTES.md](./SUBMISSION_NOTES.md).
