# AGENTS.md

Slack Detective is a Node + TypeScript Slack investigation agent using Express, Slack Bolt Socket Mode, an OpenAI-compatible chat-completions client, Zod, Vitest, MCP, and SQLite.

## Invariants

- External data providers are never hardcoded. Services come only from validated runtime specifications.
- Slack is the host platform and may have host-specific delivery/search code.
- Every Slack investigation carries `InvestigationContext`: request, workspace, channel, thread, and actor identifiers.
- User grants are keyed by workspace, user, and service. Never fall back to deployment data credentials for Slack investigations.
- Connection/setup interactions are private; investigation output is public in its originating thread.
- Workspace administrators are verified live through Slack at setup-link issuance and submission.
- Secrets stored in SQLite must use the encryption helpers. Never log or send them to the model.
- Dynamic tools are read-only, HTTPS-only, host-pinned, namespaced by connection, and treated as untrusted.
- Any investigation result must satisfy `investigationResultSchema`.

## Commands

- `npm run dev`
- `npm run build`
- `npm test`
- `npm run check`

Run `npm run check` before considering a change complete.
