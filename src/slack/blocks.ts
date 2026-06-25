import type { InvestigationResult } from "../types/schemas.js";
import type { Block, KnownBlock } from "@slack/types";

type SlackBlock = Block | KnownBlock;

const sourceIcon = {
  slack: "💬",
  github: "🔀",
  jira: "🎫",
  docs: "📄",
  incident: "🚨"
} as const;

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(timestamp));
}

export function buildReportBlocks(report: InvestigationResult, reportId: string): SlackBlock[] {
  const timeline = report.timeline.slice(0, 6).map(
    (event) => `• *${dateLabel(event.timestamp)} — ${event.title}*\n  ${event.summary}`
  ).join("\n");
  const evidence = report.evidence.slice(0, 5).map(
    (item, index) => `${index + 1}. ${sourceIcon[item.source]} <${item.url}|${item.title}>`
  ).join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🕵️ Detective Report", emoji: true }
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Case:* ${report.question}` },
        { type: "mrkdwn", text: `*Confidence:* ${confidenceBadge(report.confidence)}` }
      ]
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*The short version*\n${report.shortAnswer}` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*🔎 Likely root cause*\n${report.likelyRootCause}` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*🧵 Causal timeline*\n${timeline || "_No timeline found._"}` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*📌 Evidence board*\n${evidence || "_No evidence found._"}` }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Next moves*\n${report.recommendedActions.map((action) => `• ${action}`).join("\n")}`
      }
    },
    {
      type: "actions",
      elements: [
        button("Show evidence", "show_evidence", reportId, "primary"),
        button("Show timeline", "show_timeline", reportId),
        button("Create follow-up", "create_followup", reportId),
        button("Mark solved", "mark_solved", reportId)
      ]
    }
  ] as SlackBlock[];
}

export function buildEvidenceBlocks(report: InvestigationResult): SlackBlock[] {
  return [
    { type: "header", text: { type: "plain_text", text: "📌 Full evidence board", emoji: true } },
    ...report.evidence.map((item) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${sourceIcon[item.source]} *<${item.url}|${item.title}>*\n${item.body}\n_${item.author ?? "Unknown"} · ${dateLabel(item.timestamp)} · ID: ${item.id}_`
      }
    }))
  ] as SlackBlock[];
}

export function buildTimelineBlocks(report: InvestigationResult): SlackBlock[] {
  return [
    { type: "header", text: { type: "plain_text", text: "🧵 Reconstructed timeline", emoji: true } },
    ...report.timeline.map((event) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${dateLabel(event.timestamp)} — ${event.title}*\n${event.summary}\n_Evidence: ${event.evidenceIds.join(", ")}_`
      }
    }))
  ] as SlackBlock[];
}

function confidenceBadge(confidence: InvestigationResult["confidence"]): string {
  return confidence === "high" ? "🟢 High" : confidence === "medium" ? "🟡 Medium" : "🔴 Low";
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
