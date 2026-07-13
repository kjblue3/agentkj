import {
  investigationQuerySchema,
  type InvestigationQuery
} from "../types/schemas.js";
import { tokenize } from "../utils/text.js";

export function parseQuestion(question: string): InvestigationQuery {
  const base = tokenize(question);

  return investigationQuerySchema.parse({
    originalQuestion: question.trim(),
    keywords: base,
    entities: [],
    tags: []
  });
}
