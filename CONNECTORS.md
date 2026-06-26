# Slack Detective Connectors

Slack Detective keeps one investigation contract: every connector searches its own source and returns normalized `EvidenceItem` records. The LLM never searches Slack, GitHub, Jira, Google Drive, or incident systems directly.

## Connector Modes

Set `CONNECTOR_MODE` in `.env`:

```env
CONNECTOR_MODE=demo
```

- `demo`: bundled/local evidence only. This is the default and needs no credentials.
- `real`: production connectors only. If no real connector is configured, startup falls back to demo evidence with a warning.
- `hybrid`: production connectors first, then local demo connectors as a fallback.

Run:

```bash
npm run dev
```

Verify:

```bash
curl -X POST http://localhost:3000/investigate \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"Why did checkout latency spike?\"}"
```

On Windows `cmd`, replace the line continuations with `^`.

## Slack Messages

Environment:

```env
CONNECTOR_MODE=hybrid
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

Create credentials:

1. Create or update a Slack app from `manifest.json`.
2. Create an app-level token with `connections:write` for Socket Mode.
3. Install the app to the workspace and copy the bot token, app token, and signing secret.

Required scopes for evidence search:

- Search: `search:read`
- Public channels: `channels:read`, `channels:history`
- Private channels: `groups:read`, `groups:history`
- DMs and MPIMs if needed: `im:read`, `im:history`, `mpim:history`
- User metadata: `users:read`
- Existing app behavior: `commands`, `app_mentions:read`, `chat:write`

Verify:

Ask a question that uses words from a real Slack thread. Returned evidence IDs should start with `slack:`.

Seeded checkout demo:

```env
SLACK_BOT_TOKEN=xoxb-...
DEMO_SLACK_CHANNEL_ID=C0123456789
```

Run:

```bash
npm run seed:slack-demo
```

The command posts fictional checkout incident messages into the real sandbox channel and skips posting if the demo marker is already present. For the recommended hybrid demo, ask `/detective Why did checkout latency spike?` and confirm evidence includes real Slack IDs such as `slack:C...:<ts>`.

Common failures:

- `missing_scope`: add the scope, reinstall the Slack app, and update the token.
- Empty results: Slack search only returns content the installed token can access.
- Socket Mode disabled: set `SLACK_APP_TOKEN`; the HTTP API still works without it.

## GitHub MCP Sandbox

Environment:

```env
CONNECTOR_MODE=hybrid
MCP_GITHUB_ENABLED=true
MCP_GITHUB_COMMAND=npx -y @modelcontextprotocol/server-github
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=your-user-or-org
GITHUB_DEMO_REPO=slack-detective-demo
```

This is the recommended live demo path. Slack Detective seeds fictional checkout incident evidence into a real GitHub repository, then retrieves GitHub evidence through a real MCP GitHub server. The data is fake; the repo, issue, PR, labels, comments, files, MCP connection, and normalized `github:` evidence IDs are real.

Create credentials and seed:

1. In GitHub, create a fine-grained personal access token.
2. Scope it to `GITHUB_OWNER/GITHUB_DEMO_REPO`, or allow it to create that sandbox repo.
3. Grant read/write permissions for Issues, Pull requests, Contents, and Metadata.
4. Run `npm run seed:github-demo`.
5. Start the app with `CONNECTOR_MODE=hybrid` and the GitHub MCP server command configured.

What it searches:

- MCP GitHub issue and pull request search for the sandbox repo.
- MCP GitHub code/file search for seeded markdown context and checkout code artifacts.
- `getById` lookups for normalized GitHub issue and code evidence.

Verify:

Ask:

```text
Why did checkout latency spike?
```

Evidence should include connector `GitHub MCP`, source `github`, and IDs such as `github:issue:your-owner/slack-detective-demo:<number>` or `github:code:...`.

Common failures:

- MCP process does not start: confirm `MCP_GITHUB_COMMAND` runs in your terminal and receives `GITHUB_TOKEN`.
- Tool name mismatch: set `MCP_GITHUB_SEARCH_ISSUES_TOOL`, `MCP_GITHUB_SEARCH_CODE_TOOL`, `MCP_GITHUB_GET_ISSUE_TOOL`, `MCP_GITHUB_GET_PULL_REQUEST_TOOL`, or `MCP_GITHUB_GET_FILE_TOOL`.
- Empty results: run `npm run seed:github-demo` and confirm the sandbox issue, PR, labels, comments, and docs exist in GitHub.

## GitHub REST Fallback

Environment:

```env
CONNECTOR_MODE=hybrid
MCP_GITHUB_ENABLED=false
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=your-org
GITHUB_REPOS=repo-one,repo-two
```

The direct REST connector remains available when MCP is not enabled or not fully configured. It searches GitHub issues, pull requests, and code directly through the GitHub REST API and normalizes results into the same `EvidenceItem` shape.

## Jira

Environment:

```env
CONNECTOR_MODE=hybrid
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_PROJECTS=OPS,ENG
```

Create credentials:

1. Create an Atlassian API token from your Atlassian account security settings.
2. Use the email address for that account in `JIRA_EMAIL`.
3. Set `JIRA_PROJECTS` to a comma-separated list of project keys.

Required permissions:

- Browse projects
- Read issues and comments in the configured projects

What it searches:

- JQL generated from investigation keywords, entities, and tags.
- Summary, description, labels, status, reporter, and recent comments.

Verify:

Ask about a phrase in an issue or comment. Evidence IDs should start with `jira:`.

Common failures:

- `401`: email or API token is wrong.
- `403`: account cannot browse the project.
- Empty results: check `JIRA_PROJECTS` and whether the generated terms appear in Jira text search.

## Google Docs and Drive

Environment with service account:

```env
CONNECTOR_MODE=hybrid
GOOGLE_SERVICE_ACCOUNT_JSON=C:\path\to\service-account.json
GOOGLE_DRIVE_FOLDER_IDS=folder-id-1,folder-id-2
```

Environment with OAuth refresh token:

```env
CONNECTOR_MODE=hybrid
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_IDS=folder-id-1,folder-id-2
```

Create credentials:

1. In Google Cloud, enable the Google Drive API.
2. For service accounts, create a service account key and share the target Drive folders or documents with the service account email.
3. For OAuth, create an OAuth client and obtain a refresh token for an account that can read the target folders.

Required scope:

- `https://www.googleapis.com/auth/drive.readonly`

