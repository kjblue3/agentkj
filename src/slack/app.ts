import { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/types";
import { getValidGitHubToken, listUserConnectors, setUserConnector } from "../auth/tokenStore.js";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import { describeCatalog, findCatalogEntry } from "../mcp/catalog.js";
import { McpToolRegistry, type McpServerSpec } from "../mcp/registry.js";
import {
  buildEvidenceBlocks,
  buildReportBlocks,
  buildTimelineBlocks
} from "./blocks.js";
import { cacheReport, getCachedReport } from "./reportCache.js";

/** Per-user MCP registries, built lazily from tokenStore's userConnectors and cached by user id. */
const userMcpRegistries = new Map<string, McpToolRegistry>();

function connectorSpecFor(slackUserId: string, catalogId: string, credentials: Record<string, string>): McpServerSpec {
  return { name: `${slackUserId}:${catalogId}`, command: findCatalogEntry(catalogId)!.command, env: credentials };
}

function userMcpRegistry(slackUserId: string): McpToolRegistry | undefined {
  const connectors = listUserConnectors(slackUserId);
  if (connectors.length === 0) return undefined;
  const cacheKey = slackUserId;
  const existing = userMcpRegistries.get(cacheKey);
  if (existing) return existing;
  const specs = connectors.map((connector) => connectorSpecFor(slackUserId, connector.catalogId, connector.credentials));
  const registry = new McpToolRegistry(specs);
  userMcpRegistries.set(cacheKey, registry);
  return registry;
}

function invalidateUserMcpRegistry(slackUserId: string): void {
  userMcpRegistries.get(slackUserId)?.close().catch(() => undefined);
  userMcpRegistries.delete(slackUserId);
}

function connectGitHubText(slackUserId: string): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    return "GitHub isn't connected yet, and this deployment hasn't set `PUBLIC_BASE_URL`, so I can't give you a connect link. Ask whoever runs this bot to finish GitHub OAuth setup.";
  }
  return `You haven't connected your GitHub yet. <${base}/auth/github?state=${encodeURIComponent(slackUserId)}|Connect your GitHub> so I can investigate *your* repos, then run this again.`;
}

/** Splits a leading `owner/repo` token off the question text, if present, e.g. "acme/site why is it red" */
function parseOwnerRepo(text: string): { owner?: string; repo?: string; question: string } {
  const match = text.match(/^([\w.-]+)\/([\w.-]+)\s+(.+)$/);
  if (!match) return { question: text };
  const [, owner, repo, rest] = match;
  return { owner, repo, question: rest ?? text };
}

export const FOLLOWUP_FALLBACK_MESSAGE =
  "I couldn't open the follow-up form. Suggested follow-up: verify the prevention control and attach the result to the incident.";

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

type SlackActionBody = Record<string, unknown>;
type SlackBlock = Block | KnownBlock;

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

type FollowupSubmitArgs = {
  ack: () => Promise<void>;
  body: SlackActionBody;
  client: {
    chat: {
      postMessage: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

type SlackIntentReply = (message: Record<string, unknown> | string) => Promise<unknown>;

type SlackIntentArgs = {
  text: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  pipeline: InvestigationPipeline;
  reply: SlackIntentReply;
  postReport: (reportText: string, blocks: SlackBlock[]) => Promise<unknown>;
  source: "slash" | "mention";
};

function usageText(): string {
  return "Ask me in Slack, e.g. `@agentkj why did checkout latency spike?`\n" +
    "Other commands: `@agentkj connect github`, `@agentkj connectors`, `@agentkj connect <catalog-id> KEY=value ...`";
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const child = value?.[key];
  return typeof child === "string" && child.trim() ? child : undefined;
}

function parseFollowupMetadata(value: string): { reportId: string; channelId?: string; threadTs?: string } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      reportId: typeof parsed.reportId === "string" ? parsed.reportId : "",
      channelId: typeof parsed.channelId === "string" ? parsed.channelId : undefined,
      threadTs: typeof parsed.threadTs === "string" ? parsed.threadTs : undefined
    };
  } catch {
    return { reportId: value };
  }
}

function followupMetadata(body: SlackActionBody, reportId: string): string {
  const channel = objectAt(body, "channel");
  const container = objectAt(body, "container");
  const message = objectAt(body, "message");
  return JSON.stringify({
    reportId,
    channelId: stringAt(channel, "id") ?? stringAt(container, "channel_id"),
    threadTs: stringAt(message, "ts") ?? stringAt(container, "message_ts")
  });
}

function extractFollowupText(body: SlackActionBody): string {
  const view = objectAt(body, "view");
  const state = objectAt(view, "state");
  const values = objectAt(state, "values");
  const followup = objectAt(values, "followup");
  const text = objectAt(followup, "text");
  const value = text?.value;
  return typeof value === "string" ? value.trim() : "";
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
    const report = getCachedReport(reportId);
    const initialFollowup = report?.recommendedActions.find((action) => action.trim())
      ?? "Verify the prevention control and attach the result to the incident.";
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "followup_submit",
        private_metadata: followupMetadata(body, reportId),
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
              initial_value: initialFollowup
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

export async function handleFollowupSubmitAction({ ack, body, client }: FollowupSubmitArgs): Promise<void> {
  await ack();
  const view = objectAt(body, "view");
  const metadata = parseFollowupMetadata(typeof view?.private_metadata === "string" ? view.private_metadata : "");
  const followupText = extractFollowupText(body);
  const report = getCachedReport(metadata.reportId);
  const channelId = metadata.channelId;

  if (!channelId || !followupText) {
    console.warn("Slack followup_submit missing channel or follow-up text.", {
      reportId: metadata.reportId,
      hasChannel: Boolean(channelId),
      hasText: Boolean(followupText)
    });
    return;
  }

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: metadata.threadTs,
    text: `Follow-up created: ${followupText}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Follow-up created*\n${followupText}`
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: report
              ? `From case: *${report.question}*`
              : `From detective report \`${metadata.reportId || "unknown"}\``
          }
        ]
      }
    ]
  });
}

