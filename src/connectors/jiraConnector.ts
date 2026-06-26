import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import type { EvidenceConnector } from "./types.js";
import {
  buildEntities,
  buildTags,
  compactText,
  fetchJson,
  normalizeEvidenceItem,
  queryTerms,
  type FetchLike
} from "./connectorUtils.js";

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

interface JiraIssue {
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    created?: string;
    updated?: string;
    labels?: string[];
    reporter?: { displayName?: string; emailAddress?: string };
    status?: { name?: string };
    comment?: { comments?: Array<{ body?: unknown; author?: { displayName?: string }; created?: string }> };
  };
}

export class JiraConnector implements EvidenceConnector {
  readonly name = "Jira";
  private readonly cache = new Map<string, EvidenceItem>();
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly email: string,
    private readonly apiToken: string,
    private readonly projects: string[],
    private readonly fetcher: FetchLike = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const params = new URLSearchParams({
      jql: this.buildJql(query),
      fields: "summary,description,created,updated,labels,reporter,status,comment",
      maxResults: "10"
    });
    const payload = await fetchJson<JiraSearchResponse>(
      this.fetcher,
      `${this.baseUrl}/rest/api/3/search?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return (payload?.issues ?? []).map((issue) => this.toEvidence(issue, query));
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const match = /^jira:(.+)$/.exec(id);
    if (!match) return null;
    const key = match[1];
    if (!key) return null;
    const params = new URLSearchParams({
      fields: "summary,description,created,updated,labels,reporter,status,comment"
    });
    const issue = await fetchJson<JiraIssue>(
      this.fetcher,
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return issue ? this.toEvidence(issue, { originalQuestion: "", keywords: [], entities: [], tags: [] }) : null;
  }

  private buildJql(query: InvestigationQuery): string {
    const textClauses = queryTerms(query)
      .slice(0, 6)
      .map((term) => `text ~ "${term.replace(/"/g, "")}*"`);
    const projectClause = this.projects.length > 0
      ? `project in (${this.projects.map((project) => `"${project.replace(/"/g, "")}"`).join(",")})`
      : "";
    const textClause = textClauses.length > 0 ? `(${textClauses.join(" OR ")})` : "";
    return [projectClause, textClause].filter(Boolean).join(" AND ") || "order by updated DESC";
  }

  private toEvidence(issue: JiraIssue, query: InvestigationQuery): EvidenceItem {
    const fields = issue.fields ?? {};
    const description = compactText(fields.description);
    const comments = (fields.comment?.comments ?? [])
      .slice(-3)
      .map((comment) => compactText(comment.body))
      .filter(Boolean)
      .join(" ");
    const body = [description, comments, fields.status?.name ? `Status: ${fields.status.name}` : ""]
      .filter(Boolean)
      .join("\n\n");
    const item = normalizeEvidenceItem({
      id: `jira:${issue.key}`,
      source: "jira",
      title: `Jira ${issue.key}: ${fields.summary ?? "Untitled issue"}`,
      body: body || fields.summary || issue.key,
      url: `${this.baseUrl}/browse/${issue.key}`,
      author: fields.reporter?.displayName ?? fields.reporter?.emailAddress,
      timestamp: fields.updated ?? fields.created,
      entities: buildEntities(query, `${fields.summary ?? ""} ${body}`, [issue.key]),
      tags: buildTags(query, ["jira", ...(fields.labels ?? [])]),
      confidence: 0.68
    });
    this.cache.set(item.id, item);
    return item;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
      Accept: "application/json"
    };
  }
}
