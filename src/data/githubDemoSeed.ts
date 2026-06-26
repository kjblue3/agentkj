import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "<!-- slack-detective-demo:checkout-latency -->";

export interface GitHubDemoSeedData {
  owner: string;
  repo: string;
  labels: Array<{ name: string; color: string; description: string }>;
  issue: { title: string; body: string; labels: string[] };
  issueComments: string[];
  files: Array<{ path: string; content: string; message: string }>;
  branch: string;
  pullRequest: { title: string; body: string; filePath: string; fileContent: string };
  reviewComment: { body: string; path: string; line: number };
}

interface GitHubRepo {
  default_branch?: string;
}

interface GitHubRef {
  object?: { sha?: string };
}

interface GitHubContent {
  sha?: string;
}

interface GitHubIssue {
  number: number;
  title?: string;
  body?: string;
  pull_request?: unknown;
}

interface GitHubPullRequest {
  number: number;
  head?: { sha?: string };
}

interface GitHubComment {
  body?: string;
}

export function buildGitHubDemoSeedData(owner: string, repo: string): GitHubDemoSeedData {
  return {
    owner,
    repo,
    labels: [
      { name: "checkout", color: "1f883d", description: "Checkout service and payment flow" },
      { name: "latency", color: "fbca04", description: "Latency or timeout investigation" },
      { name: "incident", color: "d73a4a", description: "Incident response artifact" },
      { name: "root-cause", color: "5319e7", description: "Confirmed or suspected root cause" },
      { name: "n+1", color: "c5def5", description: "N+1 query pattern" }
    ],
    issue: {
      title: "Checkout latency spike report",
      labels: ["checkout", "latency", "incident"],
      body: `${marker}
Fictional demo incident for Slack Detective.

Checkout p95 rose from 420ms to 2.8s shortly after checkout-service v2.14.0 deployed. The slow requests were concentrated on carts with more than 20 line items.

Initial traces showed repeated tax_rule reads while rendering the payment step. Customer support linked timeout complaints to wholesale carts.`
    },
    issueComments: [
      `${marker}
16:04 UTC - checkout-service v2.14.0 deployed with regional tax calculation changes from PR #1842.`,
      `${marker}
16:12 UTC - alert fired for checkout p95 above 2s. Traces showed one tax_rule query per cart item.`,
      `${marker}
17:06 UTC - release rolled back. p95 recovered within six minutes and payment timeouts stopped.`,
      `${marker}
Remediation: batch tax rule lookup before iterating cart items, add a 50-item load test, and add a query-count regression gate.`
    ],
    files: [
      {
        path: "docs/checkout-incident-notes.md",
        message: "Seed checkout incident notes",
        content: `# Checkout latency incident notes

${marker}

This is fictional demo data for Slack Detective.

- Alert: checkout p95 rose from 420ms to 2.8s.
- Suspected regression: regional tax calculation.
- Impact: wholesale carts with many line items timed out at payment.
- Recovery: rollback of checkout-service v2.14.0 restored latency.
`
      },
      {
        path: "docs/checkout-remediation-plan.md",
        message: "Seed checkout remediation plan",
        content: `# Checkout remediation plan

${marker}

1. Batch tax rules before iterating through cart items.
2. Add a 50-item checkout load test.
3. Fail CI when query count exceeds the checkout budget.
4. Keep the incident issue open until the query-count gate is merged.
`
      },
      {
        path: "docs/checkout-architecture-context.md",
        message: "Seed checkout architecture context",
        content: `# Checkout architecture context

${marker}

Checkout calculates taxes after address validation and before payment authorization. The tax_rule table is expected to be read once per region, not once per cart item.
`
      }
    ],
    branch: "demo/checkout-tax-regression",
    pullRequest: {
      title: "Regional tax calculation",
      filePath: "src/checkout/taxRules.ts",
      body: `${marker}
Fictional demo pull request.

Adds regional tax calculation to checkout-service. The first implementation performs tax rule lookup inside the cart item loop, which is useful for demonstrating the N+1 regression path.`,
      fileContent: `export interface CartItem {
  sku: string;
  region: string;
  priceCents: number;
}

export async function calculateRegionalTax(items: CartItem[]) {
  const taxes = [];
  for (const item of items) {
    const rule = await loadTaxRule(item.region);
    taxes.push({ sku: item.sku, taxCents: Math.round(item.priceCents * rule.rate) });
  }
  return taxes;
}

async function loadTaxRule(region: string): Promise<{ rate: number }> {
  return { rate: region === "CA" ? 0.0875 : 0.06 };
}
`
    },
    reviewComment: {
      path: "src/checkout/taxRules.ts",
      line: 9,
      body: `${marker}
This lookup runs once per cart item. For a 50-line wholesale cart, this turns into 50 tax_rule reads in the checkout hot path. Can we batch by region before the loop?`
    }
  };
}

