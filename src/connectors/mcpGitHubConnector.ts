import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import {
  buildEntities,
  buildTags,
  normalizeEvidenceItem,
  queryText
} from "./connectorUtils.js";
import { StdioMcpClient, type McpToolClient } from "./mcpClient.js";
import type { EvidenceConnector } from "./types.js";

interface McpGitHubOptions {
  owner: string;
  repo: string;
  command?: string;
  client?: McpToolClient;
  toolNames?: Partial<McpGitHubToolNames>;
}

interface McpGitHubToolNames {
  searchIssues: string;
  searchCode: string;
  getIssue: string;
  getPullRequest: string;
  getFileContents: string;
}

interface GitHubIssueLike {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  url?: string;
  updated_at?: string;
  created_at?: string;
  user?: { login?: string } | string;
  labels?: Array<string | { name?: string }>;
  repository_url?: string;
  repository?: { full_name?: string };
  pull_request?: unknown;
}

interface GitHubCodeLike {
  name?: string;
  path?: string;
  sha?: string;
  html_url?: string;
  url?: string;
  repository?: { full_name?: string };
  text?: string;
  content?: string;
}

const defaultToolCandidates: Record<keyof McpGitHubToolNames, string[]> = {
  searchIssues: ["search_issues", "github_search_issues", "searchIssues"],
  searchCode: ["search_code", "github_search_code", "searchCode"],
  getIssue: ["get_issue", "github_get_issue", "getIssue"],
  getPullRequest: ["get_pull_request", "github_get_pull_request", "getPullRequest"],
  getFileContents: ["get_file_contents", "get_file", "github_get_file_contents"]
};

export class McpGitHubConnector implements EvidenceConnector {
  readonly name = "GitHub MCP";
  private readonly cache = new Map<string, EvidenceItem>();
  private readonly toolNames: Partial<McpGitHubToolNames>;
  private client?: McpToolClient;
  private toolList?: Set<string>;

  constructor(private readonly options: McpGitHubOptions) {
    this.toolNames = options.toolNames ?? {};
    this.client = options.client;
  }

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const [issues, code] = await Promise.all([
      this.searchIssues(query),
      this.searchCode(query)
    ]);
    return [...issues, ...code];
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const issueMatch = /^github:issue:([^:]+):(\d+)$/.exec(id);
    if (issueMatch?.[1] && issueMatch[2]) {
      const fullRepo = issueMatch[1];
      const number = Number(issueMatch[2]);
      const [owner, repo] = splitRepo(fullRepo, this.options.owner, this.options.repo);
      const issue = await this.callFirstAvailable("getIssue", { owner, repo, issue_number: number, issueNumber: number, number })
        ?? await this.callFirstAvailable("getPullRequest", { owner, repo, pull_number: number, pullNumber: number, number });
      return this.firstIssue(issue)
        ? this.issueToEvidence(this.firstIssue(issue), { originalQuestion: "", keywords: [], entities: [], tags: [] })
        : null;
    }

    const codeMatch = /^github:code:([^:]+):([^:]+):(.+)$/.exec(id);
    if (codeMatch?.[1] && codeMatch[3]) {
      const [owner, repo] = splitRepo(codeMatch[1], this.options.owner, this.options.repo);
      const payload = await this.callFirstAvailable("getFileContents", {
        owner,
        repo,
        path: codeMatch[3],
        ref: "main"
      });
      const code = this.firstCode(payload);
      return code ? this.codeToEvidence(code, { originalQuestion: "", keywords: [], entities: [], tags: [] }) : null;
    }

