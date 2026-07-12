import type OpenAI from "openai";
import { AgentInvestigator } from "../agent/investigator.js";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { ConnectionDescriptor, InvestigationContext } from "../core/context.js";
import type { EvidenceConnector } from "../connectors/types.js";
import { createLlmClient, llmModel } from "../llm/client.js";
import type { McpToolRegistry } from "../mcp/registry.js";
import type { InvestigationResult } from "../types/schemas.js";
import { EvidenceStoreToolProvider } from "./evidenceToolProvider.js";

type InvestigationPipelineMetadata = { sourceMode?: InvestigationResult["sourceMode"]; connectors?: string[] };

export interface InvestigateOptions {
  context?: InvestigationContext;
  mcpRegistry?: McpToolRegistry;
  toolProviders?: AgentToolProvider[];
  connectionDescriptors?: ConnectionDescriptor[];
  relevantSources?: string[];
  conversationContext?: string;
  connectableServices?: string[];
  allowGlobalTools?: boolean;
}

/**
 * Every investigation is agent-driven; there is no deterministic synthesis path. Without a
 * configured language model the pipeline refuses to answer rather than degrade to templates.
 */
export class InvestigationPipeline {
  private readonly agent: AgentInvestigator | null;
  private readonly evidenceStore: EvidenceStoreToolProvider;

  constructor(
    private readonly connectors: EvidenceConnector[],
    private readonly metadata: InvestigationPipelineMetadata = { sourceMode: "demo" },
    private readonly globalMcpRegistry?: McpToolRegistry,
    env: NodeJS.ProcessEnv = process.env,
    client?: OpenAI | null
  ) {
    const resolved = client !== undefined ? client : env.AGENT_ENABLED !== "false" ? createLlmClient(env) : null;
    this.agent = resolved ? new AgentInvestigator(resolved, llmModel(env)) : null;
    this.evidenceStore = new EvidenceStoreToolProvider(connectors);
  }

  async investigate(question: string, options: InvestigateOptions = {}): Promise<InvestigationResult> {
    if (!this.agent) throw new Error("LLM_UNAVAILABLE");
    const providers = [
      this.evidenceStore,
      ...(options.allowGlobalTools && this.globalMcpRegistry ? [this.globalMcpRegistry] : []),
      ...(options.mcpRegistry ? [options.mcpRegistry] : []),
      ...(options.toolProviders ?? [])
    ];
    const tools = (await Promise.all(providers.map((provider) => provider.listAgentTools()))).flat();
    const result = await this.agent.investigate(question, {
      externalTools: tools,
      externalCall: async (name, args) => providers.find((provider) => provider.has(name))?.call(name, args)
        ?? { error: `Unknown connector tool: ${name}` },
      connections: options.connectionDescriptors,
      relevantSources: options.relevantSources,
      connectableServices: options.connectableServices,
      conversationContext: options.conversationContext
    });
    return this.withMetadata(result);
  }

  async getEvidence(id: string) {
    for (const connector of this.connectors) {
      const item = await connector.getById(id);
      if (item) return item;
    }
    return null;
  }

  private withMetadata(result: InvestigationResult): InvestigationResult {
    return { ...result, sourceMode: this.metadata.sourceMode, connectors: this.metadata.connectors ?? this.connectors.map((connector) => connector.name) };
  }
}
