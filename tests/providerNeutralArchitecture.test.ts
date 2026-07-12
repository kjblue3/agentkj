import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeSuggestedConnection } from "../src/agent/investigator.js";

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

describe("suggested connection sanitizing", () => {
  it("drops None/null/invented ids and keeps real connectable services, however the model cased them", () => {
    expect(sanitizeSuggestedConnection("None", ["acme-drive"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("null", ["acme-drive"])).toBeUndefined();
    expect(sanitizeSuggestedConnection(undefined, ["acme-drive"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("made-up-service", ["acme-drive"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("Acme Drive", ["acme-drive"])).toBe("acme-drive");
    expect(sanitizeSuggestedConnection("acme-drive", undefined)).toBeUndefined();
  });
});