export async function seedGitHubDemo(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = requireEnv(env, "GITHUB_TOKEN");
  const owner = requireEnv(env, "GITHUB_OWNER");
  const repoName = requireEnv(env, "GITHUB_DEMO_REPO");
  const seed = buildGitHubDemoSeedData(owner, repoName);
  const api = new GitHubApi(token);

  const repo = await ensureRepo(api, owner, repoName, env.GITHUB_DEMO_PRIVATE === "true");
  const defaultBranch = repo.default_branch ?? "main";

  for (const label of seed.labels) {
    await upsertLabel(api, owner, repoName, label);
  }

  for (const file of seed.files) {
    await upsertFile(api, owner, repoName, defaultBranch, file.path, file.content, file.message);
  }

  const issue = await upsertIssue(api, owner, repoName, seed.issue);
  await ensureIssueComments(api, owner, repoName, issue.number, seed.issueComments);

  await ensureBranch(api, owner, repoName, defaultBranch, seed.branch);
  await upsertFile(
    api,
    owner,
    repoName,
    seed.branch,
    seed.pullRequest.filePath,
    seed.pullRequest.fileContent,
    "Seed regional tax regression example"
  );
  const pullRequest = await upsertPullRequest(api, owner, repoName, seed.branch, defaultBranch, seed.pullRequest);
  await ensureReviewComment(api, owner, repoName, pullRequest, seed.reviewComment);

  console.log(`Seeded GitHub demo data in https://github.com/${owner}/${repoName}`);
  console.log(`Issue: https://github.com/${owner}/${repoName}/issues/${issue.number}`);
  console.log(`PR: https://github.com/${owner}/${repoName}/pull/${pullRequest.number}`);
}

class GitHubApi {
  constructor(private readonly token: string) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${response.statusText} ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async requestOrNull<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      return await this.request<T>(method, path, body);
    } catch (error) {
      if (error instanceof Error && error.message.includes(" 404 ")) return null;
      return null;
    }
  }
}

async function ensureRepo(api: GitHubApi, owner: string, repo: string, privateRepo: boolean): Promise<GitHubRepo> {
  const existing = await api.requestOrNull<GitHubRepo>("GET", `/repos/${owner}/${repo}`);
  if (existing) return existing;

  const user = await api.request<{ login?: string }>("GET", "/user");
  const createPath = user.login === owner ? "/user/repos" : `/orgs/${owner}/repos`;
  return api.request<GitHubRepo>("POST", createPath, {
    name: repo,
    private: privateRepo,
    auto_init: true,
    description: "Fictional Slack Detective checkout incident sandbox"
  });
}

async function upsertLabel(
  api: GitHubApi,
  owner: string,
  repo: string,
  label: { name: string; color: string; description: string }
): Promise<void> {
  const pathName = encodeURIComponent(label.name);
  const existing = await api.requestOrNull("GET", `/repos/${owner}/${repo}/labels/${pathName}`);
  if (existing) {
    await api.request("PATCH", `/repos/${owner}/${repo}/labels/${pathName}`, label);
  } else {
    await api.request("POST", `/repos/${owner}/${repo}/labels`, label);
  }
}

async function upsertIssue(
  api: GitHubApi,
  owner: string,
  repo: string,
  issue: { title: string; body: string; labels: string[] }
): Promise<GitHubIssue> {
  const issues = await api.request<GitHubIssue[]>("GET", `/repos/${owner}/${repo}/issues?state=all&per_page=100`);
  const existing = issues.find((item) => !item.pull_request && item.title === issue.title);
  if (existing) {
    return api.request<GitHubIssue>("PATCH", `/repos/${owner}/${repo}/issues/${existing.number}`, issue);
  }
  return api.request<GitHubIssue>("POST", `/repos/${owner}/${repo}/issues`, issue);
}

async function ensureIssueComments(
  api: GitHubApi,
  owner: string,
  repo: string,
  issueNumber: number,
  comments: string[]
): Promise<void> {
  const existing = await api.request<GitHubComment[]>(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  );
  for (const body of comments) {
    if (!existing.some((comment) => comment.body === body)) {
      await api.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    }
  }
}

async function ensureBranch(
  api: GitHubApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  branch: string
): Promise<void> {
  const branchRef = encodeURIComponent(`heads/${branch}`);
  const existing = await api.requestOrNull("GET", `/repos/${owner}/${repo}/git/ref/${branchRef}`);
  if (existing) return;

  const base = await api.request<GitHubRef>("GET", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
  if (!base.object?.sha) throw new Error(`Could not resolve ${defaultBranch} SHA.`);
  await api.request("POST", `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: base.object.sha
  });
}

async function upsertFile(
  api: GitHubApi,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const existing = await api.requestOrNull<GitHubContent>(
    "GET",
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
  );
  await api.request("PUT", `/repos/${owner}/${repo}/contents/${encodedPath}`, {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    sha: existing?.sha
  });
}

async function upsertPullRequest(
  api: GitHubApi,
  owner: string,
  repo: string,
  branch: string,
  base: string,
  pullRequest: { title: string; body: string }
): Promise<GitHubPullRequest> {
  const head = encodeURIComponent(`${owner}:${branch}`);
  const existing = await api.request<GitHubPullRequest[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls?state=open&head=${head}`
  );
  if (existing[0]) {
    return api.request<GitHubPullRequest>("PATCH", `/repos/${owner}/${repo}/pulls/${existing[0].number}`, pullRequest);
  }
  return api.request<GitHubPullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
    title: pullRequest.title,
    body: pullRequest.body,
    head: branch,
    base
  });
}

async function ensureReviewComment(
  api: GitHubApi,
  owner: string,
  repo: string,
  pullRequest: GitHubPullRequest,
  comment: { body: string; path: string; line: number }
): Promise<void> {
  const existing = await api.request<GitHubComment[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${pullRequest.number}/comments?per_page=100`
  );
  if (existing.some((item) => item.body === comment.body)) return;
  if (!pullRequest.head?.sha) return;

  await api.request("POST", `/repos/${owner}/${repo}/pulls/${pullRequest.number}/comments`, {
    body: comment.body,
    commit_id: pullRequest.head.sha,
    path: comment.path,
    side: "RIGHT",
    line: comment.line
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedGitHubDemo().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
