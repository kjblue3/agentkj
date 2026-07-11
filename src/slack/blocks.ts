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
 * "Sources" line with inline links, an optional connect hint on a miss, and — when the agent
 * has a next step in mind — ONE suggested follow-up with Do it / Skip buttons ("Do it" makes
 * the agent execute the follow-up itself). No headers, boards, or dividers.
 */
export function buildReportBlocks(report: InvestigationResult, reportId: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: truncate(report.shortAnswer, 2900) } }
  ];

  if (report.suggestedConnection) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `💡 This looks like a *${report.suggestedConnection}* question, and you haven't connected it. ` +
          `Say \`connect ${report.suggestedConnection}\` and I'll set it up — then ask me again.`
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

  const followup = report.recommendedActions.find((action) => action.trim());
  if (followup) {
    blocks.push(
      {
        type: "section",
        text: { type: "mrkdwn", text: `Want me to follow up? _${truncate(followup, 280)}_` }
      } as SlackBlock,
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Do it", emoji: true }, style: "primary", action_id: "followup_do", value: reportId },
          { type: "button", text: { type: "plain_text", text: "Skip", emoji: true }, action_id: "followup_skip", value: reportId }
        ]
      } as SlackBlock
    );
  }

  return blocks;
}
