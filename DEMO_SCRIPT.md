# Three-minute demo script

Target length: 2:45–2:55. Record at 1080p with Slack zoomed so the message thread and source links are readable. Keep the architecture diagram open in a second tab.

## 0:00–0:18 — Problem and promise

**On screen:** `#detective-demo`, with one clean channel message ready to send.

**Say:** “Important workplace decisions are scattered across chat, incidents, tickets, docs, and connected tools. Slack Detective investigates from inside Slack, reconstructs what happened, and answers with evidence instead of guesses.”

## 0:18–1:18 — Working investigation

**Send:** `@Slack Detective Why did checkout latency spike after v2.14.0?`

**While it runs, say:** “The request stays in its originating thread. The agent selects only relevant, read-only sources and keeps unrelated workspace data out of the case.”

**When the answer arrives, point out:**

- the direct root-cause answer: the `tax_rule` lookup moved inside the cart-item loop;
- corroboration across the deploy record, customer reports, and incident rollback;
- the linked source line;
- the proposed prevention follow-up and its `Do it` / `Skip` controls.

**Say:** “The evidence connects the deploy, the 2.8-second p95, wholesale-cart timeouts, the rollback, and the permanent query-count regression gate. Each conclusion is grounded in records the agent actually retrieved.”

## 1:18–1:55 — Conversational follow-up

**Reply in the same thread:** `What permanently fixed it, and what test prevents this from recurring?`

**Say:** “Thread history carries the conversation, but it is never treated as evidence. The agent searches again and must cite retrieved records for the follow-up.”

**Point out:** batching tax rules before the loop, the 50-item load test, and the query-count gate.

## 1:55–2:28 — Private connection safety and MCP

**In Slack, invoke:** `/connect`

**Say:** “Connection inventory, setup links, OAuth, and credentials are private. Investigation results remain collaborative in the public thread.”

If the rehearsal MCP server is configured, show its read-only connection or invoke `/connect https://…/mcp`, and say: “Remote MCP tools are inspected before approval, restricted to read-only operations, re-authorized on every call, host-validated, and treated as untrusted.”

If no remote MCP server is available, show the prepared `connect https://…/mcp` inspection response, but do not perform a flaky live connection during the recording.

## 2:28–2:52 — Architecture and close

**Show:** the rendered diagram from `ARCHITECTURE.md`.

**Say:** “Every request carries workspace, channel, thread, actor, and request identity. Workspace and user grants are isolated, secrets are AES-256-GCM encrypted in SQLite, dynamic tools are HTTPS-only and host-pinned, and duplicate Slack deliveries are rejected. Slack Detective turns fragmented workplace evidence into a cited, actionable answer—without moving the investigation out of Slack.”

## Recording guardrails

- Do not show `.env`, tokens, OAuth secrets, terminal history, or browser password-manager UI.
- Do not depend on a brand-new live OAuth setup in the three-minute take.
- Rehearse until the first investigation finishes in under 35 seconds.
- Keep a clean backup take and screenshots of the expected answer, private connector view, and architecture diagram.
