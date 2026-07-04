import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool
} from "openai/resources/chat/completions";
import { normalizeEvidenceItem, truncate } from "../connectors/connectorUtils.js";
import type { SlackConnector } from "../connectors/slackConnector.js";
import { GitHubRest } from "../github/githubRest.js";
import { buildTimeline } from "../investigation/timeline.js";
import {
  investigationResultSchema,
  type EvidenceItem,
  type InvestigationQuery,
  type InvestigationResult
} from "../types/schemas.js";

const MAX_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are Slack Detective, an investigation agent with tools to inspect a codebase and Slack history.

You do NOT get to search by matching the literal words in the question. A symptom like "the game is all red" will
never appear as the string "red" in source code — it might be a commit that set a color to (255, 0, 0). Your job is
to reason from the symptom to the actual change: look at recent commits, read their diffs, read files, and check
issues/Slack for corroborating human reports. Prefer inspecting *what changed recently* over keyword search alone.

Call tools iteratively. When you are confident, call \`finish\` with your conclusion. Cite evidence using the
bracketed [id] values returned by tools. Never invent facts, files, commits, or evidence that no tool returned.`;

export interface AgentContext {
  github?: GitHubRest;
  slack?: SlackConnector;
  /** Fixed repo scope, e.g. a shared demo repo. Omit to let the agent search across `login`'s repos. */
  owner?: string;
  repo?: string;
  /** The connecting user's GitHub login, used to scope search to `user:<login>` when owner/repo aren't fixed. */
  login?: string;
  /** Part 3 hook: additional tool schemas contributed by the pluggable MCP registry (src/mcp/registry.ts). */
  externalTools?: ChatCompletionTool[];
  /** Part 3 hook: dispatch for any tool name not recognized natively (routed to the MCP registry). */
  externalCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface FinishArgs {
  shortAnswer: string;
  confidence: "low" | "medium" | "high";
  likelyRootCause: string;
  openQuestions?: string[];
  recommendedActions?: string[];
}

function isFunctionToolCall(
  call: ChatCompletionMessageToolCall
): call is Extract<ChatCompletionMessageToolCall, { type: "function" }> {
  return call.type === "function";
}

function tool(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters } };
}

function fallbackFinish(evidence: EvidenceItem[]): FinishArgs {
  if (evidence.length === 0) {
    return {
      shortAnswer: "No evidence was found using the available tools.",
      confidence: "low",
      likelyRootCause: "Unable to determine a root cause — try naming a repo, file, or narrower symptom.",
      openQuestions: ["Which repository or channel should be investigated?"],
      recommendedActions: ["Point the investigation at a specific repo or time range and retry."]
    };
  }
  return {
    shortAnswer: evidence[0]!.title,
    confidence: evidence.length >= 2 ? "medium" : "low",
    likelyRootCause: truncate(evidence[0]!.body, 400),
    openQuestions: ["Does this evidence fully explain the symptom, or is more investigation needed?"],
    recommendedActions: ["Confirm this finding with the repo owner before treating it as root cause."]
  };
}

/**
 * Tool-calling investigation loop: the LLM decides which tools to call, sees real results
 * (including commit diffs), and iterates until it calls `finish`. This replaces the old
 * "expand keywords → AND-match → narrate" pipeline for callers that provide an AgentContext.
 */
export class AgentInvestigator {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async investigate(question: string, ctx: AgentContext): Promise<InvestigationResult> {
    const evidence = new Map<string, EvidenceItem>();
    const tools = this.buildTools(ctx);

    const scoutSummary = await this.scout(question, ctx, evidence);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
      {
        role: "user",
        content: scoutSummary
          ? `Initial scan results (already collected as evidence):\n${scoutSummary}\n\nInvestigate further with tools as needed — especially recent commits and their diffs — then call finish.`
          : "Initial scan found nothing. Use the tools directly, then call finish."
      }
    ];

    let finishArgs: FinishArgs | null = null;

