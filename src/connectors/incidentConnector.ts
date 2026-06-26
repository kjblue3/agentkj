import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import type { EvidenceConnector } from "./types.js";
import {
  buildEntities,
  buildTags,
  compactText,
  fetchJson,
  normalizeEvidenceItem,
  queryText,
  queryTerms,
  sourceUrl,
  type FetchLike
} from "./connectorUtils.js";

const incidentRecordSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  body: z.string().optional(),
  description: z.unknown().optional(),
  url: z.string().optional(),
  author: z.string().optional(),
  owner: z.string().optional(),
  timestamp: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  services: z.array(z.string()).optional()
}).passthrough();

type IncidentRecord = z.infer<typeof incidentRecordSchema>;

export class IncidentConnector implements EvidenceConnector {
  readonly name = "Incident reports";
  private readonly cache = new Map<string, EvidenceItem>();

  constructor(
    private readonly options: { apiUrl?: string; apiToken?: string; jsonPath?: string },
    private readonly fetcher: FetchLike = fetch
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const records = this.options.apiUrl
      ? await this.searchApi(query)
      : await this.searchFile(query);
    return records.map((record) => this.toEvidence(record, query));
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const match = /^incident:(.+)$/.exec(id);
    if (!match) return null;
    const incidentId = match[1];
    if (!incidentId) return null;

    if (this.options.apiUrl) {
      const record = await fetchJson<unknown>(
        this.fetcher,
        `${this.options.apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(incidentId)}`,
        { headers: this.headers() },
        this.name
      );
      const parsed = this.parseRecords(record)[0];
      return parsed
        ? this.toEvidence(parsed, { originalQuestion: "", keywords: [], entities: [], tags: [] })
        : null;
    }

    const records = await this.searchFile({ originalQuestion: "", keywords: [], entities: [], tags: [] });
    const record = records.find((candidate) => candidate.id === incidentId);
    return record
      ? this.toEvidence(record, { originalQuestion: "", keywords: [], entities: [], tags: [] })
      : null;
  }

  private async searchApi(query: InvestigationQuery): Promise<IncidentRecord[]> {
    if (!this.options.apiUrl) return [];
    const params = new URLSearchParams({ q: queryText(query) });
    const payload = await fetchJson<unknown>(
      this.fetcher,
      `${this.options.apiUrl}${this.options.apiUrl.includes("?") ? "&" : "?"}${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    return this.parseRecords(payload);
  }

  private async searchFile(query: InvestigationQuery): Promise<IncidentRecord[]> {
    if (!this.options.jsonPath) return [];
    try {
      const raw = await readFile(resolve(this.options.jsonPath), "utf8");
      const records = this.parseRecords(JSON.parse(raw));
      const terms = queryTerms(query);
      if (terms.length === 0) return records;
      return records.filter((record) => {
        const text = compactText(record).toLowerCase();
        return terms.some((term) => text.includes(term));
      });
    } catch (error) {
      console.warn(`${this.name} file could not be loaded.`, error);
      return [];
    }
  }

  private parseRecords(payload: unknown): IncidentRecord[] {
    const maybeRecords = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object"
        ? (payload as { incidents?: unknown; data?: unknown; results?: unknown }).incidents
          ?? (payload as { data?: unknown }).data
          ?? (payload as { results?: unknown }).results
        : [];
    return z.array(incidentRecordSchema).catch([]).parse(maybeRecords);
  }

  private toEvidence(record: IncidentRecord, query: InvestigationQuery): EvidenceItem {
    const body = record.body ?? record.summary ?? compactText(record.description) ?? record.title ?? record.id;
    const item = normalizeEvidenceItem({
      id: `incident:${record.id}`,
      source: "incident",
      title: `Incident: ${record.title ?? record.id}`,
      body,
      url: sourceUrl(`https://incidents.local/${encodeURIComponent(record.id)}`, record.url),
      author: record.author ?? record.owner,
      timestamp: record.updatedAt ?? record.timestamp ?? record.createdAt,
      entities: buildEntities(query, `${record.title ?? ""} ${body}`, record.services ?? []),
      tags: buildTags(query, ["incident", ...(record.tags ?? [])]),
      confidence: 0.74
    });
    this.cache.set(item.id, item);
    return item;
  }

  private headers(): HeadersInit {
    return this.options.apiToken ? { Authorization: `Bearer ${this.options.apiToken}` } : {};
  }
}
