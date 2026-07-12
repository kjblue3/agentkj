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
  it("hands the classifier the thread transcript so follow-ups can be read in context", async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ kind: "investigate" }) } }] }));
    const transcript = "member: what servers am i in?\nassistant: You are in 12 different servers.";
    await classifyIntent("can you list them?", { connected: ["acmefit"], connectableSummary: "acmefit" }, { chat: { completions: { create } } } as never, "model", transcript);
    const payload = (create.mock.calls[0] as unknown[])[0] as { messages: { role: string; content: string }[] };
    const contextMessage = payload.messages.find((message) => message.content.includes("You are in 12 different servers."));
    expect(contextMessage?.role).toBe("system");
    expect(payload.messages.at(-1)?.content).toBe("can you list them?");
  });
});
