import { describe, expect, it, vi } from "vitest";
import { LocalConnector } from "../src/connectors/localConnector.js";
import { SlackConnector } from "../src/connectors/slackConnector.js";
import { createConnectors } from "../src/connectors/index.js";
import { investigationQuerySchema, type EvidenceItem } from "../src/types/schemas.js";

const query = investigationQuerySchema.parse({ originalQuestion: "Why did checkout slow down?", keywords: ["checkout", "slow"], entities: ["checkout"], tags: ["latency"] });
const item: EvidenceItem = { id: "code:1", source: "code", title: "Checkout loop change", body: "A repeated lookup was added.", url: "https://demo.example.test/code/1", timestamp: "2026-01-01T00:00:00.000Z", entities: ["checkout"], tags: ["latency"] };

describe("provider-neutral connectors", () => {
  it("creates demo connectors from evidence source ids instead of a preset list", () => {
    expect(createConnectors([item], { CONNECTOR_MODE: "demo" } as NodeJS.ProcessEnv).map((value) => value.name)).toEqual(["Demo code"]);
  });
  it("searches local normalized evidence", async () => {
    await expect(new LocalConnector("Demo code", "code", [item]).search(query)).resolves.toEqual([item]);
  });
  it("normalizes host Slack results and excludes the bot's own message", async () => {
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes("auth.test")
      ? new Response(JSON.stringify({ ok: true, user_id: "UBOT" }))
      : new Response(JSON.stringify({ ok: true, messages: { matches: [
          { channel: { id: "C1", name: "ops" }, user: "U1", ts: "1710000000.000001", text: "checkout slow after release", permalink: "https://slack.example.test/1" },
          { channel: { id: "C1", name: "ops" }, user: "UBOT", ts: "1710000000.000002", text: "my earlier answer" }
        ] } })));
    const results = await new SlackConnector("token", fetcher as never).search(query);
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("slack");
  });
});
