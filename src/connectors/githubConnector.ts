import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import type { EvidenceConnector } from "./types.js";
import {
  buildEntities,
  buildTags,
  fetchJson,
  normalizeEvidenceItem,
  queryText,
  type FetchLike
} from "./connectorUtils.js";

interface GitHubIssueSearchResponse {
  items?: GitHubIssue[];
}

interface GitHubCodeSearchResponse {
  items?: GitHubCodeResult[];
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  updated_at?: string;
  created_at?: string;
  user?: { login?: string };
  labels?: Array<string | { name?: string }>;
  repository_url?: string;
  pull_request?: unknown;
}

interface GitHubCodeResult {
  name: string;
  path: string;
  sha: string;
  html_url: string;
  repository?: { full_name?: string };
}

export class GitHubConnector implements EvidenceConnector {
  readonly name = "GitHub";
  private readonly cache = new Map<string, EvidenceItem>();

  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repos: string[],
    private readonly fetcher: FetchLike = fetch
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const batches = await Promise.all(
      this.repos.flatMap((repo) => [
        this.searchIssues(query, repo),
        this.searchCode(query, repo)
      ])
    );
    return batches.flat();
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const match = /^github:issue:([^:]+):(\d+)$/.exec(id);
    if (!match) return null;
    const [, fullRepo, number] = match;
    const issue = await fetchJson<GitHubIssue>(
      this.fetcher,
      `https://api.github.com/repos/${fullRepo}/issues/${number}`,
      { headers: this.headers() },
      this.name
    );
    return issue ? this.issueToEvidence(issue, { originalQuestion: "", keywords: [], entities: [], tags: [] }) : null;
  }

  private async searchIssues(query: InvestigationQuery, repo: string): Promise<EvidenceItem[]> {
    const params = new URLSearchParams({
      q: `${queryText(query)} in:title,body,comments repo:${this.owner}/${repo}`,
      per_page: "10"
    });
    const payload = await fetchJson<GitHubIssueSearchResponse>(
      this.fetcher,
      `https://api.github.com/search/issues?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return (payload?.items ?? []).map((issue) => this.issueToEvidence(issue, query));
  }

  private async searchCode(query: InvestigationQuery, repo: string): Promise<EvidenceItem[]> {
    const params = new URLSearchParams({
      q: `${queryText(query)} repo:${this.owner}/${repo}`,
      per_page: "10"
    });
    const payload = await fetchJson<GitHubCodeSearchResponse>(
      this.fetcher,
      `https://api.github.com/search/code?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return (payload?.items ?? []).map((item) => this.codeToEvidence(item, query));
  }

  private issueToEvidence(issue: GitHubIssue, query: InvestigationQuery): EvidenceItem {
    const fullRepo = this.repoFromIssue(issue);
    const kind = issue.pull_request ? "pull request" : "issue";
    const labelTags = (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : label.name ?? ""
    );
    const body = issue.body?.trim() || `${kind} ${issue.number} in ${fullRepo}`;
    const item = normalizeEvidenceItem({
      id: `github:issue:${fullRepo}:${issue.number}`,
      source: "github",
      title: `GitHub ${kind}: ${issue.title}`,
      body,
      url: issue.html_url,
      author: issue.user?.login,
      timestamp: issue.updated_at ?? issue.created_at,
      entities: buildEntities(query, `${issue.title} ${body}`, [fullRepo]),
      tags: buildTags(query, ["github", kind, ...labelTags]),
      confidence: 0.7
    });
    this.cache.set(item.id, item);
    return item;
  }

  private codeToEvidence(result: GitHubCodeResult, query: InvestigationQuery): EvidenceItem {
    const repo = result.repository?.full_name ?? `${this.owner}/${this.repos[0] ?? "unknown"}`;
    const body = `Code search match in ${repo}/${result.path}. Fetch the linked file for the exact surrounding implementation.`;
    const item = normalizeEvidenceItem({
      id: `github:code:${repo}:${result.sha}:${result.path}`,
      source: "github",
      title: `GitHub code: ${result.path}`,
      body,
      url: result.html_url,
      timestamp: new Date().toISOString(),
      entities: buildEntities(query, body, [repo, result.path]),
      tags: buildTags(query, ["github", "code"]),
      confidence: 0.58
    });
    this.cache.set(item.id, item);
    return item;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  private repoFromIssue(issue: GitHubIssue): string {
    const apiPrefix = "https://api.github.com/repos/";
    if (issue.repository_url?.startsWith(apiPrefix)) {
      return issue.repository_url.slice(apiPrefix.length);
    }
    return `${this.owner}/${this.repos[0] ?? "unknown"}`;
  }
}
