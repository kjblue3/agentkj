# Submission notes

## Marketplace copy

**App name:** Slack Detective

**Tagline:** Scattered clues in. Evidence-backed answers out.

**App description:** Ask a workplace “why” question and Slack Detective searches chat, code, tickets, docs, and incidents to reconstruct the causal timeline, identify the likely root cause, and deliver a concise cited report inside Slack.

**Project summary:** Slack Detective is an investigation layer for institutional memory. It converts fragmented operational records into a ranked evidence board, causal timeline, confidence assessment, and actionable follow-ups. The MVP has a judge-safe local demo mode, a live seeded Slack plus GitHub MCP sandbox mode, public-link reading, experimental user-supplied remote MCP connectors, optional real connectors, and optional OpenAI synthesis, so it can be evaluated reliably while still showing the path to production deployment.

## Recommended track

Submit as **New Slack Agent**. The strongest required-technology claims are Slack-native agent workflow, Slack search/Real-Time Search-style retrieval through the Slack connector, and MCP-backed GitHub evidence retrieval from a real sandbox repository.

## Judging criteria alignment

### Technological Implementation

- A complete TypeScript application using Slack Bolt, Express, Zod, OpenAI, and Vitest.
- One reusable pipeline powers slash commands, mentions, interactive actions, and HTTP endpoints.
- Replaceable connector adapters normalize heterogeneous records into one schema, with demo, hybrid, and real runtime modes.
- Public links can be read on demand without creating permanent connectors.
- User-supplied remote MCP URLs are validated against SSRF risks, inspected, shown to the user, explicitly approved, credentialed through backend forms, and invoked dynamically.
- Personal, shared workspace, and delegated remote connections are authorized on every tool call.
- GitHub evidence can come from a real `slack-detective-demo` sandbox repo through an MCP GitHub server; the seeded content is fictional but the GitHub objects and MCP retrieval path are real.
- Slack evidence can come from real seeded sandbox-channel messages with normalized `slack:` IDs.
- Local ranking blends lexical relevance, entities, tags, recency, authority, and confidence.
- OpenAI is constrained to synthesis and has a validated deterministic fallback.
- Results expose `sourceMode` and connector names so judges can verify demo versus real/hybrid operation.

### Design

- The Block Kit response is a compact “detective board,” not a chat transcript.
- Progressive disclosure keeps the main answer concise while evidence and timeline actions expose detail.
- Confidence, citations, and open questions communicate uncertainty honestly.
- A follow-up modal and solved state turn analysis into workflow.

### Potential Impact

- Reduces time spent searching across tools during incidents, launch reviews, and architecture questions.
- Preserves organizational context when teams or owners change.
- Gives leaders and responders a verifiable narrative instead of an ungrounded summary.
- The adapter boundary supports future deployment across existing enterprise systems.

### Quality of Idea

The core insight is that workplace answers are causal graphs hidden across systems. Slack Detective does more than retrieve documents: it ranks corroborating clues, reconstructs sequence, distinguishes root cause from symptoms, and cites the record behind each conclusion.

## Scope boundary

Demo mode uses a local evidence dataset so judging does not depend on paid services or fragile external setup. The recommended live demo seeds fictional evidence into real Slack and GitHub sandbox objects and retrieves GitHub through MCP, then optionally shows public-link reading or a demo remote MCP server. Real/hybrid connector modes are implemented for Slack, GitHub MCP, GitHub REST fallback, Jira, Google Drive, and incident records, but production deployment would still need organization-specific OAuth approval, encrypted secret storage, access-control review, persistence, audit logs, and deeper pagination/rate-limit hardening.

## Submission checklist

- Record a ~3-minute video using [DEMO_SCRIPT.md](./DEMO_SCRIPT.md).
- Include [ARCHITECTURE.md](./ARCHITECTURE.md) as the architecture diagram/source.
- For the live demo, run `npm run seed:github-demo` and `npm run seed:slack-demo`, then use `CONNECTOR_MODE=hybrid` with `MCP_GITHUB_ENABLED=true`.
- Share the Slack developer sandbox URL.
- Invite `slackhack@salesforce.com` and `testing@devpost.com` to the sandbox.
- If submitting to the Organizations track, include the Slack App ID and Marketplace submission proof.
