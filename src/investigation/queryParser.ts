import {
  investigationQuerySchema,
  type InvestigationQuery
} from "../types/schemas.js";
import { tokenize, unique } from "../utils/text.js";

const expansions: Record<string, string[]> = {
  slow: ["latency", "timeout", "performance"],
  latency: ["p95", "performance", "timeout"],
  delayed: ["delay", "blocked", "dependency", "launch"],
  recommendations: ["recs", "recommendation"],
  redis: ["session", "sessions", "revocation"],
  checkout: ["cart", "payment", "checkout-service"]
};

export function parseQuestion(question: string): InvestigationQuery {
  const base = tokenize(question);
  const expanded = unique(base.flatMap((word) => [word, ...(expansions[word] ?? [])]));
  const entities = expanded.filter((word) =>
    ["checkout", "checkout-service", "recommendations", "recs", "redis", "sessions"].includes(word)
  );
  const tags = expanded.filter((word) =>
    ["latency", "timeout", "launch", "delay", "blocked", "dependency", "privacy", "security", "revocation"].includes(word)
  );

  return investigationQuerySchema.parse({
    originalQuestion: question.trim(),
    keywords: expanded,
    entities,
    tags
  });
}
