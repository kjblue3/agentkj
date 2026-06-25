import type { EvidenceConnector } from "../connectors/types.js";
import type { InvestigationResult } from "../types/schemas.js";
import type { Synthesizer } from "../openai/synthesizer.js";
import { parseQuestion } from "./queryParser.js";
import { rankEvidence } from "./ranker.js";
import { buildTimeline } from "./timeline.js";

export class InvestigationPipeline {
  constructor(
    private readonly connectors: EvidenceConnector[],
    private readonly synthesizer: Synthesizer
  ) {}

  async investigate(question: string): Promise<InvestigationResult> {
    const query = parseQuestion(question);
    const batches = await Promise.all(
      this.connectors.map((connector) => connector.search(query))
    );
    const unique = [...new Map(batches.flat().map((item) => [item.id, item])).values()];
    const ranked = rankEvidence(unique, query);
    const evidence = ranked.map(({ item, score }) => ({
      ...item,
      confidence: Math.min(1, Math.max(item.confidence ?? 0.5, score / 20))
    }));
    const timeline = buildTimeline(evidence);
    return this.synthesizer.synthesize(question, evidence, timeline);
  }

  async getEvidence(id: string) {
    for (const connector of this.connectors) {
      const item = await connector.getById(id);
      if (item) return item;
    }
    return null;
  }
}
