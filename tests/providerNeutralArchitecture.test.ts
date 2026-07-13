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

  it("registers /connect as the only slash command and subscribes to direct messages", () => {
    const manifest = JSON.parse(readFileSync(path.resolve("manifest.json"), "utf8")) as {
      features: { slash_commands?: Array<{ command: string }> };
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    expect(manifest.features.slash_commands?.map(({ command }) => command)).toEqual(["/connect"]);
    expect(manifest.settings.event_subscriptions.bot_events).toContain("message.im");
    expect("request_url" in manifest.settings.event_subscriptions).toBe(false);
  });
});

describe("suggested connection sanitizing", () => {
  it("drops None/null/invented ids and keeps real connectable services, however the model cased them", () => {
    expect(sanitizeSuggestedConnection("None", ["records-service"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("null", ["records-service"])).toBeUndefined();
    expect(sanitizeSuggestedConnection(undefined, ["records-service"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("made-up-service", ["records-service"])).toBeUndefined();
    expect(sanitizeSuggestedConnection("Records Service", ["records-service"])).toBe("records-service");
    expect(sanitizeSuggestedConnection("records-service", undefined)).toBeUndefined();
  });
});
