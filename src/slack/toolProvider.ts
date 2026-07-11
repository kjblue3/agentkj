import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import { SlackConnector } from "../connectors/slackConnector.js";
import { parseQuestion } from "../investigation/queryParser.js";

const TOOL_NAME = "workspace_chat__search_messages";

export class SlackToolProvider implements AgentToolProvider {
  private readonly connector: SlackConnector;
  constructor(botToken: string, userToken?: string) {
    this.connector = new SlackConnector(botToken, undefined, userToken ?? botToken);
  }
  async listAgentTools(): Promise<ChatCompletionTool[]> {
    return [{
      type: "function",
      function: {
        name: TOOL_NAME,
        description: "Search accessible Slack workspace messages for evidence relevant to this investigation.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Focused search query." } },
          required: ["query"]
        }
      }
    }];
  }
  has(name: string): boolean { return name === TOOL_NAME; }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.has(name)) return { error: "Unknown workspace chat tool." };
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { error: "A search query is required." };
    return { evidence: await this.connector.search(parseQuestion(query)) };
  }
}