What it searches:

- Drive `fullText` search, optionally constrained to `GOOGLE_DRIVE_FOLDER_IDS`.
- Google Docs are exported as plain text for evidence bodies.
- Other Drive text-like files are fetched through `alt=media` when possible.

Verify:

Ask about a phrase in a shared document. Evidence IDs should start with `docs:`.

Common failures:

- `403`: the service account was not shared on the folder/document.
- Empty results: add folder IDs or confirm Drive indexing can find the terms.
- OAuth client ID and secret alone are not enough; provide `GOOGLE_REFRESH_TOKEN` too.

## Incident Reports

HTTP endpoint environment:

```env
CONNECTOR_MODE=hybrid
INCIDENT_API_URL=https://incidents.example.com/api/incidents
INCIDENT_API_TOKEN=...
```

JSON file environment:

```env
CONNECTOR_MODE=hybrid
INCIDENT_DATA_PATH=data\incidents.production.json
```

HTTP adapter contract:

- Search calls `GET INCIDENT_API_URL?q=<query>`.
- `getById` calls `GET INCIDENT_API_URL/<id>`.
- The response can be an array, or an object with `incidents`, `data`, or `results`.

Record shape:

```json
{
  "id": "inc-123",
  "title": "Checkout latency incident",
  "summary": "Tax lookups caused checkout p95 to spike.",
  "url": "https://status.example.com/inc-123",
  "updatedAt": "2026-01-05T00:00:00Z",
  "owner": "SRE",
  "services": ["checkout"],
  "tags": ["sev2"]
}
```

Verify:

Ask about a phrase in an incident summary. Evidence IDs should start with `incident:`.

Common failures:

- `401` or `403`: update `INCIDENT_API_TOKEN`.
- Empty file results: confirm `INCIDENT_DATA_PATH` points to a JSON array or supported wrapper object.
- Missing URLs: the connector uses a local fallback URL so normalization still succeeds.

## Demo and Fallback Behavior

No OpenAI key is required. If `OPENAI_API_KEY` is absent or the OpenAI request fails, Slack Detective uses deterministic `fallbackSynthesis()`.

No production credentials are required in `CONNECTOR_MODE=demo`. In `CONNECTOR_MODE=hybrid`, any missing connector is skipped with a warning and local evidence remains available. In `CONNECTOR_MODE=real`, missing individual connectors are skipped; if none are available, the app warns and falls back to demo evidence.
