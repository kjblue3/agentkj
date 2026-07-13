import { describe, expect, it } from "vitest";
import { buildReportBlocks, selectDisplayTimeline } from "../src/slack/blocks.js";
import type { InvestigationResult } from "../src/types/schemas.js";

function allBlockText(blocks: unknown[]): string {
  return blocks.map((block) => {
    const value = block as { text?: { text?: string }; elements?: Array<{ text?: string }> };
    return [value.text?.text, ...(value.elements ?? []).map((element) => element.text)].filter(Boolean).join("\n");
  }).join("\n");
}

const report: InvestigationResult = {
  question: "Why did the release move?",
  shortAnswer: "The release moved because a dependency remained unresolved at review time.",
  confidence: "high",
  likelyRootCause: "The dependency had no completed resolution.",
  evidence: [{
    id: "record-1",
    source: "runtime-service",
    title: "Release decision",
    body: "Review found the unresolved dependency and moved the release.",
    url: "https://records.example/record-1",
    timestamp: "2026-07-12T12:00:00.000Z",
    entities: ["release"],
    tags: ["dependency"]
  }],
  timeline: [{
    timestamp: "2026-07-12T12:00:00.000Z",
    title: "Review decision",
    summary: "The release moved.",
    evidenceIds: ["record-1"]
  }],
  openQuestions: [],
  recommendedActions: ["Assign a dependency owner."]
};

describe("Slack Block Kit rendering", () => {
  it("renders an answer and sources without controls that imply write capability", () => {
    const blocks = buildReportBlocks(report) as Array<{ type: string }>;
    const text = allBlockText(blocks);
    expect(blocks.map((block) => block.type)).toEqual(["section", "context"]);
    expect(text).toContain(report.shortAnswer);
    expect(text).toContain("Sources:");
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
  });

  it("routes missing-source setup through /connect", () => {
    const missing: InvestigationResult = {
      ...report,
      shortAnswer: "No authorized source can answer this yet.",
      confidence: "low",
      evidence: [],
      timeline: [],
      suggestedConnection: "runtime-service"
    };
    expect(allBlockText(buildReportBlocks(missing))).toContain("/connect runtime-service");
  });

  it("keeps displayed timeline events chronological", () => {
    const unordered: InvestigationResult = {
      ...report,
      timeline: [
        { timestamp: "2026-07-12T13:00:00.000Z", title: "Second", summary: "Later", evidenceIds: ["record-1"] },
        { timestamp: "2026-07-12T11:00:00.000Z", title: "First", summary: "Earlier", evidenceIds: ["record-1"] }
      ]
    };
    expect(selectDisplayTimeline(unordered).map((event) => event.title)).toEqual(["First", "Second"]);
  });
});
