import { describe, expect, it, vi } from "vitest";
import { connectCommandTargets, localizedProviders } from "../src/slack/app.js";
import { classifyIntent, heuristicIntent, ownerScopeForText } from "../src/slack/intentRouter.js";

const context = {
  requestingUserId: "U1",
  connections: [
    { serviceId: "documents", ownerUserId: "U1", domain: "documents and files" },
    { serviceId: "documents", ownerUserId: "U2", domain: "documents and files" },
    { serviceId: "chat", ownerUserId: "U2", domain: "team discussions" }
  ],
  connectableSummary: "Runtime-defined services"
};

describe("intent routing", () => {
  it("parses provider-neutral connection targets", () => {
    expect(heuristicIntent("connect documents")).toEqual({ kind: "connect", targets: ["documents"] });
    expect(heuristicIntent("connect documents and chat")).toEqual({ kind: "connect", targets: ["documents", "chat"] });
  });

  it("parses /connect targets without requiring an agent mention", () => {
    expect(connectCommandTargets("documents and chat")).toEqual(["documents", "chat"]);
    expect(connectCommandTargets("https://connector.example/mcp")).toEqual(["https://connector.example/mcp"]);
    expect(connectCommandTargets(" ")).toEqual([]);
  });

  it("hard-limits dynamic tools to localized service ids", () => {
    const providers = [{ serviceId: "documents" }, { serviceId: "chat" }, { serviceId: "calendar" }];
    expect(localizedProviders(providers, ["documents", "chat"])).toEqual(providers.slice(0, 2));
    expect(localizedProviders(providers, [])).toEqual([]);
    expect(localizedProviders(providers, undefined)).toEqual(providers);
  });

  it("forces personal pronouns to the requesting user's connections", async () => {
    const create = vi.fn(async (_args: unknown) => ({ choices: [{ message: { content: JSON.stringify({
      kind: "investigate",
      relevantSources: ["documents", "invented"],
      relevantOwnerUserIds: ["U2"]
    }) } }] }));
    await expect(classifyIntent("tell me about my documents", context, { chat: { completions: { create } } } as never, "model"))
      .resolves.toEqual({ kind: "investigate", relevantSources: ["documents"], relevantOwnerUserIds: ["U1"] });
  });

  it("selects explicitly mentioned owners and leaves team-wide questions broad", () => {
    expect(ownerScopeForText("compare my documents with <@U2>", "U1", ["U1", "U2"]))
      .toEqual(["U1", "U2"]);
    expect(ownerScopeForText("what is blocking our team?", "U1", ["U1", "U2"]))
      .toBeUndefined();
  });

  it("rejects mutation requests in the deterministic fallback", () => {
    expect(heuristicIntent("implement these code changes")).toEqual({ kind: "unsupported_action" });
    expect(heuristicIntent("stop all deployments")).toEqual({ kind: "unsupported_action" });
  });

  it("does not delegate an explicit mutation request to the model classifier", async () => {
    const create = vi.fn();
    await expect(classifyIntent("merge and deploy these changes", context, { chat: { completions: { create } } } as never, "model"))
      .resolves.toEqual({ kind: "unsupported_action" });
    expect(create).not.toHaveBeenCalled();
  });

  it("routes autonomous-capability questions to truthful help", () => {
    expect(heuristicIntent("what autonomous actions do you have?")).toEqual({ kind: "help" });
  });

  it("hands the classifier identity-preserving thread context", async () => {
    const create = vi.fn(async (_args: unknown) => ({ choices: [{ message: { content: JSON.stringify({ kind: "investigate" }) } }] }));
    const transcript = "<@U2>: what records are mine?\nassistant: I found two records.";
    await classifyIntent("can you list them?", context, { chat: { completions: { create } } } as never, "model", transcript);
    const payload = create.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages.some((message) => message.content.includes("<@U2>: what records are mine?"))).toBe(true);
    expect(payload.messages.at(-1)?.content).toBe("can you list them?");
  });
});
