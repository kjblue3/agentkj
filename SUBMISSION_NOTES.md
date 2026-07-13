# Submission Notes

## Devpost project description

Slack Detective turns fragmented workspace evidence into a cited, conversational investigation report. Its differentiator is a provider-neutral connector architecture: services are built and validated at runtime, administrators configure one OAuth application per workspace, and members authorize their own accounts.

The multi-user design preserves account ownership while allowing the agent to combine authorized workspace connections. Connection details remain private; investigation work remains visible and collaborative in a Slack thread.

Transactional encrypted state, idempotent Slack handling, resumable authorization and capacity waits, and explicit cross-workspace isolation make the demo representative of a real shared agent rather than a single-user scripted integration.

Slack Detective qualifies through its MCP integration and Slack-native agent experience. Remote MCP servers can be inspected from Slack, approved only as read-only workspace connections, and authorized privately. Dynamic tools are HTTPS-only, host-pinned, redirect-checked, namespaced by connection, and treated as untrusted. Local operator MCP servers are configured explicitly and can never be created from Slack input.

The core experience is intentionally simple: ask “why” in a channel, receive progress and a cited answer in one thread, then continue the investigation conversationally or accept the agent’s proposed next step. Setup and credentials stay private while the useful result stays public to the team.

## Suggested submission metadata

- Track: **New Slack Agent**
- Prize fit: **Best UX**, **Most Innovative Slack Agent**, and **Best Technological Implementation**
- Qualifying technology: **MCP server integration**
- One-line pitch: **Slack Detective reconstructs evidence-backed workplace timelines across authorized sources and delivers the answer in the Slack thread where the question began.**
