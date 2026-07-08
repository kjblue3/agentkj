import type { ChatCompletionTool } from "openai/resources/chat/completions";

export interface AgentToolProvider {
  listAgentTools(): Promise<ChatCompletionTool[]>;
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}
