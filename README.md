# Slack Detective

Slack Detective is a Slack-native investigation agent. It builds read-only integrations at runtime, searches authorized workspace connections, and posts evidence-backed answers in shared Slack threads.

## Behavior

- External data services are not preset in the repository. Ask `connect <service>` and the integration architect drafts and verifies a runtime specification.
- A Slack workspace administrator configures the provider OAuth application once. Each member then authorizes their own account privately.
- Authorizing a connection makes it available to investigations initiated by members of that workspace. Investigation results are public in the originating thread; connection and account details remain private.
- OAuth grants, jobs, actions, and connection metadata are stored transactionally in SQLite. Secrets are encrypted with AES-256-GCM.
- Remote MCP servers remain experimental and untrusted. Their URLs are SSRF-checked and their tools remain permission-gated.

## Development

```sh
npm install
npm run dev
npm run check
```

Copy `.env.example` to `.env`. For durable OAuth state, configure `PUBLIC_BASE_URL`, `OAUTH_STATE_SECRET`, `STATE_ENCRYPTION_KEY`, and the Slack credentials. `CONNECTOR_MODE=demo` keeps the HTTP demo independent of external services.

## Slack visibility

- Private: connection requests, setup and authorization links, connector listings, reauthorization, credentials, and account details.
- Public thread: acknowledgements, queue/capacity updates, investigation progress, reports, failures, and follow-ups.

## Generic OAuth routes

- `/auth/services/:serviceId`
- `/auth/services/:serviceId/callback`
- `/auth/service-setup/:secret`

Environment-provisioned service credentials use `<SERVICE_ID>_CLIENT_ID` and `<SERVICE_ID>_CLIENT_SECRET`. They take precedence over workspace configuration.
