# Connectors

External services are runtime data, not source-code registrations.

## Dynamic OAuth services

1. A member privately asks the bot to connect a service.
2. The integration architect drafts a read-only OAuth and REST specification.
3. HTTPS endpoints and declared hosts are validated before the specification is stored.
4. A current Slack workspace administrator reviews the hosts, registers the callback URL, and stores the shared client ID and secret.
5. Each member authorizes their own provider account.

The resulting connection is available to investigations in that Slack workspace. Tokens remain associated with their owner so reports can disclose which members' connections contributed without exposing account identifiers.

## Remote MCP

Remote MCP URLs are validated against private, local, metadata, multicast, reserved, and test networks. Tool output is treated as untrusted data. Authorization is rechecked on every call.

Operator-configured local MCP servers may be supplied through `MCP_SERVERS`. End users cannot register local commands.
