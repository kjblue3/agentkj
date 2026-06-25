import type { EvidenceItem, EvidenceSource } from "../types/schemas.js";
import { LocalConnector } from "./localConnector.js";
import type { EvidenceConnector } from "./types.js";

const labels: Record<EvidenceSource, string> = {
  slack: "Slack messages",
  github: "GitHub",
  jira: "Jira",
  docs: "Google Docs",
  incident: "Incident reports"
};

export function createConnectors(items: EvidenceItem[]): EvidenceConnector[] {
  return (Object.keys(labels) as EvidenceSource[]).map(
    (source) => new LocalConnector(labels[source], source, items)
  );
}

export type { EvidenceConnector } from "./types.js";
