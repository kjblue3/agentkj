import { describe, expect, it } from "vitest";
import { evidenceItemSchema } from "../src/types/schemas.js";

describe("evidence normalization", () => {
  it("applies collection defaults and validates fields", () => {
    const item = evidenceItemSchema.parse({
      id: "sample",
      source: "docs",
      title: "A decision",
      body: "A grounded decision record.",
      url: "https://example.com/sample",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
    expect(item.entities).toEqual([]);
    expect(item.tags).toEqual([]);
  });

  it("accepts sources it has never seen (services are an open set), but not empty ones", () => {
    expect(evidenceItemSchema.parse({
      id: "ok", source: "acmefit", title: "Run", body: "5 mi",
      url: "https://example.com", timestamp: "2026-01-01T00:00:00.000Z"
    }).source).toBe("acmefit");
    expect(() => evidenceItemSchema.parse({
      id: "bad", source: "", title: "Bad", body: "Bad",
      url: "https://example.com", timestamp: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  });
});