    return null;
  }

  private async searchIssues(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const payload = await this.callFirstAvailable("searchIssues", {
      owner: this.options.owner,
      repo: this.options.repo,
      q: `${queryText(query)} repo:${this.fullRepo}`,
      query: `${queryText(query)} repo:${this.fullRepo}`,
      per_page: 10,
      perPage: 10
    });
    return this.issueItems(payload).map((issue) => this.issueToEvidence(issue, query));
  }

  private async searchCode(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const payload = await this.callFirstAvailable("searchCode", {
      owner: this.options.owner,
      repo: this.options.repo,
      q: `${queryText(query)} repo:${this.fullRepo}`,
      query: `${queryText(query)} repo:${this.fullRepo}`,
      per_page: 10,
      perPage: 10
    });
    return this.codeItems(payload).map((item) => this.codeToEvidence(item, query));
  }

  private async callFirstAvailable(kind: keyof McpGitHubToolNames, args: Record<string, unknown>): Promise<unknown | null> {
    const names = await this.candidateToolNames(kind);
    for (const name of names) {
      try {
        return await this.getClient().callTool(name, args);
      } catch (error) {
        console.warn(`${this.name} tool ${name} failed.`, error);
      }
    }
    return null;
  }

  private async candidateToolNames(kind: keyof McpGitHubToolNames): Promise<string[]> {
    const configured = this.toolNames[kind];
    const candidates = configured ? [configured, ...defaultToolCandidates[kind]] : defaultToolCandidates[kind];
    const uniqueCandidates = [...new Set(candidates)];

    try {
      const available = await this.availableTools();
      const matching = uniqueCandidates.filter((name) => available.has(name));
      return matching.length > 0 ? matching : uniqueCandidates;
    } catch {
      return uniqueCandidates;
    }
  }

  private async availableTools(): Promise<Set<string>> {
    if (!this.toolList) {
      this.toolList = new Set((await this.getClient().listTools()).map((tool) => tool.name));
    }
    return this.toolList;
  }

  private getClient(): McpToolClient {
    if (!this.client) {
      if (!this.options.command) throw new Error("MCP_GITHUB_COMMAND is required for GitHub MCP.");
      this.client = new StdioMcpClient(this.options.command);
    }
    return this.client;
  }

  private issueItems(payload: unknown): GitHubIssueLike[] {
    const value = unwrapMcpPayload(payload);
    if (Array.isArray(value)) return value.filter(isIssueLike);
    const record = asRecord(value);
    for (const key of ["items", "issues", "pull_requests", "results", "data"]) {
      const child = record[key];
      if (Array.isArray(child)) return child.filter(isIssueLike);
    }
    return isIssueLike(record) ? [record] : [];
  }

  private codeItems(payload: unknown): GitHubCodeLike[] {
    const value = unwrapMcpPayload(payload);
    if (Array.isArray(value)) return value.filter(isCodeLike);
    const record = asRecord(value);
    for (const key of ["items", "files", "results", "data"]) {
      const child = record[key];
      if (Array.isArray(child)) return child.filter(isCodeLike);
    }
    return isCodeLike(record) ? [record] : [];
  }

  private firstIssue(payload: unknown): GitHubIssueLike {
    return this.issueItems(payload)[0] ?? {};
  }

  private firstCode(payload: unknown): GitHubCodeLike | undefined {
    return this.codeItems(payload)[0];
  }

  private issueToEvidence(issue: GitHubIssueLike, query: InvestigationQuery): EvidenceItem {
    const fullRepo = repoFromIssue(issue, this.fullRepo);
    const number = issue.number ?? 0;
    const title = issue.title ?? `GitHub issue ${number}`;
    const kind = issue.pull_request ? "pull request" : "issue";
    const labelTags = (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : label.name ?? ""
    );
    const body = issue.body?.trim() || `${kind} ${number} in ${fullRepo}`;
    const item = normalizeEvidenceItem({
      id: `github:issue:${fullRepo}:${number}`,
      source: "github",
      title: `GitHub ${kind}: ${title}`,
      body,
      url: sourceUrl(issue.html_url ?? issue.url, `https://github.com/${fullRepo}/issues/${number}`),
      author: typeof issue.user === "string" ? issue.user : issue.user?.login,
      timestamp: issue.updated_at ?? issue.created_at,
      entities: buildEntities(query, `${title} ${body}`, [fullRepo]),
      tags: buildTags(query, ["github", "mcp", kind, ...labelTags]),
      confidence: 0.74
    });
    this.cache.set(item.id, item);
    return item;
  }

  private codeToEvidence(result: GitHubCodeLike, query: InvestigationQuery): EvidenceItem {
    const repo = result.repository?.full_name ?? this.fullRepo;
    const path = result.path ?? result.name ?? "unknown";
    const sha = result.sha ?? "mcp";
    const body = result.text ?? result.content ?? `MCP code search match in ${repo}/${path}.`;
    const item = normalizeEvidenceItem({
      id: `github:code:${repo}:${sha}:${path}`,
      source: "github",
      title: `GitHub code: ${path}`,
      body,
      url: sourceUrl(result.html_url ?? result.url, `https://github.com/${repo}/blob/main/${path}`),
      timestamp: new Date().toISOString(),
      entities: buildEntities(query, body, [repo, path]),
      tags: buildTags(query, ["github", "mcp", "code"]),
      confidence: 0.6
    });
    this.cache.set(item.id, item);
    return item;
  }

  private get fullRepo(): string {
    return `${this.options.owner}/${this.options.repo}`;
  }
}

function unwrapMcpPayload(payload: unknown): unknown {
  const record = asRecord(payload);
  if (record.structuredContent) return record.structuredContent;
  if (record.content && Array.isArray(record.content)) {
    const parsed = record.content
      .map((item) => asRecord(item).text)
      .filter((text): text is string => typeof text === "string")
      .map(parseJsonMaybe)
      .find((value) => value !== null);
    if (parsed !== undefined) return parsed;
  }
  return payload;
}

function parseJsonMaybe(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return value.trim() ? { text: value } : null;
  }
}

function repoFromIssue(issue: GitHubIssueLike, fallback: string): string {
  const apiPrefix = "https://api.github.com/repos/";
  if (issue.repository_url?.startsWith(apiPrefix)) return issue.repository_url.slice(apiPrefix.length);
  return issue.repository?.full_name ?? fallback;
}

function splitRepo(fullRepo: string, fallbackOwner: string, fallbackRepo: string): [string, string] {
  const [owner, repo] = fullRepo.split("/");
  return [owner || fallbackOwner, repo || fallbackRepo];
}

function sourceUrl(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && /^https?:\/\//.test(candidate) ? candidate : fallback;
}

function isIssueLike(value: unknown): value is GitHubIssueLike {
  const record = asRecord(value);
  return typeof record.title === "string" || typeof record.number === "number" || typeof record.body === "string";
}

function isCodeLike(value: unknown): value is GitHubCodeLike {
  const record = asRecord(value);
  return typeof record.path === "string" || typeof record.name === "string" || typeof record.content === "string";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
