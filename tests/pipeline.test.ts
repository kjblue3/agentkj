import { describe, expect, it } from "vitest";
import { InvestigationPipeline } from "../src/investigation/pipeline.js";
import { createFixtureConnectors, fixtureQuestions } from "./fixtures.js";
import { scriptedLlm } from "./fakeLlm.js";

const answer = "The checkout latency spike traces back to the ORM upgrade that reintroduced an N+1 query.";
const pipeline = new InvestigationPipeline(
  createFixtureConnectors(),
  {},
  undefined,
  {},
  scriptedLlm(answer)
);

describe("investigation pipeline", () => {
  it.each(fixtureQuestions)("answers through the agent with searched evidence for: %s", async (question) => {
    const result = await pipeline.investigate(question);
    expect(result.connectors).toContain("Fixture slack");
    expect(result.shortAnswer).toBe(answer);
    expect(result.evidence.length).toBeGreaterThanOrEqual(4);
    expect(result.timeline.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps investigations separated by the ranked evidence search", async () => {
    const result = await pipeline.investigate("Why was the recommendations launch delayed?");
    expect(result.evidence.every((item) =>
      item.tags.includes("recommendations") ||
      item.entities.some((entity) => entity.toLowerCase().includes("recommend"))
    )).toBe(true);
  });

  it("keeps Redis and session evidence out of the checkout timeline", async () => {
    const result = await pipeline.investigate("Why did checkout latency spike?");
    const timelineEvidenceIds = result.timeline.flatMap((event) => event.evidenceIds);
    expect(timelineEvidenceIds.some((id) => /redis|session/.test(id))).toBe(false);
    expect(result.evidence.some((item) => item.tags.includes("redis"))).toBe(false);
  });

  it("refuses to investigate without a language model instead of degrading to templates", async () => {
    const keyless = new InvestigationPipeline(createFixtureConnectors(), {}, undefined, {}, null);
    await expect(keyless.investigate("Why did checkout latency spike?")).rejects.toThrow("LLM_UNAVAILABLE");
  });
});
