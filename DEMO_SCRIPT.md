# Three-minute demo script

## 0:00–0:30 — The problem

“When something goes wrong at work, the answer is rarely in one place. It is in a Slack thread, a PR comment, a ticket, a design decision, and an incident report. Slack Detective turns that scattered trail into one evidence-backed case file.”

Show Slack with the app installed as **Slack Detective**. Open a channel such as `#checkout-alerts`, mention that the safest fallback is local seeded evidence, while the live demo mode uses real seeded Slack messages and a real GitHub sandbox repo queried through MCP. Then run:

> Why did checkout latency spike?

## 0:30–1:20 — The reveal

As the report appears, point out:

- the two-sentence short answer;
- the named N+1 root cause;
- the chronological deployment, customer impact, rollback, and remediation;
- high confidence based on corroboration across sources;
- the visible source mode line, such as `Sources: demo · 5 sources` or `Sources: hybrid · ...`;
- source links rather than unsupported prose.

Click **Show evidence**. In hybrid mode, highlight real `slack:` message IDs and GitHub evidence from the MCP-backed sandbox repo. In demo fallback mode, highlight the Slack alert, PR, Jira complaints, incident report, and follow-up doc.

Click **Show timeline**. Explain that this is reconstructed from normalized records rather than a hardcoded answer.

## 1:20–2:10 — Reusability

Run:

> Why was the recommendations launch delayed?

Show that the same pipeline finds a different causal chain: missing consent-aware event exports → privacy approval blocked → launch moved.

Then mention the third built-in question:

> Why are we still using Redis for sessions?

This demonstrates historical decision retrieval, rejected alternatives, incident learning, security constraints, and current ownership.

## 2:10–2:40 — Actions and resilience

Click **Create follow-up** to open the Slack modal, then **Mark solved**.

Say: “OpenAI can polish the final report, but search, scoring, evidence selection, timeline construction, and fallback synthesis are deterministic. The live path uses real seeded Slack messages and a real GitHub sandbox through MCP; if credentials are unavailable during judging, demo mode still proves the full Slack workflow.”

If showing the dynamic connector path, paste a public article URL and ask for a summary, then run:

> connect https://your-demo-mcp.example/mcp

Point out that Slack Detective validates the URL, displays the remote connector URL and advertised tools, and enables nothing until the user explicitly approves it. If the connector needs a bearer token, the token is entered through a backend form instead of Slack.

## 2:40–3:00 — Close

“Slack Detective shortens the expensive part of incident response and institutional memory: finding out what actually happened and proving it. Scattered clues in. Evidence-backed answers out.”