export async function handleSlackIntent({
  text,
  userId,
  pipeline,
  reply,
  postReport,
  source
}: SlackIntentArgs): Promise<void> {
  const trimmed = text.trim();

  if (!trimmed) {
    await reply(usageText());
    return;
  }

  if (trimmed === "connect github" || trimmed === "connect-github") {
    await reply({ response_type: "ephemeral", text: connectGitHubText(userId) });
    return;
  }

  if (trimmed === "connectors") {
    const connected = listUserConnectors(userId);
    const connectedText = connected.length > 0
      ? connected.map((c) => `• \`${c.catalogId}\` — connected ${c.connectedAt}`).join("\n")
      : "_none yet_";
    await reply({
      response_type: "ephemeral",
      text:
        `*Your connectors:*\n${connectedText}\n\n*Available to connect:*\n${describeCatalog()}\n\n` +
        "Connect one with `@agentkj connect <catalog-id> KEY=value KEY2=value2`."
    });
    return;
  }

  if (trimmed.startsWith("connect ")) {
    const [, catalogId, ...pairs] = trimmed.split(/\s+/);
    const entry = catalogId ? findCatalogEntry(catalogId) : undefined;
    if (!entry) {
      await reply({
        response_type: "ephemeral",
        text: `Unknown connector \`${catalogId}\`. See \`@agentkj connectors\` for the list.`
      });
      return;
    }
    const credentials: Record<string, string> = {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      credentials[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const missing = entry.credentialFields.filter((field) => !credentials[field]);
    if (missing.length > 0) {
      await reply({
        response_type: "ephemeral",
        text: `\`${catalogId}\` needs: ${missing.join(", ")}. Example: \`@agentkj connect ${catalogId} ${entry.credentialFields.map((f) => `${f}=...`).join(" ")}\``
      });
      return;
    }
    setUserConnector(userId, {
      catalogId: entry.id,
      label: entry.label,
      credentials,
      connectedAt: new Date().toISOString()
    });
    invalidateUserMcpRegistry(userId);
    await reply({ response_type: "ephemeral", text: `Connected \`${entry.label}\`. The agent can use it on your next question.` });
    return;
  }

  const githubToken = await getValidGitHubToken(userId);
  if (!githubToken) {
    await reply({ response_type: "ephemeral", text: connectGitHubText(userId) });
    return;
  }

  await reply({ response_type: "ephemeral", text: "Pinning the evidence to the board..." });
  const { owner, repo, question } = parseOwnerRepo(trimmed);
  try {
    const report = await pipeline.investigate(question, {
      githubToken: githubToken.token,
      githubLogin: githubToken.login,
      owner,
      repo,
      mcpRegistry: userMcpRegistry(userId)
    });
    const reportId = cacheReport(report);
    await postReport(`Detective Report: ${report.shortAnswer}`, buildReportBlocks(report, reportId));
  } catch (error) {
    console.error(`${source === "slash" ? "`/detective`" : "app_mention"} investigation failed.`, error);
    await reply({
      response_type: "ephemeral",
      text: "Something went wrong investigating that. Try rephrasing the question, or ask again in a moment."
    });
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
    await handleSlackIntent({
      text: command.text,
      userId: command.user_id,
      channelId: command.channel_id,
      pipeline,
      reply: respond,
      postReport: (text, blocks) => app.client.chat.postMessage({
        channel: command.channel_id,
        text,
        blocks
      }),
      source: "slash"
    });
  });

  app.event("app_mention", async ({ event, say }) => {
    const userId = "user" in event && typeof event.user === "string" ? event.user : undefined;
    const threadTs = event.thread_ts ?? event.ts;
    const sayInThread = say as (message: Record<string, unknown>) => Promise<unknown>;
    if (!userId) {
      await sayInThread({
        text: "I couldn't identify the Slack user for this mention. Try again in a moment.",
        thread_ts: threadTs
      });
      return;
    }
    await handleSlackIntent({
      text: stripMention(event.text),
      userId,
      channelId: event.channel,
      threadTs,
      pipeline,
      reply: (message) => typeof message === "string"
        ? sayInThread({ text: message, thread_ts: threadTs })
        : sayInThread({ ...message, thread_ts: threadTs }),
      postReport: (text, blocks) => sayInThread({ text, blocks, thread_ts: threadTs }),
      source: "mention"
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

  app.view("followup_submit", async ({ ack, body, client }) => {
    await handleFollowupSubmitAction({
      ack,
      body: body as unknown as SlackActionBody,
      client: client as unknown as FollowupSubmitArgs["client"]
    });
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
