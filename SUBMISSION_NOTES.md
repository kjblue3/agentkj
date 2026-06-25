# Submission notes

## Marketplace copy

**App name:** Slack Detective

**Tagline:** Scattered clues in. Evidence-backed answers out.

**App description:** Ask a workplace “why” question and Slack Detective searches chat, code, tickets, docs, and incidents to reconstruct the causal timeline, identify the likely root cause, and deliver a concise cited report inside Slack.

**Project summary:** Slack Detective is an investigation layer for institutional memory. It converts fragmented operational records into a ranked evidence board, causal timeline, confidence assessment, and actionable follow-ups. The MVP uses replaceable local adapters and optional OpenAI synthesis, so it is fast to demo, cheap to run, and designed to grow into real enterprise connectors.

## Judging criteria alignment

### Technological Implementation

- A complete TypeScript application using Slack Bolt, Express, Zod, OpenAI, and Vitest.
- One reusable pipeline powers slash commands, mentions, interactive actions, and HTTP endpoints.
- Five replaceable connector adapters normalize heterogeneous records into one schema.
- Local ranking blends lexical relevance, entities, tags, recency, authority, and confidence.
- OpenAI is constrained to synthesis and has a validated deterministic fallback.

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

Real vendor API calls, enterprise permissions, persistent tickets, and production storage are intentionally mocked. The demo proves the full interaction and reasoning architecture without requiring paid services or fragile external setup.
