import { describe, expect, it } from "vitest";
import { demoEvidence } from "../src/data/demoData.js";
import { fallbackSynthesis } from "../src/investigation/fallbackSynthesis.js";
import { buildTimeline } from "../src/investigation/timeline.js";

describe("fallback synthesis", () => {
  it("creates a useful report without OpenAI", () => {
    const evidence = demoEvidence.filter((item) => item.tags.includes("checkout"));
    const result = fallbackSynthesis(
      "Why did checkout latency spike?",
      evidence,
      buildTimeline(evidence)
    );
    expect(result.confidence).toBe("high");
    expect(result.likelyRootCause.toLowerCase()).toMatch(/n\+1|root cause/);
    expect(result.recommendedActions).toHaveLength(3);
  });

  it("preserves decimal numbers and dotted versions in the short answer", () => {
    const evidence = demoEvidence.filter((item) =>
      ["slack-checkout-1", "incident-checkout-1"].includes(item.id)
    );
    const result = fallbackSynthesis(
      "Why did checkout latency spike?",
      evidence,
      buildTimeline(evidence)
    );

    expect(result.shortAnswer).toContain("p95 rose from 420ms to 2.8s");
    expect(result.shortAnswer).toContain("checkout-service v2.14.0");
    expect(result.shortAnswer).not.toMatch(/420ms to 2\.(?:\s|$)/);
  });

  it("generates grammatical Redis questions from structured evidence", () => {
    const evidence = demoEvidence.filter((item) => item.tags.includes("sessions"));
    const result = fallbackSynthesis(
      "Why are we still using Redis for sessions?",
      evidence,
      buildTimeline(evidence)
    );

    expect(result.openQuestions).toEqual([
      "Who owns the next Redis session architecture review?",
      "What design would preserve 60-second revocation without requiring Redis?",
      "Are Redis failover protections now covered by automated tests or alerts?"
    ]);
    expect(result.openQuestions.join(" ")).not.toContain(
      "Sam confirms Identity Platform"
    );
  });
});
