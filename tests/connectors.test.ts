import { describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../src/connectors/slackConnector.js";
import { investigationQuerySchema } from "../src/types/schemas.js";

const query = investigationQuerySchema.parse({
  originalQuestion: "What changed in the release?",
  keywords: ["release", "changed"],
  entities: ["release"],
  tags: ["change"]
});

describe("Slack host connector", () => {
  it("normalizes search results and excludes the bot's own message", async () => {
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes("auth.test")
      ? new Response(JSON.stringify({ ok: true, user_id: "UBOT" }))
      : new Response(JSON.stringify({ ok: true, messages: { matches: [
          { channel: { id: "C1", name: "ops" }, user: "U1", ts: "1710000000.000001", text: "release changed after review", permalink: "https://slack.com/archives/C1/p1710000000000001" },
          { channel: { id: "C1", name: "ops" }, user: "UBOT", ts: "1710000000.000002", text: "my earlier answer" }
        ] } })));
    const results = await new SlackConnector("token", fetcher as never).search(query);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: "slack", author: "U1" });
  });
});
