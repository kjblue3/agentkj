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

Common failures:

- `missing_scope`: add the scope, reinstall the Slack app, and update the token.
- Empty results: Slack search only returns content the installed token can access.
- Socket Mode disabled: set `SLACK_APP_TOKEN`; the HTTP API still works without it.

## GitHub

Environment:

```env
CONNECTOR_MODE=hybrid
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=your-org
GITHUB_REPOS=repo-one,repo-two
```

Create credentials:

1. In GitHub, create a fine-grained personal access token.
2. Scope it to the owner and repositories in `GITHUB_REPOS`.
3. Grant read-only permissions for Issues, Pull requests, Contents, and Metadata.

What it searches:

- Issues and pull requests, including title, body, and comments where GitHub search supports them.
- Code search matches in configured repositories.

Verify:

Ask about a known issue, PR, or code symbol. Evidence IDs should start with `github:issue:` or `github:code:`.

Common failures:

- `401`: token is invalid or expired.
- `403`: token lacks repository access or search rate limits were reached.
- Empty code results: fine-grained tokens must have Contents read permission.

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
