import { AgentInvestigator } from "../agent/investigator.js";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { ConnectionDescriptor, InvestigationContext } from "../core/context.js";
import type { EvidenceConnector } from "../connectors/types.js";
import { readPublicPage } from "../connectors/publicWebTool.js";
import { createLlmClient, llmModel } from "../llm/client.js";
import type { McpToolRegistry } from "../mcp/registry.js";
import type { Synthesizer } from "../openai/synthesizer.js";
import type { InvestigationResult } from "../types/schemas.js";
import { parseQuestion } from "./queryParser.js";
import { rankEvidence } from "./ranker.js";
import { buildTimeline } from "./timeline.js";

type InvestigationPipelineMetadata = { sourceMode?: InvestigationResult["sourceMode"]; connectors?: string[] };

export interface InvestigateOptions {
  context?: InvestigationContext;
  mcpRegistry?: McpToolRegistry;
  toolProviders?: AgentToolProvider[];
  connectionDescriptors?: ConnectionDescriptor[];
  publicUrl?: string;
  relevantSources?: string[];
  conversationContext?: string;
  connectableServices?: string[];
  requireLlm?: boolean;
  allowGlobalTools?: boolean;
}

export class InvestigationPipeline {
  private readonly agent: AgentInvestigator | null;
  constructor(
    private readonly connectors: EvidenceConnector[],
    private readonly synthesizer: Synthesizer,
    private readonly metadata: InvestigationPipelineMetadata = { sourceMode: "demo" },
    private readonly globalMcpRegistry?: McpToolRegistry,
    env: NodeJS.ProcessEnv = process.env
  ) {
    const client = env.AGENT_ENABLED !== "false" ? createLlmClient(env) : null;
    this.agent = client ? new AgentInvestigator(client, llmModel(env)) : null;
  }

  async investigate(question: string, options: InvestigateOptions = {}): Promise<InvestigationResult> {
    if (this.agent && options.context) {
      const providers = [
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
    if (options.requireLlm) throw new Error("LLM_UNAVAILABLE");
    if (options.publicUrl) return this.withMetadata(await this.publicLinkInvestigate(question, options.publicUrl));
    return this.withMetadata(await this.classicInvestigate(question));
  }

  async getEvidence(id: string) {
    for (const connector of this.connectors) {
      const item = await connector.getById(id);
      if (item) return item;
    }
    return null;
  }

  private async classicInvestigate(question: string): Promise<InvestigationResult> {
    const query = parseQuestion(question);
    const batches = await Promise.all(this.connectors.map((connector) => connector.search(query)));
    const unique = [...new Map(batches.flat().map((item) => [item.id, item])).values()];
    const evidence = rankEvidence(unique, query).map(({ item, score }) => ({
      ...item, confidence: Math.min(1, Math.max(item.confidence ?? 0.5, score / 20))
    }));
    return this.synthesizer.synthesize(question, evidence, buildTimeline(evidence));
  }

  private async publicLinkInvestigate(question: string, url: string): Promise<InvestigationResult> {
    const page = await readPublicPage(url);
    if ("error" in page) return this.classicInvestigate(question);
    const evidence = [{
      id: `web:${Buffer.from(page.sourceUrl).toString("base64url").slice(0, 48)}`,
      source: "web", title: page.title || new URL(page.sourceUrl).hostname, body: page.content,
      url: page.sourceUrl, timestamp: new Date().toISOString(), entities: [], tags: ["public-link"], confidence: 0.8
    }];
    return this.synthesizer.synthesize(question, evidence, buildTimeline(evidence));
  }

  private withMetadata(result: InvestigationResult): InvestigationResult {
    return { ...result, sourceMode: this.metadata.sourceMode, connectors: this.metadata.connectors ?? this.connectors.map((connector) => connector.name) };
  }
}
