import { AgentInvestigator, type AgentContext } from "../agent/investigator.js";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { EvidenceConnector } from "../connectors/types.js";
import { SlackConnector } from "../connectors/slackConnector.js";
import { GitHubRest } from "../github/githubRest.js";
import { createLlmClient, llmModel } from "../llm/client.js";
import type { McpToolRegistry } from "../mcp/registry.js";
import { readPublicPage } from "../connectors/publicWebTool.js";
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
  /** One-request and authorized remote tools, merged after the user's catalog registry. */
  toolProviders?: AgentToolProvider[];
  /** Public link attached to this request; used for deterministic fallback when no agent LLM exists. */
  publicUrl?: string;
  /** Source ids the intent router judged relevant to this question (see AgentContext.relevantSources). */
  relevantSources?: string[];
  /** Not-yet-connected service ids the agent may propose in `suggestedConnection`. */
  connectableServices?: string[];
  /**
   * Whether a missing per-user GitHub token may fall back to the deployment's shared
   * GITHUB_TOKEN env. True for the anonymous HTTP API (its demo contract); Slack requests pass
   * false — a person's investigation uses only what THEY connected. GitHub was scaffolding to
   * prove the loop, never the default source for every question.
   */
  allowSharedGitHubFallback?: boolean;
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
    if (opts.publicUrl) return this.withMetadata(await this.publicLinkInvestigate(question, opts.publicUrl));
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
    const sharedFallback = opts.allowSharedGitHubFallback ?? true;
    const githubToken = opts.githubToken
      ?? (sharedFallback ? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN : undefined);
    const github = githubToken ? new GitHubRest(githubToken) : undefined;
    // A per-user token with no fixed owner/repo means "search across everything this user can
    // access" (scoped by `login` inside the agent) rather than one hardcoded demo repo.
    const owner = opts.owner ?? (opts.githubToken ? undefined : process.env.GITHUB_OWNER);
    const repo = opts.repo ?? (opts.githubToken ? undefined : process.env.GITHUB_DEMO_REPO || process.env.GITHUB_REPOS?.split(",")[0]?.trim());

    const providers: AgentToolProvider[] = [
      ...(this.globalMcpRegistry ? [this.globalMcpRegistry] : []),
      ...(opts.mcpRegistry ? [opts.mcpRegistry] : []),
      ...(opts.toolProviders ?? [])
    ];
    const externalTools = (await Promise.all(providers.map((provider) => provider.listAgentTools()))).flat();
    const externalCall = externalTools.length > 0 ? this.dispatchExternalTool(providers) : undefined;

    const ctx: AgentContext = {
      github,
      slack: this.sharedSlackConnector,
      owner,
      repo,
      login: opts.githubLogin,
      externalTools: externalTools.length > 0 ? externalTools : undefined,
      externalCall,
      relevantSources: opts.relevantSources,
      connectableServices: opts.connectableServices
    };

    if (!ctx.github && !ctx.slack && !ctx.externalTools) return null;
    return this.agent!.investigate(question, ctx);
  }

  private dispatchExternalTool(
    providers: AgentToolProvider[]
  ): (name: string, args: Record<string, unknown>) => Promise<unknown> {
    return async (name, args) => {
      const provider = providers.find((candidate) => candidate.has(name));
      if (provider) return provider.call(name, args);
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

  private async publicLinkInvestigate(question: string, url: string): Promise<InvestigationResult> {
    const page = await readPublicPage(url);
    if ("error" in page) return this.classicInvestigate(question);
    const evidence = [{
      id: `web:${Buffer.from(page.sourceUrl).toString("base64url").slice(0, 48)}`,
      source: "web" as const,
      title: page.title || new URL(page.sourceUrl).hostname,
      body: page.content,
      url: page.sourceUrl,
      timestamp: new Date().toISOString(),
      entities: [],
      tags: ["public-link"],
      confidence: 0.8
    }];
    return this.synthesizer.synthesize(question, evidence, buildTimeline(evidence));
  }

  private withMetadata(result: InvestigationResult): InvestigationResult {
    return {
      ...result,
      sourceMode: this.metadata.sourceMode,
      connectors: this.metadata.connectors ?? this.connectors.map((connector) => connector.name)
    };
  }
}
