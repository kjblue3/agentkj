import { describe, expect, it } from "vitest";
import { createConnectors } from "../src/connectors/index.js";
import { demoEvidence } from "../src/data/demoData.js";
import { fallbackSynthesis } from "../src/investigation/fallbackSynthesis.js";
import { InvestigationPipeline } from "../src/investigation/pipeline.js";
import type { Synthesizer } from "../src/openai/synthesizer.js";
import {
  buildEvidenceBlocks,
  buildReportBlocks,
  buildTimelineBlocks,
  selectDisplayEvidence,
  selectDisplayTimeline
} from "../src/slack/blocks.js";
import type { InvestigationResult } from "../src/types/schemas.js";

const deterministicSynthesizer: Synthesizer = {
  async synthesize(question, evidence, timeline) {
    return fallbackSynthesis(question, evidence, timeline);
  }
};

const pipeline = new InvestigationPipeline(
  createConnectors(demoEvidence),
  deterministicSynthesizer
);

function blockText(block: unknown): string {
  const value = block as {
    text?: { text?: string };
    elements?: Array<{ text?: string; elements?: Array<{ text?: string }> }>;
  };

  return [
    value.text?.text,
    ...(value.elements ?? []).flatMap((element) => [
      element.text,
      ...(element.elements ?? []).map((child) => child.text)
    ])
  ].filter(Boolean).join("\n");
}

function allBlockText(blocks: unknown[]): string {
  return blocks.map(blockText).join("\n");
}

describe("Slack Block Kit rendering", () => {
  it("renders the main report with clean section boundaries", async () => {
    const report = await pipeline.investigate("Why did checkout latency spike?");
    const blocks = buildReportBlocks(report, "report-123") as Array<{ type: string }>;
    const text = allBlockText(blocks);

    expect(blocks.map((block) => block.type)).toEqual([
      "header",
      "context",
      "divider",
      "section",
      "section",
      "divider",
      "section",
      "section",
      "divider",
      "section",
      "actions"
    ]);
    expect(text).toContain("*Case:* Why did checkout latency spike?");
    expect(text).toContain("*Sources:* demo");
    expect(text).toContain("*Short answer*");
    expect(text).toContain("*Likely root cause*");
    expect(text).toContain("*Causal timeline*");
    expect(text).toContain("*Evidence board*");
    expect(text).toContain("*Next moves*");
    expect(text).not.toMatch(/Detective ReportCase|Confidence:\*Short answer|root cause\*Causal/i);
  });

  it("renders a no-evidence result as an honest reply with a connect suggestion, not a report skeleton", () => {
    const report: InvestigationResult = {
      question: "How many miles did I run this week?",
      shortAnswer: "I don't have a source that can answer this — none of your connected sources hold workout data.",
      confidence: "low",
      likelyRootCause: "No connected source contains fitness activity.",
      timeline: [],
      evidence: [],
      openQuestions: [],
      recommendedActions: [],
      suggestedConnection: "strava"
    };
    const blocks = buildReportBlocks(report, "report-miss");
    const text = allBlockText(blocks);

    expect(text).not.toContain("*Evidence board*");
    expect(text).not.toContain("*Causal timeline*");
    expect(text).toContain("I don't have a source that can answer this");
    expect(text).toContain("connect strava");
  });

  it("keeps checkout evidence board free of Redis and coffee-machine noise", async () => {
    const report = await pipeline.investigate("Why did checkout latency spike?");
    const redis = demoEvidence.find((item) => item.id === "docs-redis-1")!;
    const coffee = demoEvidence.find((item) => item.id === "slack-noise-1")!;
    const noisyReport: InvestigationResult = {
      ...report,
      evidence: [...report.evidence, redis, coffee]
    };

    const selectedIds = selectDisplayEvidence(noisyReport).map((item) => item.id);
    const evidenceText = allBlockText(buildEvidenceBlocks(noisyReport));

    expect(selectedIds).not.toContain("docs-redis-1");
    expect(selectedIds).not.toContain("slack-noise-1");
    expect(evidenceText).not.toMatch(/redis|coffee machine/i);
    expect(evidenceText).toMatch(/PR #1842|tax_rule|checkout/i);
  });

  it("shows only timeline events tied to displayed evidence", async () => {
    const report = await pipeline.investigate("Why did checkout latency spike?");
    const timelineText = allBlockText(buildTimelineBlocks(report));

    expect(timelineText).toMatch(/checkout|tax_rule|PR #1842/i);
    expect(timelineText).not.toMatch(/redis|coffee machine/i);
  });

  it("keeps displayed timeline events chronological", () => {
    const report: InvestigationResult = {
      question: "Why is casual timeline off?",
      shortAnswer: "A recent change reordered events.",
      confidence: "medium",
      likelyRootCause: "The display timeline was not sorted after filtering.",
      evidence: [
        {
          id: "github:commit:one",
          source: "github",
          title: "Commit one",
          body: "casual timeline sort change",
          url: "https://example.com/one",
          timestamp: "2026-07-07T12:00:00.000Z",
          entities: ["casual-timeline"],
          tags: ["github"],
          confidence: 0.8
        }
      ],
      timeline: [
        {
          timestamp: "2026-07-07T12:00:00.000Z",
          title: "Second event",
          summary: "Later event",
          evidenceIds: ["github:commit:one"]
        },
        {
          timestamp: "2026-07-07T11:00:00.000Z",
          title: "First event",
          summary: "Earlier event",
          evidenceIds: ["github:commit:one"]
        }
      ],
      openQuestions: [],
      recommendedActions: []
    };

    expect(selectDisplayTimeline(report).map((event) => event.title)).toEqual([
      "First event",
      "Second event"
    ]);
  });

  it("keeps the follow-up button wired to the report id", async () => {
    const report = await pipeline.investigate("Why did checkout latency spike?");
    const actions = buildReportBlocks(report, "report-123").find((block) => block.type === "actions") as {
      elements: Array<{ action_id?: string; value?: string }>;
    };

    expect(actions.elements).toContainEqual(expect.objectContaining({
      action_id: "create_followup",
      value: "report-123"
    }));
  });
});
