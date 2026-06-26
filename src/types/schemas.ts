import { z } from "zod";

export const evidenceSourceSchema = z.enum([
  "slack",
  "github",
  "jira",
  "docs",
  "incident"
]);

export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  source: evidenceSourceSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().url(),
  author: z.string().optional(),
  timestamp: z.string().datetime(),
  entities: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional()
});

export const investigationQuerySchema = z.object({
  originalQuestion: z.string().min(3),
  keywords: z.array(z.string()),
  entities: z.array(z.string()),
  tags: z.array(z.string())
});

export const timelineEventSchema = z.object({
  timestamp: z.string().datetime(),
  title: z.string(),
  summary: z.string(),
  evidenceIds: z.array(z.string()).min(1)
});

export const investigationResultSchema = z.object({
  question: z.string(),
  shortAnswer: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  sourceMode: z.enum(["demo", "real", "hybrid"]).optional(),
  connectors: z.array(z.string()).optional(),
  likelyRootCause: z.string(),
  timeline: z.array(timelineEventSchema),
  evidence: z.array(evidenceItemSchema),
  openQuestions: z.array(z.string()),
  recommendedActions: z.array(z.string())
});

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type InvestigationQuery = z.infer<typeof investigationQuerySchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type InvestigationResult = z.infer<typeof investigationResultSchema>;

export interface RankedEvidence {
  item: EvidenceItem;
  score: number;
  reasons: string[];
}
