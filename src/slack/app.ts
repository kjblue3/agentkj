import { App } from "@slack/bolt";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import {
  buildEvidenceBlocks,
  buildReportBlocks,
  buildTimelineBlocks
} from "./blocks.js";
import { cacheReport, getCachedReport } from "./reportCache.js";

export const FOLLOWUP_FALLBACK_MESSAGE =
  "Follow-up creation is mocked for this demo. Suggested follow-up: Verify the prevention control and attach the result to the incident.";

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

type SlackActionBody = Record<string, unknown>;

type FollowupActionArgs = {
  ack: () => Promise<void>;
  action: { value?: unknown; action_id?: string };
  body: SlackActionBody;
  client: {
    views: {
      open: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
  respond: (message: Record<string, unknown>) => Promise<unknown>;
};

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const child = value?.[key];
  return typeof child === "string" && child.trim() ? child : undefined;
}

function logFollowupActionDetails(body: SlackActionBody, action: FollowupActionArgs["action"], reportId: string): void {
  const user = objectAt(body, "user");
  const team = objectAt(body, "team");
  const channel = objectAt(body, "channel");
  const container = objectAt(body, "container");
  const message = objectAt(body, "message");
  const triggerId = typeof body.trigger_id === "string" && body.trigger_id.trim() ? body.trigger_id : "";

  console.info("Slack create_followup action received", {
    actionId: action.action_id,
    reportId,
    bodyType: typeof body.type === "string" ? body.type : undefined,
    userId: stringAt(user, "id"),
    teamId: stringAt(team, "id"),
    channelId: stringAt(channel, "id") ?? stringAt(container, "channel_id"),
    messageTs: stringAt(message, "ts") ?? stringAt(container, "message_ts"),
    containerType: stringAt(container, "type"),
    hasTriggerId: Boolean(triggerId),
    hasResponseUrl: typeof body.response_url === "string" && Boolean(body.response_url)
  });
}

async function respondWithFollowupFallback(respond: FollowupActionArgs["respond"]): Promise<void> {
  await respond({
    response_type: "ephemeral",
    replace_original: false,
    text: FOLLOWUP_FALLBACK_MESSAGE
  });
}

export async function handleCreateFollowupAction({
  ack,
  action,
  body,
  client,
  respond
}: FollowupActionArgs): Promise<void> {
  await ack();
  const reportId = typeof action.value === "string" ? action.value : "";
  const triggerId = typeof body.trigger_id === "string" && body.trigger_id.trim() ? body.trigger_id : "";
  logFollowupActionDetails(body, action, reportId);

  if (!triggerId) {
    console.warn("Slack create_followup action missing trigger_id; sending fallback.");
    await respondWithFollowupFallback(respond);
    return;
  }

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "followup_submit",
        private_metadata: reportId,
        title: { type: "plain_text", text: "Create follow-up" },
        submit: { type: "plain_text", text: "Create" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "followup",
            label: { type: "plain_text", text: "Follow-up action" },
            element: {
              type: "plain_text_input",
              action_id: "text",
              multiline: true,
              initial_value: "Verify the prevention control and attach the result to the incident."
            }
          }
        ]
      }
    });
  } catch (error) {
    console.warn("Slack create_followup modal failed; sending fallback.", {
      error: error instanceof Error ? error.message : String(error)
    });
    await respondWithFollowupFallback(respond);
  }
}

export function createSlackApp(pipeline: InvestigationPipeline): App | null {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!token || !appToken || !signingSecret) return null;

  const app = new App({ token, appToken, signingSecret, socketMode: true });

  app.command("/detective", async ({ command, ack, respond }) => {
    await ack();
    if (!command.text.trim()) {
      await respond("Give me a case to investigate, e.g. `/detective Why did checkout latency spike?`");
      return;
    }
    await respond({ response_type: "ephemeral", text: "🕵️ Pinning the evidence to the board…" });
    const report = await pipeline.investigate(command.text);
    const reportId = cacheReport(report);
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `Detective Report: ${report.shortAnswer}`,
      blocks: buildReportBlocks(report, reportId)
    });
  });

  app.event("app_mention", async ({ event, say }) => {
    const question = stripMention(event.text);
    const report = await pipeline.investigate(question);
    const reportId = cacheReport(report);
    await say({
      text: `Detective Report: ${report.shortAnswer}`,
      blocks: buildReportBlocks(report, reportId),
      thread_ts: event.thread_ts ?? event.ts
    });
  });

  app.action("show_evidence", async ({ ack, body, action, respond }) => {
    await ack();
    const report = getCachedReport("value" in action ? String(action.value) : "");
    if (report) await respond({ response_type: "ephemeral", blocks: buildEvidenceBlocks(report) });
  });

  app.action("show_timeline", async ({ ack, action, respond }) => {
    await ack();
    const report = getCachedReport("value" in action ? String(action.value) : "");
    if (report) await respond({ response_type: "ephemeral", blocks: buildTimelineBlocks(report) });
  });

  app.action("create_followup", async ({ ack, action, body, client, respond }) => {
    await handleCreateFollowupAction({
      ack,
      action: action as FollowupActionArgs["action"],
      body: body as unknown as SlackActionBody,
      client: client as unknown as FollowupActionArgs["client"],
      respond: respond as FollowupActionArgs["respond"]
    });
  });

  app.view("followup_submit", async ({ ack }) => {
    await ack();
  });

  app.action("mark_solved", async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: "in_channel",
      replace_original: false,
      text: "✅ Case marked solved. The evidence board remains available for the record."
    });
  });

  return app;
}
