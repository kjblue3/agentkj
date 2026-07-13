import { describe, expect, it, vi } from "vitest";
import { AgentInvestigator } from "../src/agent/investigator.js";
import type { EvidenceItem } from "../src/types/schemas.js";

const statusEvidence: EvidenceItem = {
  id: "status:launch-plan:project",
  source: "status-service",
  title: "Project launch plan",
  body: "The project is marked at risk with a July 20 target and an unresolved data migration dependency.",
  url: "https://status.example/projects/launch-plan",
  timestamp: "2026-07-12T12:00:00.000Z",
  entities: ["project"],
  tags: ["launch", "at-risk"],
  confidence: 0.9
};

const discussionEvidence: EvidenceItem = {
  id: "discussion:project:migration",
  source: "discussion-service",
  title: "Project migration discussion",
  body: "The platform team says the migration rehearsal failed and the next retry is Thursday.",
  url: "https://discussion.example/threads/migration",
  timestamp: "2026-07-12T13:00:00.000Z",
  entities: ["project", "platform team"],
  tags: ["launch", "migration", "blocked"],
  confidence: 0.85
};

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

describe("multi-source agent investigations", () => {
  it("combines two localized sources for a general question that names neither provider", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolCall("call-status", "connection_status__search_rows", { query: "at-risk launches" }))
      .mockResolvedValueOnce(toolCall("call-discussion", "connection_discussion__search_messages", { query: "project migration blocker" }))
      .mockResolvedValueOnce(toolCall("call-finish", "finish", {
        shortAnswer: "The project is at risk because its data migration rehearsal failed and the retry is not until Thursday.",
        confidence: "high",
        likelyRootCause: "The unresolved migration dependency is blocking the launch plan.",
        citedEvidenceIds: [statusEvidence.id, discussionEvidence.id],
        openQuestions: ["Does Thursday's retry preserve the July 20 target?"],
        recommendedActions: ["Confirm an owner and rollback plan before Thursday's retry."]
      }));
    const calls: string[] = [];
    const agent = new AgentInvestigator({ chat: { completions: { create } } } as never, "test-model");

    const result = await agent.investigate("Which launch commitments are at risk, and why?", {
      externalTools: [
        {
          type: "function",
          function: {
            name: "connection_status__search_rows",
            description: "Search project status and launch commitment rows.",
            parameters: { type: "object", properties: { query: { type: "string" } } }
          }
        },
        {
          type: "function",
          function: {
            name: "connection_discussion__search_messages",
            description: "Search engineering team discussions for blockers and decisions.",
            parameters: { type: "object", properties: { query: { type: "string" } } }
          }
        }
      ],
      externalCall: async (name) => {
        calls.push(name);
        return { evidence: [name.includes("status") ? statusEvidence : discussionEvidence] };
      },
      relevantSources: ["status", "discussion"]
    });

    expect(calls).toEqual([
      "connection_status__search_rows",
      "connection_discussion__search_messages"
    ]);
    expect(result.evidence.map((item) => item.source)).toEqual(["status-service", "discussion-service"]);
    expect(result.shortAnswer).toContain("migration rehearsal failed");
    expect(result.confidence).toBe("high");
  });

  it("replaces a confident answer with an honest no-answer when a source was searched but nothing was cited", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolCall("call-search", "connection_status__search_rows", { query: "what happened yesterday" }))
      .mockResolvedValueOnce(toolCall("call-finish", "finish", {
        // The fabrication case: the search returned nothing, but the model asserts a conclusion
        // anyway and even tacks on a trailing clarifying question.
        shortAnswer: "Yesterday there was an unexpected server outage that impacted availability. The team has resolved it. what happened?",
        confidence: "medium",
        likelyRootCause: "An unspecified outage.",
        citedEvidenceIds: []
      }));
    const agent = new AgentInvestigator({ chat: { completions: { create } } } as never, "test-model");

    const result = await agent.investigate("what happened yesterday", {
      externalTools: [{
        type: "function",
        function: {
          name: "connection_status__search_rows",
          description: "Search project status rows.",
          parameters: { type: "object", properties: { query: { type: "string" } } }
        }
      }],
      externalCall: async () => ({ evidence: [] })
    });

    expect(result.confidence).toBe("low");
    expect(result.evidence).toEqual([]);
    expect(result.shortAnswer).not.toContain("server outage");
    expect(result.shortAnswer).not.toContain("what happened?");
    expect(result.shortAnswer).toContain("didn’t find records");
  });

  it("does not override an own-state answer that legitimately makes no tool calls and cites nothing", async () => {
    const create = vi.fn().mockResolvedValueOnce(toolCall("call-finish", "finish", {
      shortAnswer: "Two sources are connected for this workspace: a status service and a discussion service.",
      confidence: "high",
      likelyRootCause: "Answered from the connection catalog.",
      citedEvidenceIds: []
    }));
    const agent = new AgentInvestigator({ chat: { completions: { create } } } as never, "test-model");

    const result = await agent.investigate("what sources are connected?", {
      externalTools: [{
        type: "function",
        function: {
          name: "connection_status__search_rows",
          description: "Search project status rows.",
          parameters: { type: "object", properties: { query: { type: "string" } } }
        }
      }],
      externalCall: async () => ({ evidence: [] })
    });

    expect(result.shortAnswer).toContain("Two sources are connected");
    expect(result.confidence).toBe("high");
  });
});
