import { describe, expect, it, vi } from "vitest";
import { classifyIntent, heuristicIntent } from "../src/slack/intentRouter.js";

describe("intent routing", () => {
  it("parses provider-neutral connection targets", () => {
    expect(heuristicIntent("connect acmefit")).toEqual({ kind: "connect", targets: ["acmefit"] });
    expect(heuristicIntent("connect acmefit and flurbo")).toEqual({ kind: "connect", targets: ["acmefit", "flurbo"] });
  });
  it("keeps only source ids present in the workspace catalog", async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ kind: "investigate", relevantSources: ["acmefit", "invented"] }) } }] }));
    await expect(classifyIntent("why did my pace change?", { connected: ["acmefit"], connectableSummary: "acmefit" }, { chat: { completions: { create } } } as never, "model"))
      .resolves.toEqual({ kind: "investigate", relevantSources: ["acmefit"] });
  });
});
