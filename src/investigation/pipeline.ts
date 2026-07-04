import { AgentInvestigator, type AgentContext } from "../agent/investigator.js";
import type { EvidenceConnector } from "../connectors/types.js";
import { SlackConnector } from "../connectors/slackConnector.js";
import { GitHubRest } from "../github/githubRest.js";
import { createLlmClient, llmModel } from "../llm/client.js";
import type { McpToolRegistry } from "../mcp/registry.js";
import type { Synthesizer } from "../openai/synthesizer.js";
import type { InvestigationResult } from "../types/schemas.js";
import { parseQuestion } from "./queryParser.js";
import { rankEvidence } from "./ranker.js";
import { buildTimeline } from "./timeline.js";

type InvestigationPipelineMetadata = {
  sourceMode?: InvestigationResult["sourceMode"];
  connectors?: string[];
};

export interface InvestigateOptions {
  /** Per-user GitHub OAuth token (src/auth/tokenStore.ts). Omit to fall back to the shared GITHUB_TOKEN. */
  githubToken?: string;
  githubLogin?: string;
  /** Fixed owner/repo scope. Omit (with a token) to let the agent search across the user's own repos. */
  owner?: string;
  repo?: string;
  /** Part 3: this requester's self-service connectors, merged with the pipeline's global registry. */
  mcpRegistry?: McpToolRegistry;
}

/**
 * Investigates a question. When an LLM is configured (AGENT_ENABLED !== "false" and an
 * LLM_API_KEY/OPENAI_API_KEY is set), this delegates to the tool-calling AgentInvestigator,
 * which can inspect commit diffs, current code, issues, and Slack — not just keyword-match
 * pre-fetched evidence. Only falls back to the older keyword-search-then-narrate flow when no
 * LLM is configured, or when the agent has nothing to search against for this request.
 */
export class InvestigationPipeline {
  private readonly agent: AgentInvestigator | null;
  private readonly sharedSlackConnector?: SlackConnector;

  constructor(
    private readonly connectors: EvidenceConnector[],
    private readonly synthesizer: Synthesizer,
    private readonly metadata: InvestigationPipelineMetadata = { sourceMode: "demo" },
    private readonly globalMcpRegistry?: McpToolRegistry,
    env: NodeJS.ProcessEnv = process.env
  ) {
    const client = env.AGENT_ENABLED !== "false" ? createLlmClient(env) : null;
    this.agent = client ? new AgentInvestigator(client, llmModel(env)) : null;
    this.sharedSlackConnector = connectors.find(
      (connector): connector is SlackConnector => connector instanceof SlackConnector
    );
  }

  async investigate(question: string, opts: InvestigateOptions = {}): Promise<InvestigationResult> {
    if (this.agent) {
      const result = await this.tryAgentInvestigate(question, opts);
      if (result) return this.withMetadata(result);
    }
    return this.withMetadata(await this.classicInvestigate(question));
  }

  async getEvidence(id: string) {
    for (const connector of this.connectors) {
      const item = await connector.getById(id);
      if (item) return item;
    }
    return null;
  }

  private async tryAgentInvestigate(question: string, opts: InvestigateOptions): Promise<InvestigationResult | null> {
    const githubToken = opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    const github = githubToken ? new GitHubRest(githubToken) : undefined;
    // A per-user token with no fixed owner/repo means "search across everything this user can
    // access" (scoped by `login` inside the agent) rather than one hardcoded demo repo.
    const owner = opts.owner ?? (opts.githubToken ? undefined : process.env.GITHUB_OWNER);
    const repo = opts.repo ?? (opts.githubToken ? undefined : process.env.GITHUB_DEMO_REPO || process.env.GITHUB_REPOS?.split(",")[0]?.trim());

    const globalTools = this.globalMcpRegistry ? await this.globalMcpRegistry.listAgentTools() : [];
    const userTools = opts.mcpRegistry ? await opts.mcpRegistry.listAgentTools() : [];
    const externalTools = [...globalTools, ...userTools];
    const externalCall = externalTools.length > 0 ? this.dispatchExternalTool(opts.mcpRegistry) : undefined;

    const ctx: AgentContext = {
      github,
      slack: this.sharedSlackConnector,
      owner,
      repo,
      login: opts.githubLogin,
      externalTools: externalTools.length > 0 ? externalTools : undefined,
      externalCall
    };

    if (!ctx.github && !ctx.slack && !ctx.externalTools) return null;
    return this.agent!.investigate(question, ctx);
  }

  private dispatchExternalTool(
    userRegistry?: McpToolRegistry
  ): (name: string, args: Record<string, unknown>) => Promise<unknown> {
    return async (name, args) => {
      if (userRegistry?.has(name)) return userRegistry.call(name, args);
      if (this.globalMcpRegistry?.has(name)) return this.globalMcpRegistry.call(name, args);
      return { error: `Unknown connector tool: ${name}` };
    };
  }

  private async classicInvestigate(question: string): Promise<InvestigationResult> {
    const query = parseQuestion(question);
    const batches = await Promise.all(this.connectors.map((connector) => connector.search(query)));
    const unique = [...new Map(batches.flat().map((item) => [item.id, item])).values()];
    const ranked = rankEvidence(unique, query);
    const evidence = ranked.map(({ item, score }) => ({
      ...item,
      confidence: Math.min(1, Math.max(item.confidence ?? 0.5, score / 20))
    }));
    const timeline = buildTimeline(evidence);
    return this.synthesizer.synthesize(question, evidence, timeline);
  }

  private withMetadata(result: InvestigationResult): InvestigationResult {
    return {
      ...result,
      sourceMode: this.metadata.sourceMode,
      connectors: this.metadata.connectors ?? this.connectors.map((connector) => connector.name)
    };
  }
}
