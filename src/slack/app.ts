import { App } from "@slack/bolt";
import { getGitHubToken, listUserConnectors, setUserConnector } from "../auth/tokenStore.js";
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
    const text = command.text.trim();
    const userId = command.user_id;

    if (!text) {
      await respond(
        "Give me a case to investigate, e.g. `/detective Why did checkout latency spike?`\n" +
          "Other subcommands: `/detective connect github`, `/detective connectors`, `/detective connect <catalog-id> KEY=value ...`"
      );
      return;
    }

    if (text === "connect github" || text === "connect-github") {
      await respond({ response_type: "ephemeral", text: connectGitHubText(userId) });
      return;
    }

    if (text === "connectors") {
      const connected = listUserConnectors(userId);
      const connectedText = connected.length > 0
        ? connected.map((c) => `• \`${c.catalogId}\` — connected ${c.connectedAt}`).join("\n")
        : "_none yet_";
      await respond({
        response_type: "ephemeral",
        text:
          `*Your connectors:*\n${connectedText}\n\n*Available to connect:*\n${describeCatalog()}\n\n` +
          "Connect one with `/detective connect <catalog-id> KEY=value KEY2=value2`."
      });
      return;
    }

    if (text.startsWith("connect ")) {
      const [, catalogId, ...pairs] = text.split(/\s+/);
      const entry = catalogId ? findCatalogEntry(catalogId) : undefined;
      if (!entry) {
        await respond({
          response_type: "ephemeral",
          text: `Unknown connector \`${catalogId}\`. See \`/detective connectors\` for the list.`
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
        await respond({
          response_type: "ephemeral",
          text: `\`${catalogId}\` needs: ${missing.join(", ")}. Example: \`/detective connect ${catalogId} ${entry.credentialFields.map((f) => `${f}=...`).join(" ")}\``
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
      await respond({ response_type: "ephemeral", text: `Connected \`${entry.label}\`. The agent can use it on your next question.` });
      return;
    }

    const githubToken = getGitHubToken(userId);
    if (!githubToken) {
      await respond({ response_type: "ephemeral", text: connectGitHubText(userId) });
      return;
    }

    await respond({ response_type: "ephemeral", text: "🕵️ Pinning the evidence to the board…" });
    const { owner, repo, question } = parseOwnerRepo(text);
    try {
      const report = await pipeline.investigate(question, {
        githubToken: githubToken.token,
        githubLogin: githubToken.login,
        owner,
        repo,
        mcpRegistry: userMcpRegistry(userId)
      });
      const reportId = cacheReport(report);
      await app.client.chat.postMessage({
        channel: command.channel_id,
        text: `Detective Report: ${report.shortAnswer}`,
        blocks: buildReportBlocks(report, reportId)
      });
    } catch (error) {
      console.error("`/detective` investigation failed.", error);
      await respond({
        response_type: "ephemeral",
        text: "Something went wrong investigating that. Try rephrasing the question, or ask again in a moment."
      });
    }
  });

  app.event("app_mention", async ({ event, say }) => {
    // Unlike `/detective`, a mention falls back to the shared demo token when this user hasn't
    // connected their own GitHub yet (pipeline.ts does the same opts.githubToken ?? GITHUB_TOKEN
    // fallback) rather than hard-blocking, so app_mention still works out of the box in demo mode.
    const userId = "user" in event && typeof event.user === "string" ? event.user : undefined;
    const githubToken = userId ? getGitHubToken(userId) : undefined;
    const { owner, repo, question } = parseOwnerRepo(stripMention(event.text));
    const threadTs = event.thread_ts ?? event.ts;
    try {
      const report = await pipeline.investigate(question, {
        githubToken: githubToken?.token,
        githubLogin: githubToken?.login,
        owner,
        repo,
        mcpRegistry: userId ? userMcpRegistry(userId) : undefined
      });
      const reportId = cacheReport(report);
      await say({
        text: `Detective Report: ${report.shortAnswer}`,
        blocks: buildReportBlocks(report, reportId),
        thread_ts: threadTs
      });
    } catch (error) {
      console.error("app_mention investigation failed.", error);
      await say({
        text: "Something went wrong investigating that. Try rephrasing the question, or ask again in a moment.",
        thread_ts: threadTs
      });
    }
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
