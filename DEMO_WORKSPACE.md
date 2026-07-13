# Demo workspace plan

## Workspace shape

Use a dedicated Slack developer sandbox named **Acme Reliability Lab**. Keep the workspace small and intentional.

| Channel | Purpose | Visible demo content |
| --- | --- | --- |
| `#detective-demo` | Recording stage | Only the final investigation and its follow-up |
| `#checkout-alerts` | Primary evidence | Deploy, p95 increase, wholesale-cart impact, rollback, remediation |
| `#recs-launch` | Backup investigation | Consent-data dependency and privacy launch hold |
| `#identity-platform` | Backup investigation | Redis session decision and revocation constraints |
| `#random` | Noise test | An unrelated slow coffee-machine message |

Invite Slack Detective to every evidence channel and `#detective-demo`. Use the fictional names already present in the demo data: Maya Chen, Leo Park, Nina Shah, Avery Brooks, Priya Raman, Morgan Lee, Sam Ortiz, and an SRE identity. One human account can post all seeded messages; the names are narrative labels, not required Slack accounts.

## Configuration checklist

1. Deploy the app at a stable HTTPS origin.
2. Replace every `https://ngrok-free.app` placeholder in `manifest.json` with that origin.
3. Set `PUBLIC_BASE_URL`, `OAUTH_STATE_SECRET`, `STATE_ENCRYPTION_KEY`, `STATE_DB_PATH`, and `SLACK_WORKSPACE_ID`.
4. Keep Socket Mode credentials configured. Add `SLACK_USER_TOKEN` if the live Slack search tool will be shown; the user token must carry the manifest’s search scopes.
5. Set the model key and model name. The app accepts `LLM_API_KEY` / `LLM_MODEL` and the standard `OPENAI_API_KEY` / `OPENAI_MODEL` fallback.
6. Set `DEMO_SLACK_CHANNEL_ID` to `#checkout-alerts`, then run `npm run seed:slack-demo`. The seed is idempotent.
7. Restart, verify `/health`, and confirm the bot responds in `#detective-demo`.

## Primary rehearsal

Run these exact prompts in a fresh thread:

1. `Why did checkout latency spike after v2.14.0?`
2. `What permanently fixed it, and what test prevents this from recurring?`

Acceptance criteria:

- acknowledgement and result are in the same public thread;
- the answer names the N+1 `tax_rule` query and PR/change `#1842`;
- the evidence excludes Redis, recommendations, and coffee-machine noise;
- the answer cites at least three relevant records;
- the follow-up names batching, a 50-item load test, and a query-count gate;
- `/connect` responds privately without requiring an agent mention;
- no secret or external account identifier appears publicly.

## Backup prompts

- `Why was the recommendations launch delayed?`
- `Why are we still using Redis for sessions?`

These are useful for rehearsal and edge validation, but the final video should use one story deeply rather than three stories superficially.

## Judge access

Before submitting, invite `slackhack@salesforce.com` and `testing@devpost.com`, verify both can open the sandbox, and place a short pinned message in `#detective-demo` with the primary prompt. Remove unrelated test chatter and expired setup links before sharing the workspace URL.
