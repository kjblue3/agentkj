import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { EvidenceConnector } from "../connectors/types.js";
import { parseQuestion } from "./queryParser.js";
import { rankEvidence } from "./ranker.js";

const TOOL_NAME = "evidence_store__search";

/**
 * Exposes this deployment's operator-configured evidence connectors to the agent as one search
 * tool, so every investigation path is agent-driven.
 */
export class EvidenceStoreToolProvider implements AgentToolProvider {
  constructor(private readonly connectors: EvidenceConnector[]) {}

  async listAgentTools(): Promise<ChatCompletionTool[]> {
    if (this.connectors.length === 0) return [];
    return [{
      type: "function",
      function: {
        name: TOOL_NAME,
        description: "Search this deployment's configured evidence connectors for records relevant to the investigation.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Focused search query." } },
          required: ["query"]
        }
      }
    }];
  }

  has(name: string): boolean { return name === TOOL_NAME && this.connectors.length > 0; }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.has(name)) return { error: "Unknown evidence store tool." };
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { error: "A search query is required." };
    const parsed = parseQuestion(query);
    const batches = await Promise.all(this.connectors.map((connector) => connector.search(parsed)));
    const unique = [...new Map(batches.flat().map((item) => [item.id, item])).values()];
    const evidence = rankEvidence(unique, parsed).map(({ item, score }) => ({
      ...item, confidence: Math.min(1, Math.max(item.confidence ?? 0.5, score / 20))
    }));
    return { evidence };
  }
}
