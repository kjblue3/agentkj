import { describe, expect, it } from "vitest";
import { demoEvidence } from "../src/data/demoData.js";
import { parseQuestion } from "../src/investigation/queryParser.js";
import { rankEvidence } from "../src/investigation/ranker.js";

describe("evidence ranking", () => {
  it("puts checkout incident evidence above unrelated Slack noise", () => {
    const ranked = rankEvidence(demoEvidence, parseQuestion("Why did checkout latency spike?"), 20);
    expect(ranked[0]?.item.tags).toContain("checkout");
    expect(ranked.some(({ item }) => item.id === "slack-noise-1")).toBe(false);
    expect(ranked.some(({ item }) => item.tags.includes("redis"))).toBe(false);
    expect(ranked.findIndex(({ item }) => item.id === "incident-checkout-1")).toBeLessThan(5);
  });
});
