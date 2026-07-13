# Multi-source capabilities

A general question can use several runtime-connected sources without naming them. The router compares the question with each service’s declared domain, applies the owner scope implied by the prompt, and exposes only the eligible read-only tools to the investigation agent.

Multi-source use requires all of the following:

1. each connection is authorized for the workspace, requester, and channel under its access policy;
2. personal or named-member references resolve to the correct connection owners;
3. each service domain or live MCP tool description plausibly matches the question;
4. the tools can retrieve complementary records within the agent’s iteration budget; and
5. every cited conclusion is supported by evidence returned during that run.

Connections are namespaced, so two members’ accounts for the same service remain distinct. “My documents” selects only the requester’s document connection. “Compare my status with <@U2>” can select both named owners. “What is blocking our team?” may search multiple authorized owners and Slack workspace evidence when those sources are relevant.

## Automatic behavior

- Service-domain localization from a provider-neutral question.
- Deterministic requester scoping for personal pronouns.
- Explicit Slack-member scoping for comparisons.
- Workspace-wide selection when the question genuinely calls for corroboration.
- Tool-level selection for reviewed remote MCP connections.
- Normalization of runtime REST and MCP results into citable evidence.
- One validated answer with owner attribution for connections that contributed.

## Limitations

- Weak service-domain descriptions can under- or over-select sources.
- Remote MCP selection relies on live tool names and descriptions.
- Runtime-generated service specifications still depend on provider-specific OAuth approval and API behavior.
- Account permissions and scopes bound the completeness of every search.
- Very broad questions may require a narrower follow-up.

## Acceptance check

Authorize two controlled read-only sources with complementary facts under distinct Slack owners. Verify that a personal question calls only the requester’s tool, an explicit comparison calls exactly the named owners’ tools, a workspace-wide question can call both, an unrelated third source is not called, and every public citation maps to returned evidence.
