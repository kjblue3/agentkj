import { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/types";
import type OpenAI from "openai";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import { getValidServiceToken, serviceConnectUrl } from "../auth/serviceOAuth.js";
import {
  createUserConnectorCredentialIntent,
  getGitHubToken,
  getValidGitHubToken,
  listConnectedServiceIds,
  listUserConnectors,
  setUserConnector
} from "../auth/tokenStore.js";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import { extractPublicUrl, PublicWebToolProvider } from "../connectors/publicWebTool.js";
import { createLlmClient, llmModel } from "../llm/client.js";
import { describeCatalog, findCatalogEntry } from "../mcp/catalog.js";
import {
  describeServices,
  findService,
  isServiceConnected,
  resolveService,
  serviceRegistry,
  type ServiceDefinition
} from "../services/registry.js";
import { classifyIntent } from "./intentRouter.js";
import {
  approveRemoteConnector,
  AuthorizedConnectionToolProvider,
  createCredentialIntent,
  inspectRemoteConnector,
  listConnectionsForOwner,
  shareRemoteConnection,
  type AccessMode,
  type ConnectionScope
} from "../mcp/connections.js";
import { McpToolRegistry, type McpServerSpec } from "../mcp/registry.js";
import {
  buildEvidenceBlocks,
  buildReportBlocks,
  buildTimelineBlocks
} from "./blocks.js";
import { cacheReport, getCachedReport } from "./reportCache.js";

/** Per-user MCP registries, built lazily from tokenStore's userConnectors and refreshed when setup changes. */
const userMcpRegistries = new Map<string, { signature: string; registry: McpToolRegistry }>();

function connectorSpecFor(slackUserId: string, catalogId: string, credentials: Record<string, string>): McpServerSpec {
  return { name: `${slackUserId}:${catalogId}`, command: findCatalogEntry(catalogId)!.command, env: credentials };
}

function userMcpRegistry(slackUserId: string): McpToolRegistry | undefined {
  const connectors = listUserConnectors(slackUserId);
  if (connectors.length === 0) return undefined;
  const cacheKey = slackUserId;
  const signature = JSON.stringify(connectors.map((connector) => [
    connector.catalogId,
    connector.connectedAt,
    Object.keys(connector.credentials).sort()
  ]));
  const existing = userMcpRegistries.get(cacheKey);
  if (existing?.signature === signature) return existing.registry;
  existing?.registry.close().catch(() => undefined);
  const specs = connectors.map((connector) => connectorSpecFor(slackUserId, connector.catalogId, connector.credentials));
  const registry = new McpToolRegistry(specs);
  userMcpRegistries.set(cacheKey, { signature, registry });
  return registry;
}

function invalidateUserMcpRegistry(slackUserId: string): void {
  userMcpRegistries.get(slackUserId)?.registry.close().catch(() => undefined);
  userMcpRegistries.delete(slackUserId);
}

/**
 * Lazily built so it initializes after dotenv has run (this module is imported by tests that
 * never load an env). Null means no LLM — the intent router degrades to its deterministic parse.
 */
let classifierClientMemo: { client: OpenAI | null } | undefined;
function classifierClient(): OpenAI | null {
  classifierClientMemo ??= { client: createLlmClient() };
  return classifierClientMemo.client;
}

/** Source ids the asking user has access to, for intent classification and relevance routing. */
function connectedSourceIds(slackUserId: string): string[] {
  return [
    // Workspace Slack history is available to every investigation through the shared connector.
    "slack",
    ...(getGitHubToken(slackUserId) ? ["github"] : []),
    ...listConnectedServiceIds(slackUserId),
    ...listUserConnectors(slackUserId).map((connector) => connector.catalogId)
  ];
}

/** Tool providers for every OAuth service this user connected (github's tools are native). */
async function serviceToolProvidersFor(slackUserId: string): Promise<AgentToolProvider[]> {
  const providers: AgentToolProvider[] = [];
  for (const serviceId of listConnectedServiceIds(slackUserId)) {
    const service = findService(serviceId);
    if (!service?.createToolProvider) continue;
    const token = await getValidServiceToken(service, slackUserId);
    if (token) providers.push(service.createToolProvider(token));
  }
  return providers;
}

function serviceConnectText(service: ServiceDefinition, slackUserId: string): string {
  if (!service.isConfigured(process.env)) {
    return (
      `*${service.label}* isn't connectable on this deployment yet — it needs the ${service.label} OAuth app ` +
      "credentials (and `PUBLIC_BASE_URL`) in the server environment. Ask whoever runs this bot to add them."
    );
  }
  const url = serviceConnectUrl(service, slackUserId);
  if (!url) {
    return `*${service.label}* can't hand out a connect link because this deployment has no \`PUBLIC_BASE_URL\`.`;
  }
  const already = isServiceConnected(service, slackUserId)
    ? "You're already connected — reconnecting switches accounts. "
    : "";
  return `${already}<${url}|Connect your ${service.label}> — one click, then just ask your question.`;
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
  workspaceId?: string;
};

function usageText(): string {
  return "Ask me anything and I'll investigate it across the sources you've connected.\n" +
    "To connect a source, just say so — e.g. `connect strava`, `connect github` — or paste a remote MCP URL " +
    "(`connect <https://remote-mcp-url>`).\n" +
    "Say `connectors` to see what's connected and what's available.";
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
  channelId,
  pipeline,
  reply,
  postReport,
  source,
  workspaceId = process.env.SLACK_WORKSPACE_ID ?? "unknown"
}: SlackIntentArgs): Promise<void> {
  const trimmed = text.trim();

  // The LLM decides what this message wants — connect a service, list connectors, run the
  // bot-issued approve/share commands, or investigate — and, for investigations, which
  // connected sources are even relevant. No keyword prefixes, no product special-cases.
  const intent = await classifyIntent(
    trimmed,
    { connected: connectedSourceIds(userId), connectableSummary: describeServices() },
    classifierClient(),
    llmModel()
  );

  if (intent.kind === "help") {
    await reply(usageText());
    return;
  }

  if (intent.kind === "list_connectors") {
    await replyWithConnectorList(userId, reply);
    return;
  }

  if (intent.kind === "connect") {
    await handleConnectIntent(intent.target, { userId, workspaceId, channelId }, reply);
    return;
  }

  if (intent.kind === "approve") {
    const [, pendingId, ...flags] = trimmed.split(/\s+/);
    const scope: ConnectionScope = flags.includes("shared") ? "shared" : "personal";
    const accessMode: AccessMode = flags.includes("read-write") ? "read-write" : "read-only";
    const credential = flags.includes("bearer") ? "bearer" : "none";
    try {
      const connection = approveRemoteConnector(pendingId ?? "", userId, { scope, accessMode, credential });
      if (credential === "bearer") {
        const baseUrl = process.env.PUBLIC_BASE_URL;
        if (!baseUrl) {
          await reply({
            response_type: "ephemeral",
            text:
              `Approved *${connection.name}*, but it is not active because this deployment has no ` +
              "`PUBLIC_BASE_URL` for the secure credential form."
          });
          return;
        }
        const secret = createCredentialIntent(connection.id, userId);
        await reply({
          response_type: "ephemeral",
          text:
            `Approved *${connection.name}* as ${scope} / ${accessMode}. ` +
            `<${baseUrl}/auth/connectors/${secret}|Enter the provider credential securely> within 15 minutes. ` +
            "Do not paste credentials into Slack."
        });
      } else {
        await reply({
          response_type: "ephemeral",
          text: `Approved and enabled *${connection.name}* as ${scope} / ${accessMode}.`
        });
      }
    } catch (error) {
      await reply({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "That connector could not be approved."
      });
    }
    return;
  }

  if (intent.kind === "share") {
    const [, connectionId, targetType, targetId, mode] = trimmed.split(/\s+/);
    if (!["user", "channel"].includes(targetType ?? "") || !targetId) {
      await reply({
        response_type: "ephemeral",
        text: "Use `@agentkj share <connection-id> user <U…>` or `share <connection-id> channel <C…>`."
      });
      return;
    }
    try {
      const connection = shareRemoteConnection(connectionId ?? "", userId, {
        userId: targetType === "user" ? targetId : undefined,
        channelId: targetType === "channel" ? targetId : undefined,
        accessMode: mode === "read-write" ? "read-write" : "read-only"
      });
      await reply({
        response_type: "ephemeral",
        text:
          `Shared *${connection.name}* with that ${targetType}. The backend keeps the provider credential private ` +
          "and rechecks user, channel, tool, scope, and approval on every call."
      });
    } catch (error) {
      await reply({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "That connection could not be shared."
      });
    }
    return;
  }

  // Investigate. Every personal source the user connected contributes tools; the shared env
  // GitHub fallback is disabled — a person's investigation uses only what THEY connected.
  const publicUrl = extractPublicUrl(trimmed);
  const remoteProvider = new AuthorizedConnectionToolProvider({ userId, workspaceId, channelId });
  const [remoteTools, githubToken, serviceProviders] = await Promise.all([
    remoteProvider.listAgentTools(),
    getValidGitHubToken(userId),
    serviceToolProvidersFor(userId)
  ]);

  await reply({ response_type: "ephemeral", text: "Pinning the evidence to the board..." });
  const { owner, repo, question } = parseOwnerRepo(trimmed);
  const connectableServices = serviceRegistry
    .filter((service) => !isServiceConnected(service, userId))
    .map((service) => service.id);
  try {
    const report = await pipeline.investigate(question, {
      githubToken: githubToken?.token,
      githubLogin: githubToken?.login,
      owner,
      repo,
      mcpRegistry: userMcpRegistry(userId),
      publicUrl,
      toolProviders: [
        ...(publicUrl ? [new PublicWebToolProvider(publicUrl)] : []),
        ...(remoteTools.length > 0 ? [remoteProvider] : []),
        ...serviceProviders
      ],
      relevantSources: intent.kind === "investigate" ? intent.relevantSources : undefined,
      connectableServices,
      allowSharedGitHubFallback: false
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

async function replyWithConnectorList(userId: string, reply: SlackIntentReply): Promise<void> {
  const services = serviceRegistry.filter((service) => isServiceConnected(service, userId));
  const servicesText = services.length > 0
    ? services.map((service) => `• \`${service.id}\` — ${service.label}`).join("\n")
    : "_none yet_";
  const connected = listUserConnectors(userId);
  const remote = listConnectionsForOwner(userId);
  const connectedText = connected.length > 0
    ? connected.map((c) => `• \`${c.catalogId}\` — connected ${c.connectedAt}`).join("\n")
    : "_none yet_";
  const remoteText = remote.length > 0
    ? remote.map((connection) =>
        `• \`${connection.id}\` — *${connection.name}* (${connection.scope}, ${connection.accessMode}, ` +
        `${connection.active ? "active" : "awaiting credential"})\n  ${connection.url}`
      ).join("\n")
    : "_none yet_";
  await reply({
    response_type: "ephemeral",
    text:
      `*Your connected services:*\n${servicesText}\n\n*Your remote connectors:*\n${remoteText}\n\n` +
      `*Your catalog connectors:*\n${connectedText}\n\n` +
      `*Connectable services:*\n${describeServices()}\n\n` +
      `*Available catalog connectors:*\n${describeCatalog()}\n\n` +
      "Connect a service by saying so (`connect strava`), an experimental remote MCP server with " +
      "`@agentkj connect https://…`, or a vetted one with `@agentkj connect <catalog-id>` to open a secure setup form."
  });
}

/**
 * Connects whatever the router said the user wants: a registry service (one OAuth link), a
 * vetted catalog connector (secure setup form), or an arbitrary remote MCP URL (the
 * inspect-then-approve ceremony — that ceremony exists for UNTRUSTED servers only; known
 * services never go through it).
 */
async function handleConnectIntent(
  target: string,
  actor: { userId: string; workspaceId: string; channelId: string },
  reply: SlackIntentReply
): Promise<void> {
  const service = resolveService(target);
  if (service) {
    await reply({ response_type: "ephemeral", text: serviceConnectText(service, actor.userId) });
    return;
  }

  const remoteUrl = extractPublicUrl(target);
  if (remoteUrl) {
    try {
      const pending = await inspectRemoteConnector(remoteUrl, actor);
      const toolLines = pending.tools.length > 0
        ? pending.tools.map((tool) => {
            const mode = tool.readOnlyHint ? "read-only" : tool.destructiveHint ? "may write/delete" : "unspecified";
            const scopes = tool.requiredScopes.length > 0 ? `; scopes: ${tool.requiredScopes.join(", ")}` : "";
            return `• \`${tool.name}\` — ${mode}${scopes}`;
          }).join("\n")
        : "_No tools were advertised._";
      await reply({
        response_type: "ephemeral",
        text:
          `*Experimental, untrusted remote connector*\n*Name:* ${pending.name}\n*URL:* ${pending.url}\n` +
          `*Available tools and requested permissions:*\n${toolLines}\n\n` +
          "Nothing has been enabled. Review it, then explicitly approve with " +
          `\`@agentkj approve ${pending.id} personal read-only\`. Add \`shared\`, \`read-write\`, or ` +
          "`bearer` only if you intend those permissions. Never paste a credential into Slack."
      });
    } catch (error) {
      await reply({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "That remote MCP URL could not be inspected."
      });
    }
    return;
  }

  // Look for a catalog id anywhere in the target ("connect the filesystem" should work),
  // stripping punctuation so "connect filesystem!" still matches.
  const targetTokens = target.split(/\s+/);
  const entry = targetTokens
    .map((token) => findCatalogEntry(token.replace(/[^a-z0-9-]/gi, "").toLowerCase()))
    .find(Boolean);
  if (!entry) {
    await reply({
      response_type: "ephemeral",
      text:
        "I couldn't tell what to connect from that. I can connect these services by name:\n" +
        `${describeServices()}\n` +
        "…or `connect <catalog-id>` (see `connectors` for the list), or `connect <https://remote-mcp-url>`."
    });
    return;
  }
  if (targetTokens.some((pair) => pair.includes("="))) {
    await reply({
      response_type: "ephemeral",
      text:
        "I won't collect connector credentials in Slack. Run " +
        `\`@agentkj connect ${entry.id}\` with no values and I’ll send a secure setup link.`
    });
    return;
  }
  if (entry.credentialFields.length > 0) {
    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      await reply({
        response_type: "ephemeral",
        text:
          `\`${entry.id}\` needs secure setup values (${entry.credentialFields.join(", ")}), but this ` +
          "deployment has no `PUBLIC_BASE_URL` for the setup form."
      });
      return;
    }
    const secret = createUserConnectorCredentialIntent(actor.userId, entry.id);
    await reply({
      response_type: "ephemeral",
      text:
        `Open this secure setup form for *${entry.label}* within 15 minutes: ` +
        `<${baseUrl}/auth/catalog-connectors/${secret}|Connect ${entry.label}>. ` +
        "Do not paste credentials into Slack."
    });
    return;
  }
  setUserConnector(actor.userId, {
    catalogId: entry.id,
    label: entry.label,
    credentials: {},
    connectedAt: new Date().toISOString()
  });
  invalidateUserMcpRegistry(actor.userId);
  await reply({ response_type: "ephemeral", text: `Connected \`${entry.label}\`. The agent can use it on your next question.` });
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
      workspaceId: command.team_id,
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
      workspaceId: event.team,
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
