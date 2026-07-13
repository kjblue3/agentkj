# Slack Detective

Slack Detective is a Slack-native investigation agent. It builds read-only integrations at runtime, searches authorized workspace connections, and posts evidence-backed answers in shared Slack threads.

Ask one general question—without naming a provider—and Slack Detective uses the connected-source catalog to localize the smallest plausible set of sources, queries them, and combines their evidence into one cited answer. For example, a delivery-risk question can use status rows from a spreadsheet and corroborating team discussion from a chat connector when both are authorized and their declared domains match the question.

## Highlights

- Provider-neutral runtime integrations: validated OAuth/REST specifications and remote MCP servers rather than hardcoded vendors.
- Multi-source investigations: tools are namespaced per connection, results are normalized into a common evidence schema, and one answer can cite several services or account owners.
- Source localization: the intent router matches the question against connected service domains; unrelated dynamic tools are not exposed to that investigation.
- Slack-native privacy: use `/connect <service or MCP URL>` for private setup while investigation progress and cited results remain in the originating public thread.
- Read-only security: HTTPS and host validation, encrypted credentials, per-workspace/user grants, live authorization checks, and untrusted-output redaction.

## Behavior

- External data services are not preset in the repository. Ask `connect <service>` and the integration architect drafts and verifies a runtime specification.
- A Slack workspace administrator configures the provider OAuth application once. Each member then authorizes their own account privately.
- Authorizing a connection makes it available to investigations initiated by members of that workspace. Investigation results are public in the originating thread; connection and account details remain private.
- OAuth grants, jobs, actions, and connection metadata are stored transactionally in SQLite. Secrets are encrypted with AES-256-GCM.
- Remote MCP servers remain experimental and untrusted. Their URLs are SSRF-checked and their tools remain permission-gated.

## Multi-source boundary

The agent can combine any authorized sources whose tools expose the needed records. Google Sheets is compatible with the generic read-only OAuth/REST path. Discord server-message history normally requires a Discord bot with channel permissions (or a purpose-built read-only MCP server); a basic Discord user OAuth grant alone generally exposes identity and guild membership, not unrestricted server-message history.

Source localization depends on accurate service-domain and tool descriptions. When classification has no reliable signal, the system leaves the catalog ungated and the investigation agent chooses from the authorized tools itself. See [MULTI_SOURCE_CAPABILITIES.md](MULTI_SOURCE_CAPABILITIES.md) for the exact flow and limitations.

## Development

```sh
npm install
npm run dev
npm run check
```

Copy `.env.example` to `.env`. For durable OAuth state, configure `PUBLIC_BASE_URL`, `OAUTH_STATE_SECRET`, `STATE_ENCRYPTION_KEY`, and the Slack credentials. `CONNECTOR_MODE=demo` keeps the HTTP demo independent of external services.

After applying `manifest.json` to the Slack app, connect sources privately with:

```text
/connect Google Sheets
/connect https://your-read-only-mcp.example/mcp
```

For hackathon delivery, use [SUBMISSION_CHECKLIST.md](SUBMISSION_CHECKLIST.md), [DEMO_WORKSPACE.md](DEMO_WORKSPACE.md), and [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## Slack visibility

- Private: connection requests, setup and authorization links, connector listings, reauthorization, credentials, and account details.
- Public thread: acknowledgements, queue/capacity updates, investigation progress, reports, failures, and follow-ups.

## Generic OAuth routes

- `/auth/services/:serviceId`
- `/auth/services/:serviceId/callback`
- `/auth/service-setup/:secret`

Environment-provisioned service credentials use `<SERVICE_ID>_CLIENT_ID` and `<SERVICE_ID>_CLIENT_SECRET`. They take precedence over workspace configuration.
