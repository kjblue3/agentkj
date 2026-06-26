import type { EvidenceItem, TimelineEvent } from "../types/schemas.js";
import { splitSentences } from "../utils/text.js";

function eventSummary(item: EvidenceItem): string {
  const firstSentence = splitSentences(item.body)[0];
  return firstSentence ?? item.body.slice(0, 180);
}

export function buildTimeline(items: EvidenceItem[], limit = 7): TimelineEvent[] {
  const ordered = [...items].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
  );

  const clusters = new Map<string, EvidenceItem[]>();
  for (const item of ordered) {
    const hour = item.timestamp.slice(0, 13);
    const existing = clusters.get(hour) ?? [];
    existing.push(item);
    clusters.set(hour, existing);
  }

  return [...clusters.values()].slice(-limit).map((cluster) => {
    const lead = cluster.find((item) => item.source === "incident") ?? cluster[0]!;
    return {
      timestamp: lead.timestamp,
      title: lead.title,
      summary: cluster.map(eventSummary).join(" "),
      evidenceIds: cluster.map((item) => item.id)
    };
  });
}
