import type {
  EvidenceItem,
  InvestigationQuery,
  RankedEvidence
} from "../types/schemas.js";
import { tokenize } from "../utils/text.js";

const sourceBoost = {
  incident: 1.5,
  docs: 1.1,
  github: 1.2,
  jira: 1,
  slack: 0.8,
  web: 0.9
} as const;

export function scoreEvidence(
  item: EvidenceItem,
  query: InvestigationQuery,
  newestTimestamp: number
): RankedEvidence {
  const queryTokens = new Set(query.keywords.flatMap(tokenize));
  const contentTokens = new Set(tokenize(`${item.title} ${item.body}`));
  const entityTokens = new Set(item.entities.flatMap(tokenize));
  const tagTokens = new Set(item.tags.flatMap(tokenize));
  const reasons: string[] = [];

  const keywordMatches = [...queryTokens].filter((token) => contentTokens.has(token)).length;
  const entityMatches = [...queryTokens].filter((token) => entityTokens.has(token)).length;
  const tagMatches = [...queryTokens].filter((token) => tagTokens.has(token)).length;
  const ageDays = Math.max(0, (newestTimestamp - Date.parse(item.timestamp)) / 86_400_000);
  const recency = Math.max(0, 1.2 - ageDays / 365);

  if (keywordMatches) reasons.push(`${keywordMatches} keyword match${keywordMatches === 1 ? "" : "es"}`);
  if (entityMatches) reasons.push(`${entityMatches} entity match${entityMatches === 1 ? "" : "es"}`);
  if (tagMatches) reasons.push(`${tagMatches} tag match${tagMatches === 1 ? "" : "es"}`);
  if (recency > 0.6) reasons.push("recent");
  reasons.push(`${item.source} authority`);

  const score =
    keywordMatches * 2 +
    entityMatches * 2.75 +
    tagMatches * 2.25 +
    recency +
    (sourceBoost[item.source as keyof typeof sourceBoost] ?? 1) +
    (item.confidence ?? 0.5);

  return { item, score: Number(score.toFixed(3)), reasons };
}

export function isStronglyRelevant(
  item: EvidenceItem,
  query: InvestigationQuery
): boolean {
  const itemTopicTokens = new Set(
    tokenize(
      `${item.title} ${item.body} ${item.entities.join(" ")} ${item.tags.join(" ")}`
    )
  );
  const queryEntityTokens = new Set(query.entities.flatMap(tokenize));
  if (queryEntityTokens.size > 0) {
    return [...queryEntityTokens].some((token) => itemTopicTokens.has(token));
  }

  const queryTagTokens = new Set(query.tags.flatMap(tokenize));
  if (queryTagTokens.size > 0) {
    return [...queryTagTokens].some((token) => itemTopicTokens.has(token));
  }

  const queryTokens = new Set(query.keywords.flatMap(tokenize));
  const matches = [...queryTokens].filter((token) => itemTopicTokens.has(token)).length;
  return matches >= 2;
}

export function rankEvidence(
  items: EvidenceItem[],
  query: InvestigationQuery,
  limit = 12
): RankedEvidence[] {
  const newestTimestamp = Math.max(...items.map((item) => Date.parse(item.timestamp)), Date.now() - 31_536_000_000);
  return items
    .filter((item) => isStronglyRelevant(item, query))
    .map((item) => scoreEvidence(item, query, newestTimestamp))
    .filter((ranked) => ranked.score >= 4)
    .sort((a, b) => b.score - a.score || Date.parse(b.item.timestamp) - Date.parse(a.item.timestamp))
    .slice(0, limit);
}
