import { describe, expect, it } from "vitest";
import { evidenceItemSchema } from "../src/types/schemas.js";

describe("evidence normalization", () => {
  it("applies collection defaults and validates fields", () => {
    const item = evidenceItemSchema.parse({
      id: "record-1",
      source: "runtime-service",
      title: "A decision",
      body: "A grounded decision record.",
      url: "https://records.example/record-1",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
    expect(item.entities).toEqual([]);
    expect(item.tags).toEqual([]);
  });

  it("accepts an open source id but rejects an empty one", () => {
    expect(evidenceItemSchema.parse({
      id: "record-2", source: "runtime-source", title: "Record", body: "Body",
      url: "https://records.example/record-2", timestamp: "2026-01-01T00:00:00.000Z"
    }).source).toBe("runtime-source");
    expect(() => evidenceItemSchema.parse({
      id: "record-3", source: "", title: "Record", body: "Body",
      url: "https://records.example/record-3", timestamp: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  });
});
