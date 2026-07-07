import { fetchJson, type FetchLike } from "../connectors/connectorUtils.js";

/**
 * Thin GitHub REST wrapper used by the agentic investigator (src/agent/investigator.ts).
 * Unlike the older GitHubConnector/McpGitHubConnector, this takes a bare `token` in its
 * constructor with no owner/repo baked in — that's what makes it usable both for the shared
 * demo token AND per-user OAuth tokens (src/auth/githubOAuth.ts), one instance per request.
 *
 * Crucially, this is the only GitHub client in the repo that exposes commit history + diffs
 * (`listRecentCommits` / `getCommit`) — the old connectors only ever searched issues and
 * current file contents, so they could never see *what changed*.
 */

interface RawCommitSummary {
  sha: string;
  html_url: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}

interface RawCommitDetail extends RawCommitSummary {
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}

interface RawSearchResponse<T> {
  items?: T[];
}

interface RawRepoSummary {
  name: string;
  full_name: string;
  owner?: { login?: string };
  private?: boolean;
  pushed_at?: string;
}

export interface GitHubRepoSummary {
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  pushedAt?: string;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  author?: string;
  date?: string;
  url: string;
}

export interface GitHubCommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubCommitDetail extends GitHubCommitSummary {
  files: GitHubCommitFile[];
}

export class GitHubRest {
  readonly name = "GitHub REST";

  constructor(
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async listRecentCommits(params: {
    owner: string;
    repo: string;
    limit?: number;
    path?: string;
    sha?: string;
  }): Promise<GitHubCommitSummary[]> {
    const query = new URLSearchParams({ per_page: String(params.limit ?? 10) });
    if (params.path) query.set("path", params.path);
    if (params.sha) query.set("sha", params.sha);
    const payload = await fetchJson<RawCommitSummary[]>(
      this.fetcher,
      `https://api.github.com/repos/${params.owner}/${params.repo}/commits?${query.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return (payload ?? []).map((commit) => this.toCommitSummary(commit));
  }

  async getCommit(params: { owner: string; repo: string; sha: string }): Promise<GitHubCommitDetail | null> {
    const payload = await fetchJson<RawCommitDetail>(
      this.fetcher,
      `https://api.github.com/repos/${params.owner}/${params.repo}/commits/${encodeURIComponent(params.sha)}`,
      { headers: this.headers() },
      this.name
    );
    if (!payload) return null;
    return {
      ...this.toCommitSummary(payload),
      files: (payload.files ?? []).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch
      }))
    };
  }

  async searchCode(params: { q: string }): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({ q: params.q, per_page: "10" });
    const payload = await fetchJson<RawSearchResponse<Record<string, unknown>>>(
      this.fetcher,
      `https://api.github.com/search/code?${query.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return payload?.items ?? [];
  }

  async searchIssues(params: { q: string }): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({ q: params.q, per_page: "10" });
    const payload = await fetchJson<RawSearchResponse<Record<string, unknown>>>(
      this.fetcher,
      `https://api.github.com/search/issues?${query.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return payload?.items ?? [];
  }

  async getFileContents(params: { owner: string; repo: string; path: string; ref?: string }): Promise<string | null> {
    const query = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
    const payload = await fetchJson<{ content?: string; encoding?: string }>(
      this.fetcher,
      `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${params.path}${query}`,
      { headers: this.headers() },
      this.name
    );
    if (!payload?.content) return null;
    return Buffer.from(payload.content, (payload.encoding as BufferEncoding) ?? "base64").toString("utf8");
  }

  /** Used right after OAuth exchange to learn the connecting user's GitHub login. */
  async getAuthenticatedUser(): Promise<{ login: string } | null> {
    return fetchJson<{ login: string }>(
      this.fetcher,
      "https://api.github.com/user",
      { headers: this.headers() },
      this.name
    );
  }

  /**
   * Repos this token can see, most-recently-pushed first. Lets the agent resolve a bare repo
   * name mentioned in a question (e.g. "NowWhat") to an exact owner/repo pair without guessing —
   * `list_recent_commits`/`get_commit`/`read_file` all require an exact owner, which a plain
   * per-user token has no other way to learn.
   */
  async listRepos(): Promise<GitHubRepoSummary[]> {
    const query = new URLSearchParams({ per_page: "100", sort: "pushed", affiliation: "owner,collaborator,organization_member" });
    const payload = await fetchJson<RawRepoSummary[]>(
      this.fetcher,
      `https://api.github.com/user/repos?${query.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return (payload ?? []).map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login ?? "",
      private: Boolean(repo.private),
      pushedAt: repo.pushed_at
    }));
  }

  private toCommitSummary(commit: RawCommitSummary): GitHubCommitSummary {
    return {
      sha: commit.sha,
      message: commit.commit?.message ?? "",
      author: commit.commit?.author?.name ?? commit.author?.login ?? undefined,
      date: commit.commit?.author?.date,
      url: commit.html_url
    };
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }
}
