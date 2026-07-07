import type { EvidenceItem, EvidenceSource, InvestigationQuery } from "../types/schemas.js";
import { evidenceItemSchema } from "../types/schemas.js";
import { tokenize, unique } from "../utils/text.js";

export type FetchLike = typeof fetch;

export function queryTerms(query: InvestigationQuery): string[] {
  return unique([
    ...query.keywords,
    ...query.entities,
    ...query.tags
  ].flatMap(tokenize)).slice(0, 12);
}

export function queryText(query: InvestigationQuery): string {
  const terms = queryTerms(query);
  return terms.length > 0 ? terms.join(" ") : query.originalQuestion;
}

export function compactText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(compactText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(compactText)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function truncate(value: string, maxLength = 2800): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
      return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

export function sourceUrl(fallback: string, candidate: unknown): string {
  return typeof candidate === "string" && /^https?:\/\//.test(candidate) ? candidate : fallback;
}

export function buildTags(query: InvestigationQuery, extra: string[] = []): string[] {
  return unique([...query.tags, ...extra.map((tag) => tag.toLowerCase()).filter(Boolean)]).slice(0, 12);
}

export function buildEntities(query: InvestigationQuery, text: string, extra: string[] = []): string[] {
  const lower = text.toLowerCase();
  const matches = query.entities.filter((entity) => lower.includes(entity.toLowerCase()));
  return unique([...matches, ...extra.filter(Boolean)]).slice(0, 12);
}

export function normalizeEvidenceItem(input: {
  id: string;
  source: EvidenceSource;
  title: string;
  body: string;
  url: string;
  author?: string;
  timestamp?: unknown;
  entities?: string[];
  tags?: string[];
  confidence?: number;
}): EvidenceItem {
  return evidenceItemSchema.parse({
    id: input.id,
    source: input.source,
    title: truncate(input.title || "Untitled evidence", 180),
    body: truncate(input.body || input.title || "No body returned by source."),
    url: input.url,
    author: input.author || undefined,
    timestamp: toIsoTimestamp(input.timestamp),
    entities: input.entities ?? [],
    tags: input.tags ?? [],
    confidence: input.confidence ?? 0.65
  });
}

export async function fetchJson<T>(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  connectorName: string
): Promise<T | null> {
  try {
    const response = await fetcher(url, init);
    if (!response.ok) {
      // The body is the only place GitHub etc. say WHY (e.g. 422 "must include at least one
      // user/org/repo", 404 "no installation access") — without it these are undiagnosable.
      const body = await response.text().catch(() => "");
      console.warn(
        `${connectorName} request failed: ${response.status} ${response.statusText} — ${url.split("?")[0]} — ${truncate(body.replace(/\s+/g, " "), 300)}`
      );
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.warn(`${connectorName} request failed.`, error);
    return null;
  }
}

export function warnMissingConnector(name: string, missing: string[]): void {
  console.warn(`${name} connector disabled; missing ${missing.join(", ")}.`);
}