    for (let i = 0; i < MAX_ITERATIONS && !finishArgs; i++) {
      const forceFinish = i === MAX_ITERATIONS - 1;
      const request = {
        model: this.model,
        messages,
        tools,
        // Groq's Llama models are unreliable with parallel tool calls — offering several tools at
        // once with parallel calling on tends to make them regress to their native chat-template
        // `<function=name>{...}</function>` text instead of the structured JSON call the API
        // expects, which Groq then rejects with a `tool_use_failed` 400. Forcing single calls
        // avoids that failure mode; OpenAI accepts this field too, so it's safe either way.
        parallel_tool_calls: false,
        tool_choice: forceFinish ? { type: "function" as const, function: { name: "finish" } } : "auto" as const
      };
      let response;
      try {
        response = await this.client.chat.completions.create(request);
      } catch (error) {
        // One retry: this failure mode is model-side flakiness, not a permanent condition, so a
        // clean second attempt (with a nudge toward valid JSON) recovers a real fraction of the
        // time. If it fails twice, stop rather than let the whole investigation crash.
        console.warn("Agent loop: LLM call failed, retrying once.", error);
        messages.push({
          role: "user",
          content: "Your last tool call was not valid JSON. Call exactly one tool at a time using the provided schema."
        });
        try {
          response = await this.client.chat.completions.create(request);
        } catch (retryError) {
          console.warn("Agent loop: retry failed too; finishing with evidence gathered so far.", retryError);
          break;
        }
      }

      const message = response.choices[0]?.message;
      if (!message) break;
      messages.push(message);

      const toolCalls = (message.tool_calls ?? []).filter(isFunctionToolCall);
      if (toolCalls.length === 0) {
        messages.push({ role: "user", content: "Call the `finish` tool now with your conclusion." });
        continue;
      }

      const results = await Promise.all(toolCalls.map((call) => this.executeTool(call, ctx, evidence)));
      for (let idx = 0; idx < toolCalls.length; idx++) {
        const call = toolCalls[idx]!;
        if (call.function.name === "finish") finishArgs = results[idx] as FinishArgs;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: truncate(JSON.stringify(results[idx] ?? {}), 4000)
        });
      }
    }

    const evidenceList = [...evidence.values()];
    const timeline = buildTimeline(evidenceList);
    const draft = finishArgs ?? fallbackFinish(evidenceList);

    return investigationResultSchema.parse({
      question,
      shortAnswer: draft.shortAnswer,
      confidence: draft.confidence,
      likelyRootCause: draft.likelyRootCause,
      timeline,
      evidence: evidenceList,
      openQuestions: draft.openQuestions ?? [],
      recommendedActions: draft.recommendedActions ?? []
    });
  }

  /** Parallel pre-step so the first LLM turn already has real context instead of starting cold. */
  private async scout(question: string, ctx: AgentContext, evidence: Map<string, EvidenceItem>): Promise<string> {
    const tasks: Promise<unknown>[] = [];
    if (ctx.github) {
      tasks.push(this.toolSearchCode({ q: question }, ctx, evidence).catch(() => null));
      tasks.push(this.toolSearchIssues({ q: question }, ctx, evidence).catch(() => null));
      if (ctx.owner && ctx.repo) {
        tasks.push(this.toolListCommits({}, ctx, evidence).catch(() => null));
      }
    }
    if (ctx.slack) {
      tasks.push(this.toolSearchSlack({ query: question }, ctx, evidence).catch(() => null));
    }
    await Promise.all(tasks);
    return [...evidence.values()].map((item) => `- [${item.id}] ${item.title}`).join("\n");
  }

  private buildTools(ctx: AgentContext): ChatCompletionTool[] {
    const tools: ChatCompletionTool[] = [];

    if (ctx.github) {
      tools.push(
        tool(
          "search_code",
          "Search code across the repo(s) this agent has access to, by keyword, symbol, or literal string.",
          { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
        ),
        tool("search_issues", "Search GitHub issues and pull requests by keyword.", {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"]
        }),
        tool(
          "list_recent_commits",
          "List the most recent commits, optionally filtered to a file path. Use this FIRST when investigating a regression — find what changed recently before searching keywords.",
          {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              path: { type: "string", description: "Optional file path to filter commits touching that file." },
              limit: { type: "number" }
            }
          }
        ),
        tool(
          "get_commit",
          "Get the full diff/patch for a specific commit sha — this is how you see the ACTUAL code change (e.g. a color value, a config flag), not just its commit message.",
          {
            type: "object",
            properties: { owner: { type: "string" }, repo: { type: "string" }, sha: { type: "string" } },
            required: ["sha"]
          }
        ),
        tool("read_file", "Read the current contents of a file in a repo.", {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            path: { type: "string" },
            ref: { type: "string" }
          },
          required: ["path"]
        })
      );
    }

    if (ctx.slack) {
      tools.push(
        tool("search_slack", "Search Slack messages related to the investigation.", {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        })
      );
    }

    tools.push(...(ctx.externalTools ?? []));

    tools.push(
      tool(
        "finish",
        "Call this once when you have a confident, evidence-backed conclusion. This ends the investigation.",
        {
          type: "object",
          properties: {
            shortAnswer: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            likelyRootCause: { type: "string" },
            openQuestions: { type: "array", items: { type: "string" } },
            recommendedActions: { type: "array", items: { type: "string" } }
          },
          required: ["shortAnswer", "confidence", "likelyRootCause"]
        }
      )
    );

    return tools;
  }

  private async executeTool(
    call: Extract<ChatCompletionMessageToolCall, { type: "function" }>,
    ctx: AgentContext,
    evidence: Map<string, EvidenceItem>
  ): Promise<unknown> {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // Model sometimes emits malformed JSON args; proceed with empty args rather than crash the loop.
    }

    try {
      switch (name) {
        case "search_code":
          return await this.toolSearchCode(args, ctx, evidence);
        case "search_issues":
          return await this.toolSearchIssues(args, ctx, evidence);
        case "list_recent_commits":
          return await this.toolListCommits(args, ctx, evidence);
        case "get_commit":
          return await this.toolGetCommit(args, ctx, evidence);
        case "read_file":
          return await this.toolReadFile(args, ctx, evidence);
        case "search_slack":
          return await this.toolSearchSlack(args, ctx, evidence);
        case "finish":
          return args as unknown as FinishArgs;
        default:
          if (ctx.externalCall) return await ctx.externalCall(name, args);
          return { error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private scopeQualifier(args: Record<string, unknown>, ctx: AgentContext): string {
    const owner = (args.owner as string | undefined) ?? ctx.owner;
    const repo = (args.repo as string | undefined) ?? ctx.repo;
    if (owner && repo) return `repo:${owner}/${repo}`;
    if (ctx.login) return `user:${ctx.login}`;
    return "";
  }

  private async toolSearchCode(args: Record<string, unknown>, ctx: AgentContext, evidence: Map<string, EvidenceItem>) {
    if (!ctx.github) return { error: "GitHub is not connected." };
    const q = `${String(args.q ?? "")} ${this.scopeQualifier(args, ctx)}`.trim();
    if (!q) return { error: "A search query is required." };
    const items = await ctx.github.searchCode({ q });
    const mapped = items.map((raw) => this.codeToEvidence(raw, ctx));
    for (const item of mapped) evidence.set(item.id, item);
    return mapped.slice(0, 8).map((item) => ({ id: item.id, title: item.title, url: item.url }));
  }

  private async toolSearchIssues(args: Record<string, unknown>, ctx: AgentContext, evidence: Map<string, EvidenceItem>) {
    if (!ctx.github) return { error: "GitHub is not connected." };
    const q = `${String(args.q ?? "")} ${this.scopeQualifier(args, ctx)}`.trim();
    if (!q) return { error: "A search query is required." };
    const items = await ctx.github.searchIssues({ q });
    const mapped = items.map((raw) => this.issueToEvidence(raw, ctx));
    for (const item of mapped) evidence.set(item.id, item);
    return mapped
      .slice(0, 8)
      .map((item) => ({ id: item.id, title: item.title, url: item.url, snippet: truncate(item.body, 300) }));
  }

  private async toolListCommits(args: Record<string, unknown>, ctx: AgentContext, _evidence: Map<string, EvidenceItem>) {
    if (!ctx.github) return { error: "GitHub is not connected." };
    const owner = (args.owner as string | undefined) ?? ctx.owner;
    const repo = (args.repo as string | undefined) ?? ctx.repo;
    if (!owner || !repo) {
      return { error: "owner and repo are required (search_code/search_issues results include a repo full_name)." };
    }
    const commits = await ctx.github.listRecentCommits({
      owner,
      repo,
      limit: (args.limit as number | undefined) ?? 10,
      path: args.path as string | undefined
    });
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message.split("\n")[0],
      author: commit.author,
      date: commit.date
    }));
  }

  private async toolGetCommit(args: Record<string, unknown>, ctx: AgentContext, evidence: Map<string, EvidenceItem>) {
    if (!ctx.github) return { error: "GitHub is not connected." };
    const owner = (args.owner as string | undefined) ?? ctx.owner;
    const repo = (args.repo as string | undefined) ?? ctx.repo;
    const sha = args.sha as string | undefined;
    if (!owner || !repo || !sha) return { error: "owner, repo, and sha are required." };

    const commit = await ctx.github.getCommit({ owner, repo, sha });
    if (!commit) return { error: "Commit not found." };

    const diffText = commit.files
      .map((file) => `--- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n${file.patch ?? "(no textual diff — binary or too large)"}`)
      .join("\n\n");

    const item = normalizeEvidenceItem({
      id: `github:commit:${owner}/${repo}:${commit.sha}`,
      source: "github",
      title: `Commit ${commit.sha.slice(0, 7)}: ${commit.message.split("\n")[0]}`,
      body: `${commit.message}\n\n${diffText}`,
      url: commit.url,
      author: commit.author,
      timestamp: commit.date,
      entities: [`${owner}/${repo}`],
      tags: ["github", "commit", "diff"],
      confidence: 0.8
    });
    evidence.set(item.id, item);
    return { id: item.id, title: item.title, url: item.url, diff: truncate(diffText, 3000) };
  }

  private async toolReadFile(args: Record<string, unknown>, ctx: AgentContext, evidence: Map<string, EvidenceItem>) {
    if (!ctx.github) return { error: "GitHub is not connected." };
    const owner = (args.owner as string | undefined) ?? ctx.owner;
    const repo = (args.repo as string | undefined) ?? ctx.repo;
    const path = args.path as string | undefined;
    if (!owner || !repo || !path) return { error: "owner, repo, and path are required." };

    const ref = args.ref as string | undefined;
    const content = await ctx.github.getFileContents({ owner, repo, path, ref });
    if (content === null) return { error: "File not found." };

    const item = normalizeEvidenceItem({
      id: `github:file:${owner}/${repo}:${ref ?? "HEAD"}:${path}`,
      source: "github",
      title: `GitHub file: ${path}`,
      body: content,
      url: `https://github.com/${owner}/${repo}/blob/${ref ?? "main"}/${path}`,
      entities: [`${owner}/${repo}`, path],
      tags: ["github", "file"],
      confidence: 0.65
    });
    evidence.set(item.id, item);
    return { id: item.id, content: truncate(content, 3000) };
  }

  private async toolSearchSlack(args: Record<string, unknown>, ctx: AgentContext, evidence: Map<string, EvidenceItem>) {
    if (!ctx.slack) return { error: "Slack is not connected." };
    const queryText = String(args.query ?? "");
    if (!queryText) return { error: "A search query is required." };
    const query: InvestigationQuery = { originalQuestion: queryText, keywords: [queryText], entities: [], tags: [] };
    const rawItems = await ctx.slack.search(query);
    // A question asked by @-mentioning the bot ("<@BOTID> why is my game all red") is itself an
    // indexed Slack message and near-guaranteed to match a search for its own words — filter out
    // messages that open with a user mention so the agent doesn't cite its own invocation as
    // evidence for the thing it's investigating.
    const items = rawItems.filter((item) => !/^\s*<@[A-Z0-9]+>/i.test(item.body));
    for (const item of items) evidence.set(item.id, item);
    return items
      .slice(0, 5)
      .map((item) => ({ id: item.id, title: item.title, url: item.url, snippet: truncate(item.body, 300) }));
  }

  private codeToEvidence(raw: Record<string, unknown>, ctx: AgentContext): EvidenceItem {
    const repository = raw.repository as { full_name?: string } | undefined;
    const repo = repository?.full_name ?? `${ctx.owner ?? "unknown"}/${ctx.repo ?? "unknown"}`;
    const path = (raw.path as string | undefined) ?? (raw.name as string | undefined) ?? "unknown";
    const sha = (raw.sha as string | undefined) ?? "code-search";
    return normalizeEvidenceItem({
      id: `github:code:${repo}:${sha}:${path}`,
      source: "github",
      title: `GitHub code: ${path}`,
      body: `Code search match in ${repo}/${path}. Use read_file to see the full contents.`,
      url: (raw.html_url as string | undefined) ?? `https://github.com/${repo}/blob/main/${path}`,
      entities: [repo, path],
      tags: ["github", "code"],
      confidence: 0.6
    });
  }

  private issueToEvidence(raw: Record<string, unknown>, ctx: AgentContext): EvidenceItem {
    const repositoryUrl = raw.repository_url as string | undefined;
    const apiPrefix = "https://api.github.com/repos/";
    const fullRepo = repositoryUrl?.startsWith(apiPrefix)
      ? repositoryUrl.slice(apiPrefix.length)
      : `${ctx.owner ?? "unknown"}/${ctx.repo ?? "unknown"}`;
    const number = (raw.number as number | undefined) ?? 0;
    const kind = raw.pull_request ? "pull request" : "issue";
    const title = (raw.title as string | undefined) ?? `GitHub ${kind} ${number}`;
    const rawBody = raw.body as string | null | undefined;
    const body = rawBody?.trim() || `${kind} ${number} in ${fullRepo}`;
    const user = raw.user as { login?: string } | undefined;
    return normalizeEvidenceItem({
      id: `github:issue:${fullRepo}:${number}`,
      source: "github",
      title: `GitHub ${kind}: ${title}`,
      body,
      url: (raw.html_url as string | undefined) ?? `https://github.com/${fullRepo}/issues/${number}`,
      author: user?.login,
      timestamp: (raw.updated_at as string | undefined) ?? (raw.created_at as string | undefined),
      entities: [fullRepo],
      tags: ["github", kind],
      confidence: 0.72
    });
  }
}
