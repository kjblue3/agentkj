import { randomUUID } from "node:crypto";
import type { InvestigationResult } from "../types/schemas.js";

/**
 * Reports live only as long as their Slack action buttons plausibly get clicked. Unbounded
 * growth here is a slow leak — each report carries full evidence bodies — so evict oldest-first
 * (Map iteration order is insertion order). A judge clicking a button on an evicted report gets
 * the existing "report not found" fallback rather than a crash.
 */
const MAX_CACHED_REPORTS = 300;

const reports = new Map<string, InvestigationResult>();

export function cacheReport(report: InvestigationResult): string {
  const id = randomUUID();
  reports.set(id, report);
  while (reports.size > MAX_CACHED_REPORTS) {
    const oldest = reports.keys().next().value;
    if (oldest === undefined) break;
    reports.delete(oldest);
  }
  return id;
}

export function getCachedReport(id: string): InvestigationResult | undefined {
  return reports.get(id);
}
