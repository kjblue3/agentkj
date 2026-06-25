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
});
