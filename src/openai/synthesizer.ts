import type OpenAI from "openai";
import { createLlmClient, llmModel } from "../llm/client.js";
import { investigationResultSchema, type EvidenceItem, type InvestigationResult, type TimelineEvent } from "../types/schemas.js";
import { fallbackSynthesis } from "../investigation/fallbackSynthesis.js";

export interface Synthesizer {
  synthesize(question: string, evidence: EvidenceItem[], timeline: TimelineEvent[]): Promise<InvestigationResult>;
}

export class ReportSynthesizer implements Synthesizer {
  private readonly client: OpenAI | null;
  private readonly model: string;
  constructor(client = createLlmClient(), model = llmModel()) {
    this.client = client;
    this.model = model;
  }

  async synthesize(question: string, evidence: EvidenceItem[], timeline: TimelineEvent[]): Promise<InvestigationResult> {
    const fallback = fallbackSynthesis(question, evidence, timeline);
    if (!this.client || evidence.length === 0) return fallback;
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Write a concise, natural investigation answer from only the supplied evidence. Return the same JSON fields as the draft and preserve evidence ids exactly." },
          { role: "user", content: JSON.stringify({ question, evidence, timeline, draft: fallback }) }
        ]
      });
      return investigationResultSchema.parse(JSON.parse(response.choices[0]?.message?.content ?? "{}"));
    } catch (error) {
      if ((error as { name?: string }).name === "LlmCapacityExhausted") throw error;
      return fallback;
    }
  }
}
