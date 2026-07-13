# Connectors

External services are runtime data, not source-code registrations.

Members can start the private flow with `/connect <service or remote MCP URL>`. Multiple targets can be separated with commas, `and`, or `&`.

## Dynamic OAuth services

1. A member privately asks the bot to connect a service.
2. The integration architect drafts a read-only OAuth and REST specification.
3. HTTPS endpoints and declared hosts are validated before the specification is stored.
4. A current Slack workspace administrator reviews the hosts, registers the callback URL, and stores the shared client ID and secret.
5. Each member authorizes their own provider account.

The resulting connection is available to investigations in that Slack workspace. Tokens remain associated with their owner so reports can disclose which members' connections contributed without exposing account identifiers.

The service specification’s `domain` is part of source localization. It should say precisely what records the service can answer questions from; vague marketing copy makes automatic multi-source selection less reliable.

## Remote MCP

Remote MCP URLs are validated against private, local, metadata, multicast, reserved, and test networks. Tool output is treated as untrusted data. Authorization is rechecked on every call.

Remote MCP results are normalized into the shared evidence schema so they can be cited alongside REST, Slack, and other MCP records. Clear read-only annotations and descriptive tool names materially improve automatic selection.

Operator-configured local MCP servers may be supplied through `MCP_SERVERS`. End users cannot register local commands.
