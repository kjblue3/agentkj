# Slack Detective

Slack Detective is a Slack-native, read-only investigation agent. It builds service integrations from validated runtime specifications, searches only authorized sources, and posts evidence-backed answers in the originating Slack conversation.

## What it does

- Accepts normal prompts through `@Slack Detective` mentions and direct messages.
- Uses `/connect <service name or HTTPS MCP URL>` as the only slash command; setup and authorization responses stay private.
- Keeps every request bound to its workspace, channel, thread, requesting user, and delivery id.
- Treats “my” and “mine” as the requesting user’s data, keeps named owners distinct, and allows broader multi-owner searches only when the question calls for workspace-wide evidence or comparison.
- Namespaces tools by connection owner and service, normalizes returned records into one evidence schema, and cites only records actually returned by read-only tools.
- Refuses requests to edit, send, merge, deploy, stop, schedule, or otherwise mutate external systems. It never claims those actions occurred.

## Runtime integrations

External services are not registered in first-party source. A connection request causes the integration architect to draft a read-only OAuth/REST specification, validate its HTTPS hosts and endpoints, and store the approved specification as runtime state. A current Slack workspace administrator configures the shared OAuth application; each member authorizes their own account privately.

Remote MCP servers are inspected before approval. Their URLs are checked against private and reserved networks, their tool permissions are revalidated on every call, and their output is treated as untrusted.

User grants remain keyed by workspace, user, and service. Personal questions expose only the requester’s eligible grants to the agent. A workspace-wide investigation may use several authorized owners when corroboration is relevant, and the public result identifies the Slack owners whose connections contributed without revealing external account identifiers.

## Development

```sh
npm install
npm run dev
npm run check
```

Copy `.env.example` to `.env`. Configure the Slack Socket Mode credentials and language-model backend. Durable OAuth deployments also require `PUBLIC_BASE_URL`, `OAUTH_STATE_SECRET`, `STATE_ENCRYPTION_KEY`, and a persistent `STATE_DB_PATH`.

Apply [manifest.json](manifest.json) to the Slack app, then start a private connection flow from any Slack conversation:

```text
/connect <service name>
/connect <HTTPS MCP URL>
```

The HTTP server exposes `/health` plus private OAuth, setup, and credential routes. Investigations are intentionally accepted only from Slack so every run has a complete `InvestigationContext`.

## Security and visibility

- Private: connection inventory, setup links, authorization links, reauthorization, credentials, and external account details.
- Originating conversation: truthful investigation status, cited results, failures, and normal follow-up prompts.
- Stored state: SQLite with WAL, foreign keys, transactional updates, and AES-256-GCM encryption for secrets.
- Dynamic tools: read-only, HTTPS-only, host-pinned, namespaced by connection, redirect-checked, and untrusted.

## Limitations

- Source localization depends on the accuracy of runtime service domains and live tool descriptions.
- A provider’s API, granted scopes, and account permissions determine which records are searchable.
- Broad questions may need a narrower follow-up when available tools exceed the agent’s iteration budget.
- The repository cannot supply deployment URLs, workspace invitations, screenshots, a recorded product video, or submission links; those remain release-operator tasks in [SUBMISSION_CHECKLIST.md](SUBMISSION_CHECKLIST.md).

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONNECTORS.md](CONNECTORS.md), and [MULTI_SOURCE_CAPABILITIES.md](MULTI_SOURCE_CAPABILITIES.md) for the implementation boundaries.
