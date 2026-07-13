import type { InvestigationResult } from "../types/schemas.js";
import type { Block, KnownBlock } from "@slack/types";
import { tokenize } from "../utils/text.js";

type SlackBlock = Block | KnownBlock;

const evidencePreviewLimit = 5;
const evidenceBoardLimit = 10;
const timelinePreviewLimit = 4;
const timelineBoardLimit = 8;

const weakDisplayTokens = new Set([
  "added",
  "after",
  "available",
  "because",
  "before",
  "current",
  "during",
  "evidence",
  "found",
  "issue",
  "linked",
  "report",
  "review",
  "show",
  "time",
  "using"
]);

const sourceIcon: Record<string, string> = {
  slack: "💬",
  web: "🌐"
};

/** Sources are an open set — any newly connected service renders with the generic icon. */
function iconFor(source: string): string {
  return sourceIcon[source] ?? "🔗";
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(timestamp));
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function evidenceText(item: InvestigationResult["evidence"][number]): string {
  return `${item.title} ${item.body} ${item.entities.join(" ")} ${item.tags.join(" ")}`;
}

function caseAnchorTokens(report: InvestigationResult): Set<string> {
  const anchorEvidence = report.evidence.slice(0, 3).map(evidenceText).join(" ");
  const anchorText = [
    report.question,
    report.shortAnswer,
    report.likelyRootCause,
    anchorEvidence
  ].join(" ");

  return new Set(
    tokenize(anchorText).filter((token) => !weakDisplayTokens.has(token))
  );
}

function caseTopicTokens(report: InvestigationResult): Set<string> {
  return new Set(
    report.evidence
      .slice(0, 3)
      .flatMap((item) => [...item.entities, ...item.tags])
      .flatMap(tokenize)
      .filter((token) => !weakDisplayTokens.has(token))
  );
}

function hasCaseOverlap(
  item: InvestigationResult["evidence"][number],
  anchorTokens: Set<string>,
  topicTokens: Set<string>
): boolean {
  const itemTokens = new Set(
    tokenize(evidenceText(item)).filter((token) => !weakDisplayTokens.has(token))
  );
  const itemTopicTokens = new Set(
    [...item.entities, ...item.tags]
      .flatMap(tokenize)
      .filter((token) => !weakDisplayTokens.has(token))
  );
  const overlap = [...itemTokens].filter((token) => anchorTokens.has(token)).length;
  const topicOverlap = [...itemTopicTokens].some((token) => topicTokens.has(token));
  return topicOverlap && overlap >= 2;
}

export function selectDisplayEvidence(report: InvestigationResult): InvestigationResult["evidence"] {
  if (report.evidence.length <= 3) return report.evidence;

  const anchorIds = new Set(report.evidence.slice(0, 3).map((item) => item.id));
  const anchorTokens = caseAnchorTokens(report);
  const topicTokens = caseTopicTokens(report);
  const selected = report.evidence.filter(
    (item) => anchorIds.has(item.id) || hasCaseOverlap(item, anchorTokens, topicTokens)
  );

  return selected.length > 0 ? selected : report.evidence.slice(0, evidencePreviewLimit);
}

export function selectDisplayTimeline(report: InvestigationResult): InvestigationResult["timeline"] {
  const displayEvidenceIds = new Set(selectDisplayEvidence(report).map((item) => item.id));
  const selected = report.timeline.filter((event) =>
    event.evidenceIds.some((id) => displayEvidenceIds.has(id))
  );

  return (selected.length > 0 ? selected : report.timeline)
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/**
 * Reports render like a teammate's Slack message, not a form: the answer as prose, a light
 * "Sources" line with inline links and an optional connect hint on a miss. No headers, boards,
 * dividers, or controls that imply the read-only agent can execute an external action.
 */
export function buildReportBlocks(report: InvestigationResult, connectionAttribution = ""): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: truncate(`${report.shortAnswer}${connectionAttribution}`, 2900) } }
  ];

  if (report.suggestedConnection) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `💡 This looks like a *${report.suggestedConnection}* question, and you haven't connected it. ` +
          `Use \`/connect ${report.suggestedConnection}\` to start the private setup flow, then ask again.`
      }
    } as SlackBlock);
  }

  const sources = selectDisplayEvidence(report).slice(0, evidencePreviewLimit);
  if (sources.length > 0) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Sources: ${sources.map((item) => `${iconFor(item.source)} <${item.url}|${truncate(item.title, 70)}>`).join("  ·  ")}`
      }]
    } as SlackBlock);
  }

  return blocks;
}
