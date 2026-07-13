# Multi-source capabilities

## Can one general question use several sources?

Yes, conditionally. The user does not need to say “look in Sheets and Discord.” A question such as “Which launch commitments are at risk, and what is blocking them?” can be routed to a project-status spreadsheet and a team-chat source when:

1. both connections are authorized for the workspace and channel;
2. their service-domain descriptions plausibly match the question;
3. their read-only tools can retrieve the necessary records; and
4. the model can complete the search and final citation within the six-iteration agent loop.

The router first localizes provider IDs. The investigation agent then chooses individual tools, can call more than one connection, harvests evidence from every response, and produces one result. Connections are namespaced, so separate services and separate members’ accounts remain distinguishable.

## Google Sheets plus Discord

Google Sheets fits the generic OAuth/REST architecture: its read-only API can retrieve spreadsheet ranges when the spreadsheet ID and range are known or discoverable.

Discord is the limiting side of this example. A normal Discord OAuth user grant commonly supports identity and guild membership. General server-message access is bot-based and depends on the bot’s guild/channel permissions and message-content configuration. For a convincing cross-source demo, prepare either:

- a read-only Discord bot exposed through a reviewed remote MCP server; or
- another chat/ticket source with a straightforward read-only search API.

Do not claim unrestricted Discord message search from a basic user OAuth connection.

## What is automatic today?

- Source localization from the general question and declared service domains.
- Hard filtering of dynamic OAuth/REST providers and Slack search to localized IDs.
- Tool-level selection for authorized remote MCP connections.
- Multi-account and multi-provider calls in one investigation.
- Normalization of dynamic REST and arbitrary MCP output into citable evidence.
- Cross-source citations and one validated result.

## Current limitations to disclose

- Source localization is model-driven; vague questions or weak domain descriptions can under- or over-select.
- Remote MCP connections do not yet have a separate curated domain field, so their live tool names and descriptions drive selection.
- Runtime-generated service specifications are endpoint-validated, but provider-specific OAuth policies can still require manual setup or approval.
- The agent has six iterations, so broad questions spanning many tools may need a narrower follow-up.
- Access is only as complete as each provider’s API, scopes, owner grants, and channel permissions.

## Demo acceptance test

Connect two controlled read-only sources with complementary facts. Ask a question that names neither provider. The result passes only if logs show both tools were called, the public answer cites evidence from both source labels, an unrelated third provider is not called, and removing either source lowers confidence or leaves an explicit open question.
