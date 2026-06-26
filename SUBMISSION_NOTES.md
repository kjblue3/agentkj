# Submission notes

## Marketplace copy

**App name:** Slack Detective

**Tagline:** Scattered clues in. Evidence-backed answers out.

**App description:** Ask a workplace “why” question and Slack Detective searches chat, code, tickets, docs, and incidents to reconstruct the causal timeline, identify the likely root cause, and deliver a concise cited report inside Slack.

**Project summary:** Slack Detective is an investigation layer for institutional memory. It converts fragmented operational records into a ranked evidence board, causal timeline, confidence assessment, and actionable follow-ups. The MVP has a judge-safe local demo mode, optional real connectors, and optional OpenAI synthesis, so it can be evaluated reliably while still showing the path to production deployment.

## Recommended track

Submit as **New Slack Agent**. The strongest required-technology claim is Slack-native agent workflow plus Slack search/Real-Time Search-style retrieval through the Slack connector. Do not claim MCP integration unless an actual MCP connector is added and shown in the demo.

## Judging criteria alignment

### Technological Implementation

- A complete TypeScript application using Slack Bolt, Express, Zod, OpenAI, and Vitest.
- One reusable pipeline powers slash commands, mentions, interactive actions, and HTTP endpoints.
- Five replaceable connector adapters normalize heterogeneous records into one schema, with demo, hybrid, and real runtime modes.
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

Demo mode uses a local evidence dataset so judging does not depend on paid services or fragile external setup. Real/hybrid connector modes are implemented for Slack, GitHub, Jira, Google Drive, and incident records, but production deployment would still need organization-specific OAuth approval, access-control review, persistence, audit logs, and deeper pagination/rate-limit hardening.

## Submission checklist

- Record a ~3-minute video using [DEMO_SCRIPT.md](./DEMO_SCRIPT.md).
- Include [ARCHITECTURE.md](./ARCHITECTURE.md) as the architecture diagram/source.
- Share the Slack developer sandbox URL.
- Invite `slackhack@salesforce.com` and `testing@devpost.com` to the sandbox.
- If submitting to the Organizations track, include the Slack App ID and Marketplace submission proof.
