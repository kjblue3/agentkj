import { describe, expect, it } from "vitest";
import { parseQuestion } from "../src/investigation/queryParser.js";
import { rankEvidence } from "../src/investigation/ranker.js";
import type { EvidenceItem } from "../src/types/schemas.js";

const records: EvidenceItem[] = [
  {
    id: "decision-1",
    source: "runtime-service",
    title: "Release dependency decision",
    body: "The release moved because a dependency remained unresolved.",
    url: "https://records.example/decision-1",
    timestamp: "2026-07-12T12:00:00.000Z",
    entities: ["release"],
    tags: ["dependency", "decision"]
  },
  {
    id: "unrelated-1",
    source: "runtime-service",
    title: "Office update",
    body: "The office hours changed.",
    url: "https://records.example/unrelated-1",
    timestamp: "2026-07-12T13:00:00.000Z",
    entities: ["office"],
    tags: ["facilities"]
  }
];

describe("evidence ranking", () => {
  it("keeps relevant records ahead of unrelated records", () => {
    const ranked = rankEvidence(records, parseQuestion("Why did the release move because of a dependency?"), 20);
    expect(ranked[0]?.item.id).toBe("decision-1");
    expect(ranked.some(({ item }) => item.id === "unrelated-1")).toBe(false);
  });
});
