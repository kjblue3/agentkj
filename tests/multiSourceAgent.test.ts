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
});
