import OpenAI from "openai";
import {
  investigationResultSchema,
  type EvidenceItem,
  type InvestigationResult,
  type TimelineEvent
} from "../types/schemas.js";
import { fallbackSynthesis } from "../investigation/fallbackSynthesis.js";

export interface Synthesizer {
  synthesize(
    question: string,
    evidence: EvidenceItem[],
    timeline: TimelineEvent[]
  ): Promise<InvestigationResult>;
}

export class ReportSynthesizer implements Synthesizer {
  private readonly client?: OpenAI;

  constructor(
    apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
  ) {
    if (apiKey) this.client = new OpenAI({ apiKey });
  }

  async synthesize(
    question: string,
    evidence: EvidenceItem[],
    timeline: TimelineEvent[]
  ): Promise<InvestigationResult> {
    const fallback = fallbackSynthesis(question, evidence, timeline);
    if (!this.client || evidence.length === 0) return fallback;

    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "You are Slack Detective. Return only JSON. Be concise, evidence-bound, and cite evidence IDs in prose using [id]. Never invent facts."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Improve this investigation report. Preserve evidence and timeline exactly. Return every field in the supplied draft.",
              question,
              draft: fallback
            })
          }
        ]
      });
      const parsed = JSON.parse(response.output_text);
      return investigationResultSchema.parse({
        ...parsed,
        question,
        evidence,
        timeline
      });
    } catch (error) {
      console.warn("OpenAI synthesis failed; using deterministic fallback.", error);
      return fallback;
    }
  }
}
