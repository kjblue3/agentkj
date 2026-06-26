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
  selectDisplayEvidence
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
    expect(text).toContain("*Short answer*");
    expect(text).toContain("*Likely root cause*");
    expect(text).toContain("*Causal timeline*");
    expect(text).toContain("*Evidence board*");
    expect(text).toContain("*Next moves*");
    expect(text).not.toMatch(/Detective ReportCase|Confidence:\*Short answer|root cause\*Causal/i);
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
});
