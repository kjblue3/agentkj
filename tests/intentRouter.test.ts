import { describe, expect, it, vi } from "vitest";
import { classifyIntent, heuristicIntent } from "../src/slack/intentRouter.js";
import { connectCommandTargets, localizedProviders } from "../src/slack/app.js";

describe("intent routing", () => {
  it("parses provider-neutral connection targets", () => {
    expect(heuristicIntent("connect acmefit")).toEqual({ kind: "connect", targets: ["acmefit"] });
    expect(heuristicIntent("connect acmefit and flurbo")).toEqual({ kind: "connect", targets: ["acmefit", "flurbo"] });
  });
  it("parses slash-command targets without requiring an agent mention", () => {
    expect(connectCommandTargets("Google Sheets and Discord")).toEqual(["Google Sheets", "Discord"]);
    expect(connectCommandTargets("https://records.example/mcp")).toEqual(["https://records.example/mcp"]);
    expect(connectCommandTargets(" ")).toEqual([]);
  });
  it("hard-limits dynamic tools to the sources localized by the classifier", () => {
    const providers = [{ serviceId: "sheets" }, { serviceId: "discord" }, { serviceId: "calendar" }];
    expect(localizedProviders(providers, ["sheets", "discord"])).toEqual(providers.slice(0, 2));
    expect(localizedProviders(providers, [])).toEqual([]);
    expect(localizedProviders(providers, undefined)).toEqual(providers);
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
