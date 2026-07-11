# Submission Notes

Slack Detective turns fragmented workspace evidence into a cited, conversational investigation report. Its differentiator is a provider-neutral connector architecture: services are built and validated at runtime, administrators configure one OAuth application per workspace, and members authorize their own accounts.

The multi-user design preserves account ownership while allowing the agent to combine authorized workspace connections. Connection details remain private; investigation work remains visible and collaborative in a Slack thread.

Transactional encrypted state, idempotent Slack handling, resumable authorization and capacity waits, and explicit cross-workspace isolation make the demo representative of a real shared agent rather than a single-user scripted integration.
