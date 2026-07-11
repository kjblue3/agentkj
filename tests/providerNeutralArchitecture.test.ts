import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("provider-neutral architecture", () => {
  it("materializes services only from persisted runtime specifications", () => {
    const source = readFileSync(path.resolve("src/services/registry.ts"), "utf8");
    expect(source).toContain("loadDynamicSpecs().map(materialize)");
    expect(source).not.toMatch(/const\s+\w+Service\s*:\s*ServiceDefinition/);
  });

  it("does not register source-specific connector weighting", () => {
    const source = readFileSync(path.resolve("src/investigation/ranker.ts"), "utf8");
    expect(source).not.toContain("sourceBoost");
  });
});
