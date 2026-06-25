import type { EvidenceConnector } from "./types.js";
import type {
  EvidenceItem,
  EvidenceSource,
  InvestigationQuery
} from "../types/schemas.js";
import { tokenize } from "../utils/text.js";

export class LocalConnector implements EvidenceConnector {
  constructor(
    public readonly name: string,
    private readonly source: EvidenceSource,
    private readonly items: EvidenceItem[]
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const needles = new Set([
      ...query.keywords,
      ...query.entities,
      ...query.tags
    ].flatMap(tokenize));

    return this.items.filter((item) => {
      if (item.source !== this.source) return false;
      const haystack = new Set(
        tokenize(
          `${item.title} ${item.body} ${item.entities.join(" ")} ${item.tags.join(" ")}`
        )
      );
      return [...needles].some((token) => haystack.has(token));
    });
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    return this.items.find((item) => item.source === this.source && item.id === id) ?? null;
  }
}
