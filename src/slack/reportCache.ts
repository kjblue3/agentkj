import { randomUUID } from "node:crypto";
import type { InvestigationResult } from "../types/schemas.js";

const reports = new Map<string, InvestigationResult>();

export function cacheReport(report: InvestigationResult): string {
  const id = randomUUID();
  reports.set(id, report);
  return id;
}

export function getCachedReport(id: string): InvestigationResult | undefined {
  return reports.get(id);
}
