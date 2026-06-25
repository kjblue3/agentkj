import { App } from "@slack/bolt";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import {
  buildEvidenceBlocks,
  buildReportBlocks,
  buildTimelineBlocks
} from "./blocks.js";
import { cacheReport, getCachedReport } from "./reportCache.js";

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
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

  app.action("create_followup", async ({ ack, action, body, client }) => {
    await ack();
    const reportId = "value" in action ? String(action.value) : "";
    const triggerId = "trigger_id" in body ? String(body.trigger_id) : "";
    if (!triggerId) return;
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
