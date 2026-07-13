import { describe, expect, it, vi } from "vitest";
import type { AgentToolProvider } from "../src/agent/toolProvider.js";
import { investigationContext } from "../src/core/context.js";
import { InvestigationPipeline } from "../src/investigation/pipeline.js";
import type { EvidenceItem } from "../src/types/schemas.js";

const record: EvidenceItem = {
  id: "service:U1:record-1",
  source: "runtime-service",
  title: "Release decision",
  body: "The release moved after the review found an unresolved dependency.",
  url: "https://records.example/record-1",
  timestamp: "2026-07-12T12:00:00.000Z",
  entities: ["release"],
  tags: ["decision"],
  confidence: 0.9
};

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

function provider(): AgentToolProvider {
  return {
    listAgentTools: async () => [{
      type: "function",
      function: {
        name: "connection_service_U1__search",
        description: "Search the requesting user's release records.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      }
    }],
    has: (name) => name === "connection_service_U1__search",
    call: async () => ({ evidence: [record] })
  };
}

describe("investigation pipeline", () => {
  it("uses only runtime-provided tools and carries the requesting user into the agent scope", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolCall("connection_service_U1__search", { query: "release dependency" }))
      .mockResolvedValueOnce(toolCall("finish", {
        shortAnswer: "The release moved because review found an unresolved dependency.",
        confidence: "high",
        likelyRootCause: "An unresolved dependency remained at review time.",
        citedEvidenceIds: [record.id],
        openQuestions: [],
        recommendedActions: ["Assign an owner to the dependency."]
      }));
    const pipeline = new InvestigationPipeline(undefined, {}, { chat: { completions: { create } } } as never);
    const context = investigationContext({ workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1" });

    const result = await pipeline.investigate("Why did my release move?", {
      context,
      toolProviders: [provider()],
      connectionDescriptors: [{
        id: "service:U1",
        workspaceId: "T1",
        ownerUserId: "U1",
        serviceId: "service",
        serviceLabel: "Runtime Service",
        domain: "release records",
        scopes: ["records:read"],
        health: "ready",
        connectedAt: "2026-07-12T00:00:00.000Z"
      }]
    });

    expect(result.evidence).toEqual([record]);
    const firstCall = create.mock.calls[0]?.[0] as { messages: Array<{ content?: string }> };
    expect(firstCall.messages.some((message) => message.content?.includes("Requesting Slack user: U1"))).toBe(true);
  });

  it("refuses to investigate without a language model", async () => {
    const pipeline = new InvestigationPipeline(undefined, {}, null);
    await expect(pipeline.investigate("What changed?")).rejects.toThrow("LLM_UNAVAILABLE");
  });
});
