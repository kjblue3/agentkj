import { describe, expect, it } from "vitest";
import { parseQuestion } from "../src/investigation/queryParser.js";
import { rankEvidence } from "../src/investigation/ranker.js";
import { fixtureEvidence } from "./fixtures.js";

describe("evidence ranking", () => {
  it("puts checkout incident evidence above unrelated Slack noise", () => {
    const ranked = rankEvidence(fixtureEvidence, parseQuestion("Why did checkout latency spike?"), 20);
    expect(ranked[0]?.item.tags).toContain("checkout");
    expect(ranked.some(({ item }) => item.id === "slack-noise-1")).toBe(false);
    expect(ranked.some(({ item }) => item.tags.includes("redis"))).toBe(false);
    expect(ranked.findIndex(({ item }) => item.id === "incident-checkout-1")).toBeLessThan(5);
  });
});
