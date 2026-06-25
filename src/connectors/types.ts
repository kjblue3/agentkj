import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";

export interface EvidenceConnector {
  readonly name: string;
  search(query: InvestigationQuery): Promise<EvidenceItem[]>;
  getById(id: string): Promise<EvidenceItem | null>;
}
