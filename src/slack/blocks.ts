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

const sourceIcon = {
  slack: "💬",
  github: "🔀",
  jira: "🎫",
  docs: "📄",
  incident: "🚨",
  web: "🌐"
} as const;

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

export function buildReportBlocks(report: InvestigationResult, reportId: string): SlackBlock[] {
  const displayEvidence = selectDisplayEvidence(report);
  const displayTimeline = selectDisplayTimeline(report);
  const timeline = displayTimeline.slice(0, timelinePreviewLimit).map(
    (event) => `• *${dateLabel(event.timestamp)} · ${event.title}*\n${truncate(event.summary, 240)}`
  ).join("\n");
  const evidence = displayEvidence.slice(0, evidencePreviewLimit).map(
    (item, index) => `${index + 1}. ${sourceIcon[item.source]} <${item.url}|${item.title}>`
  ).join("\n");
  const nextMoves = report.recommendedActions.slice(0, 3).map((action) => `• ${action}`).join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🕵️ Detective Report", emoji: true }
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Case:* ${report.question}` },
        { type: "mrkdwn", text: `*Confidence:* ${confidenceBadge(report.confidence)}` },
        { type: "mrkdwn", text: `*Sources:* ${sourceModeLabel(report)}` }
      ]
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Short answer*\n${truncate(report.shortAnswer, 2200)}` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Likely root cause*\n${truncate(report.likelyRootCause, 1200)}` }
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Causal timeline*\n${timeline || "_No timeline found._"}` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Evidence board*\n${evidence || "_No evidence found._"}` }
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Next moves*\n${nextMoves || "_No recommended actions._"}`
      }
    },
    {
      type: "actions",
      elements: [
        button("Show Evidence", "show_evidence", reportId, "primary"),
        button("Show Timeline", "show_timeline", reportId),
        button("Create Follow-up", "create_followup", reportId),
        button("Mark Solved", "mark_solved", reportId)
      ]
    }
  ] as SlackBlock[];
}

export function buildEvidenceBlocks(report: InvestigationResult): SlackBlock[] {
  const displayEvidence = selectDisplayEvidence(report).slice(0, evidenceBoardLimit);
  return [
    { type: "header", text: { type: "plain_text", text: "📌 Evidence Board", emoji: true } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Ranked evidence for *${truncate(report.question, 160)}*` }
      ]
    },
    { type: "divider" },
    ...displayEvidence.flatMap((item, index) => [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${sourceIcon[item.source]} <${item.url}|${item.title}>*\n${truncate(item.body, 700)}`
      }
    }, {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${item.author ?? "Unknown"} · ${dateLabel(item.timestamp)} · ID: \`${item.id}\``
        }
      ]
    }])
  ] as SlackBlock[];
}

export function buildTimelineBlocks(report: InvestigationResult): SlackBlock[] {
  const displayTimeline = selectDisplayTimeline(report).slice(0, timelineBoardLimit);
  return [
    { type: "header", text: { type: "plain_text", text: "🧵 Reconstructed Timeline", emoji: true } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Timeline events tied to evidence for *${truncate(report.question, 160)}*` }
      ]
    },
    { type: "divider" },
    ...displayTimeline.flatMap((event, index) => [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${dateLabel(event.timestamp)} · ${event.title}*\n${truncate(event.summary, 800)}`
      }
    }, {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Evidence: ${event.evidenceIds.map((id) => `\`${id}\``).join(", ")}` }
      ]
    }])
  ] as SlackBlock[];
}

function confidenceBadge(confidence: InvestigationResult["confidence"]): string {
  return confidence === "high" ? "🟢 High" : confidence === "medium" ? "🟡 Medium" : "🔴 Low";
}

function sourceModeLabel(report: InvestigationResult): string {
  const mode = report.sourceMode ?? "demo";
  const connectorCount = report.connectors?.length
    ?? (report.evidence.length > 0 ? new Set(report.evidence.map((item) => item.source)).size : 0);
  return `${mode}${connectorCount ? ` · ${connectorCount} source${connectorCount === 1 ? "" : "s"}` : ""}`;
}

function button(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger"
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
    value,
    ...(style ? { style } : {})
  };
}
