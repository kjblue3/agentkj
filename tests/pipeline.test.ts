import { describe, expect, it } from "vitest";
import { createConnectors } from "../src/connectors/index.js";
import { demoEvidence, demoQuestions } from "../src/data/demoData.js";
import { fallbackSynthesis } from "../src/investigation/fallbackSynthesis.js";
import { ConfiguredEvidenceToolProvider, InvestigationPipeline } from "../src/investigation/pipeline.js";
import type { Synthesizer } from "../src/openai/synthesizer.js";

const deterministicSynthesizer: Synthesizer = {
  async synthesize(question, evidence, timeline) {
    return fallbackSynthesis(question, evidence, timeline);
  }
};

const pipeline = new InvestigationPipeline(
  createConnectors(demoEvidence),
  deterministicSynthesizer
);

describe("investigation pipeline", () => {
  it("exposes relevant bundled evidence to the Slack agent demo path", async () => {
    const provider = new ConfiguredEvidenceToolProvider(createConnectors(demoEvidence));
    const [tool] = await provider.listAgentTools();
    expect(tool?.type === "function" && provider.has(tool.function.name)).toBe(true);

    const result = await provider.call("configured_evidence__search", {
      query: "Why did checkout latency spike?"
    }) as { evidence: typeof demoEvidence };
    expect(result.evidence.length).toBeGreaterThanOrEqual(4);
    expect(result.evidence.every((item) =>
      item.tags.includes("checkout") || item.entities.some((entity) => entity.toLowerCase().includes("checkout"))
    )).toBe(true);
    expect(result.evidence.some((item) => item.id === "slack-noise-1")).toBe(false);
  });

  it("rejects empty configured-evidence searches without querying connectors", async () => {
    const provider = new ConfiguredEvidenceToolProvider(createConnectors(demoEvidence));
    await expect(provider.call("configured_evidence__search", { query: " " }))
      .resolves.toEqual({ error: "A focused search query is required." });
  });

  it.each(demoQuestions)("returns a meaningful timeline for: %s", async (question) => {
    const result = await pipeline.investigate(question);
    expect(result.sourceMode).toBe("demo");
    expect(result.connectors).toContain("Demo slack");
    expect(result.evidence.length).toBeGreaterThanOrEqual(4);
    expect(result.timeline.length).toBeGreaterThanOrEqual(4);
    expect(result.shortAnswer.length).toBeGreaterThan(40);
    expect(result.confidence).not.toBe("low");
  });

  it("keeps investigations separated", async () => {
    const result = await pipeline.investigate("Why was the recommendations launch delayed?");
    expect(result.evidence.every((item) =>
      item.tags.includes("recommendations") ||
      item.entities.some((entity) => entity.toLowerCase().includes("recommend"))
    )).toBe(true);
  });

  it("keeps Redis and session evidence out of the checkout timeline", async () => {
    const result = await pipeline.investigate("Why did checkout latency spike?");
    const timelineEvidenceIds = result.timeline.flatMap((event) => event.evidenceIds);
    const timelineText = result.timeline
      .map((event) => `${event.title} ${event.summary}`)
      .join(" ")
      .toLowerCase();

    expect(timelineEvidenceIds.some((id) => /redis|session/.test(id))).toBe(false);
    expect(timelineText).not.toMatch(/\bredis\b|\bsessions?\b/);
    expect(result.evidence.some((item) => item.tags.includes("redis"))).toBe(false);
  });

  it("returns clean, topic-aware open questions for Redis sessions", async () => {
    const result = await pipeline.investigate(
      "Why are we still using Redis for sessions?"
    );

    expect(result.openQuestions).toContain(
      "Who owns the next Redis session architecture review?"
    );
    expect(result.openQuestions).toContain(
      "What design would preserve 60-second revocation without requiring Redis?"
    );
    expect(result.openQuestions).toContain(
      "Are Redis failover protections now covered by automated tests or alerts?"
    );
    expect(result.openQuestions.join(" ")).not.toMatch(
      /Sam confirms|still owns the Redis session service/
    );
  });
});
