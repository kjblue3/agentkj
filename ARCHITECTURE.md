# Architecture

Slack Detective is a modular retrieval-and-synthesis pipeline. Slack and HTTP are thin delivery layers over the same `InvestigationPipeline`. The hackathon submission claims Slack search/Real-Time Search-style evidence retrieval through the Slack connector, plus MCP-backed GitHub sandbox retrieval and production-style connectors for Jira, Google Drive, incident systems, and GitHub REST fallback.

```mermaid
flowchart LR
  Q[Question] --> P[Parse and expand]
  P --> M{CONNECTOR_MODE}
  M -->|demo| D[Local demo evidence]
  M -->|hybrid| H[Real connectors + local fallback]
  M -->|real| X[Configured real connectors]
  G[GitHub MCP server] --> H
  G --> X
  D --> C[Evidence adapter contract]
  H --> C
  X --> C
  C --> N[Normalize with Zod]
  N --> R[Rank locally]
  R --> T[Cluster and order events]
  T --> S{OpenAI key?}
  S -->|Yes| O[Grounded report polish]
  S -->|No or error| F[Deterministic synthesis]
  O --> U[Slack Block Kit / JSON API]
  F --> U
```

## Pipeline stages

1. **Parse:** tokenizes the question and adds a small, explicit synonym expansion.
2. **Search:** calls all enabled adapters concurrently. Demo mode searches local records; hybrid mode searches configured vendor APIs/MCP tools plus local fallback; real mode searches configured vendor APIs/MCP tools and falls back to demo only when none are configured.
3. **Normalize:** every clue is validated as an `EvidenceItem` with Zod.
4. **Rank:** combines keyword overlap, entity matches, tags, recency, source authority, and record confidence.
5. **Cluster:** groups related same-day evidence into events and sorts it chronologically.
6. **Synthesize:** produces a short answer, likely root cause, confidence, open questions, and actions. OpenAI is optional and cannot alter the selected evidence or timeline.
7. **Present:** renders a compact detective board in Slack or returns typed JSON over HTTP.

## Adapter contract

```ts
interface EvidenceConnector {
  name: string;
  search(query: InvestigationQuery): Promise<EvidenceItem[]>;
  getById(id: string): Promise<EvidenceItem | null>;
}
```

Adding or replacing a connector does not change ranking, synthesis, Slack, or API code. Authentication, MCP tool calls, pagination, and source-specific mapping stay inside the adapter.

## Grounding and graceful degradation

- Search is never delegated to the language model.
- Responses include `sourceMode` and connector names so judges can see whether a report came from demo, hybrid, or real mode.
- The ranked evidence list and generated timeline are treated as immutable inputs to OpenAI.
- OpenAI output is validated; malformed output or network failure uses the local fallback.
- Important Slack claims sit next to source links, and expanded views expose evidence IDs.

## MVP tradeoffs

Local JSON keeps setup instant and demos deterministic. Real connectors are available for Slack, GitHub MCP, GitHub REST fallback, Jira, Google Drive, and incidents, but production deployment would still need deeper OAuth onboarding, persistent report/follow-up storage, access-control filtering, audit logs, pagination hardening, MCP server lifecycle management, and evaluation telemetry.
