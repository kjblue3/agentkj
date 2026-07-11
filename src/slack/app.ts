import { randomBytes } from "node:crypto";
import { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/types";
import type OpenAI from "openai";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import { createMcpLoginLink } from "../auth/mcpOAuthRoutes.js";
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
import { synthesizeService } from "../services/architect.js";
import { saveDynamicSpec } from "../services/dynamicSpec.js";
import {
  allServices,
  describeServices,
  findService,
  isServiceConnected,
  resolveService,
  type ServiceDefinition
} from "../services/registry.js";
import { createServiceSetupIntent } from "../auth/serviceSetup.js";
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
  buildReportBlocks
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
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    return `*${service.label}* can't hand out links because this deployment has no \`PUBLIC_BASE_URL\`.`;
  }
  if (!service.isConfigured(process.env)) {
    // One missing prerequisite: the provider-side OAuth app. The agent walks whoever is asking
    // through creating it via the secure setup form — never "ask the admin to edit env files".
    if (service.oauth) {
      const secret = createServiceSetupIntent(service.id, slackUserId);
      return (
        `*${service.label}* needs a one-time setup: its API credentials aren't on this deployment yet. ` +
        `<${base}/auth/service-setup/${secret}|Set up ${service.label}> — the form has step-by-step instructions ` +
        "(including the callback URL to register) and shows exactly which hosts the integration talks to. " +
        "Takes ~2 minutes, then say connect again for your personal link. Never paste credentials into Slack."
      );
    }
    return (
      `*${service.label}* isn't connectable on this deployment yet — its app credentials are missing from the ` +
      "server environment. Ask whoever runs this bot to add them."
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

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type SlackActionBody = Record<string, unknown>;
type SlackBlock = Block | KnownBlock;

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
  /** Prior turns of the thread, for follow-ups referencing earlier answers. Context, not evidence. */
  conversationContext?: string;
};

function usageText(): string {
  return "Ask me anything and I'll investigate it across the sources you've connected.\n" +
    "To connect a source, just name it — `connect <any service>` — and if I don't have an integration yet, " +
    "I'll build one on the spot. Remote MCP URLs work too (`connect <https://remote-mcp-url>`).\n" +
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

export async function handleSlackIntent({
  text,
  userId,
  channelId,
  pipeline,
  reply,
  postReport,
  source,
  workspaceId = process.env.SLACK_WORKSPACE_ID ?? "unknown",
  conversationContext
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
    await requestConnectConfirmation(intent.targets, { userId, workspaceId, channelId }, reply);
    return;
  }

  if (intent.kind === "approve") {
    const [, pendingId, ...flags] = trimmed.split(/\s+/);
    const scope: ConnectionScope = flags.includes("shared") ? "shared" : "personal";
    const accessMode: AccessMode = flags.includes("read-write") ? "read-write" : "read-only";
    const credential = flags.includes("bearer") ? "bearer" : flags.includes("oauth") ? "oauth" : "none";
    try {
      const connection = approveRemoteConnector(pendingId ?? "", userId, { scope, accessMode, credential });
      if (credential === "oauth") {
        const login = await createMcpLoginLink(connection.id, userId);
        await reply({
          response_type: "ephemeral",
          text: "url" in login
            ? `Approved *${connection.name}* as ${scope} / ${accessMode}. <${login.url}|Log in to ${connection.name}> — ` +
              "you'll approve access on the provider's own page (no app setup needed; I registered myself as its client)."
            : `Approved *${connection.name}*, but OAuth login isn't possible: ${login.error}`
        });
        return;
      }
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

  await runInvestigation({
    question: trimmed,
    userId,
    channelId,
    workspaceId,
    pipeline,
    reply,
    postReport,
    relevantSources: intent.kind === "investigate" ? intent.relevantSources : undefined,
    conversationContext,
    source
  });
}

/**
 * The investigation path, shared by direct questions and approved follow-ups. Every personal
 * source the user connected contributes tools; the shared env GitHub fallback is disabled — a
 * person's investigation uses only what THEY connected.
 */
export async function runInvestigation({
  question,
  userId,
  channelId,
  workspaceId,
  pipeline,
  reply,
  postReport,
  relevantSources,
  conversationContext,
  source = "mention"
}: {
  question: string;
  userId: string;
  channelId: string;
  workspaceId: string;
  pipeline: InvestigationPipeline;
  reply: SlackIntentReply;
  postReport: (reportText: string, blocks: SlackBlock[]) => Promise<unknown>;
  relevantSources?: string[];
  conversationContext?: string;
  source?: "slash" | "mention" | "followup";
}): Promise<void> {
  const publicUrl = extractPublicUrl(question);
  const remoteProvider = new AuthorizedConnectionToolProvider({ userId, workspaceId, channelId });
  const [remoteTools, githubToken, serviceProviders] = await Promise.all([
    remoteProvider.listAgentTools(),
    getValidGitHubToken(userId),
    serviceToolProvidersFor(userId)
  ]);

  await reply({ response_type: "ephemeral", text: "On it — give me a moment..." });
  const { owner, repo, question: scopedQuestion } = parseOwnerRepo(question);
  const connectableServices = allServices()
    .filter((service) => !isServiceConnected(service, userId))
    .map((service) => service.id);
  try {
    const report = await pipeline.investigate(scopedQuestion, {
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
      relevantSources,
      connectableServices,
      conversationContext,
      allowSharedGitHubFallback: false
    });
    // Never tell someone to connect a service they already connected — when a connected
    // service's tools failed (paywall, revoked grant), the shortAnswer carries the real reason.
    const suggestedService = report.suggestedConnection ? resolveService(report.suggestedConnection) : undefined;
    const cleaned = suggestedService && isServiceConnected(suggestedService, userId)
      ? { ...report, suggestedConnection: undefined }
      : report;
    const reportId = cacheReport(cleaned);
    await postReport(cleaned.shortAnswer, buildReportBlocks(cleaned, reportId));
  } catch (error) {
    console.error(`${source} investigation failed.`, error);
    await reply({
      response_type: "ephemeral",
      text: "Something went wrong investigating that. Try rephrasing the question, or ask again in a moment."
    });
  }
}

/**
 * Connect requests confirm before acting: the bot names the brands it recognized (or will
 * build) and waits for a Yes/No click — several services can be connected in one message.
 */
const pendingConnects = new Map<string, {
  targets: string[];
  actor: { userId: string; workspaceId: string; channelId: string };
  expiresAt: number;
}>();

async function requestConnectConfirmation(
  targets: string[],
  actor: { userId: string; workspaceId: string; channelId: string },
  reply: SlackIntentReply
): Promise<void> {
  const labels = targets.map((target) => {
    const known = resolveService(target);
    if (known) return `*${known.label}*`;
    return extractPublicUrl(target) ? `*${target}* (remote MCP server)` : `*${target}* (I'll build the integration)`;
  });
  const confirmId = randomBytes(9).toString("base64url");
  pendingConnects.set(confirmId, { targets, actor, expiresAt: Date.now() + 15 * 60_000 });

  const listText = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  await reply({
    response_type: "ephemeral",
    text: `Connect ${listText}?`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Connect ${listText}?` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Yes, connect" }, style: "primary", action_id: "connect_confirm", value: confirmId },
          { type: "button", text: { type: "plain_text", text: "No" }, action_id: "connect_cancel", value: confirmId }
        ]
      }
    ]
  });
}

export async function executeConfirmedConnect(
  confirmId: string,
  clickerUserId: string,
  reply: SlackIntentReply
): Promise<void> {
  const pending = pendingConnects.get(confirmId);
  pendingConnects.delete(confirmId);
  if (!pending || pending.expiresAt < Date.now()) {
    await reply({ response_type: "ephemeral", replace_original: true, text: "That connect request expired — just ask again." });
    return;
  }
  if (pending.actor.userId !== clickerUserId) {
    await reply({ response_type: "ephemeral", replace_original: false, text: "Only the person who asked can confirm this." });
    return;
  }
  await reply({ response_type: "ephemeral", replace_original: true, text: "Connecting..." });
  for (const target of pending.targets) {
    await handleConnectIntent(target, pending.actor, (message) =>
      reply(typeof message === "string" ? { response_type: "ephemeral", replace_original: false, text: message } : { replace_original: false, ...message })
    );
  }
}

export function cancelPendingConnect(confirmId: string): void {
  pendingConnects.delete(confirmId);
}

async function replyWithConnectorList(userId: string, reply: SlackIntentReply): Promise<void> {
  const services = allServices().filter((service) => isServiceConnected(service, userId));
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
      `*Integrations built so far (whenever anyone here asks, I build one):*\n${describeServices()}\n\n` +
      `*Available catalog connectors:*\n${describeCatalog()}\n\n` +
      "Connect a service by naming it (`connect <any service>` — I'll build missing integrations myself), " +
      "an experimental remote MCP server with `@agentkj connect https://…`, or a vetted one with " +
      "`@agentkj connect <catalog-id>` to open a secure setup form."
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
      if (pending.requiresAuth) {
        await reply({
          response_type: "ephemeral",
          text:
            `*Experimental, untrusted remote connector*\n*Name:* ${pending.name}\n*URL:* ${pending.url}\n` +
            "This server requires an OAuth login before it will even list its tools. Nothing has been enabled. " +
            `To proceed, approve with \`@agentkj approve ${pending.id} oauth personal read-only\` — I'll register ` +
            "myself as its OAuth client and send you a login link; its tools get reviewed and listed after you log in."
        });
        return;
      }
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
          `\`@agentkj approve ${pending.id} personal read-only\`. Add \`shared\`, \`read-write\`, \`oauth\` (to log ` +
          "in through the provider), or `bearer` only if you intend those permissions. Never paste a credential into Slack."
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
    // Unknown service: the agent builds the integration itself. The architect drafts OAuth
    // endpoints + read-only tools from model knowledge, validation pins it to declared hosts,
    // and the setup form (which discloses those hosts) is the human approval that arms it.
    await reply({
      response_type: "ephemeral",
      text: `I don't have a *${target}* integration yet — give me a moment to build one…`
    });
    const client = classifierClient();
    if (!client) {
      await reply({
        response_type: "ephemeral",
        text:
          "I can't synthesize new integrations right now (no language model is configured). " +
          "You can still paste a remote MCP URL with `connect <https://…>`."
      });
      return;
    }
    const result = await synthesizeService(target, client, llmModel());
    if ("error" in result) {
      await reply({
        response_type: "ephemeral",
        text:
          `I couldn't build a *${target}* integration: ${result.error}\n` +
          `Here's what I can connect by name today:\n${describeServices()}\n` +
          "…or paste a remote MCP URL with `connect <https://…>`."
      });
      return;
    }

    // The architect may resolve a mangled name to something that already exists — never let a
    // typo's draft clobber a working integration; reuse the existing one instead.
    const existing = findService(result.spec.id);
    if (!existing) saveDynamicSpec(result.spec);
    const service = existing ?? findService(result.spec.id);
    if (!service) {
      await reply({ response_type: "ephemeral", text: "I built the integration but couldn't load it back — try again." });
      return;
    }

    // When what got built isn't literally what they typed, say how the name was read — the
    // jarring alternative is "no google gocs integration" followed by "Built Google Cloud Storage".
    const readAs = normalizeName(target) !== normalizeName(service.label)
      && !service.aliases.some((alias) => normalizeName(alias) === normalizeName(target))
      ? `I read *${target}* as *${service.label}* — if you meant something else, say \`connect <the right name>\`.\n`
      : "";
    const spec = service.dynamicSpec ?? result.spec;
    const hosts = spec.apiHosts.map((host) => `\`${host}\``).join(", ");
    const paywall = spec.accessNotes ? `\n⚠️ ${spec.accessNotes}` : "";
    await reply({
      response_type: "ephemeral",
      text:
        `${readAs}${existing ? `I already have a *${service.label}* integration` : `Built a *${service.label}* integration`}: ` +
        `${spec.tools.length} read-only tool${spec.tools.length === 1 ? "" : "s"}, talking only to ${hosts}.${paywall}\n` +
        serviceConnectText(service, actor.userId)
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

  app.event("app_mention", async ({ event, say, client }) => {
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

    // A mention inside an existing thread is usually a follow-up ("explain those commits") —
    // fetch the prior turns so the investigation can resolve references to earlier answers.
    // Best-effort: a missing scope or API hiccup just means no context, never a dead reply.
    let conversationContext: string | undefined;
    if (event.thread_ts && event.thread_ts !== event.ts) {
      try {
        const replies = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 12 });
        const turns = (replies.messages ?? [])
          .filter((message) => typeof message.text === "string" && message.text.trim() && message.ts !== event.ts)
          .slice(-10)
          .map((message) => `${message.bot_id ? "you (the bot)" : "user"}: ${message.text!.slice(0, 600)}`);
        conversationContext = turns.length > 0 ? turns.join("\n") : undefined;
      } catch (error) {
        console.warn("Could not fetch thread context for a follow-up mention.", error);
      }
    }

    await handleSlackIntent({
      text: stripMention(event.text),
      userId,
      channelId: event.channel,
      workspaceId: event.team,
      threadTs,
      conversationContext,
      pipeline,
      reply: (message) => typeof message === "string"
        ? sayInThread({ text: message, thread_ts: threadTs })
        : sayInThread({ ...message, thread_ts: threadTs }),
      postReport: (text, blocks) => sayInThread({ text, blocks, thread_ts: threadTs }),
      source: "mention"
    });
  });

  app.action("connect_confirm", async ({ ack, action, body, respond }) => {
    await ack();
    const confirmId = "value" in action ? String(action.value) : "";
    const clicker = stringAt(objectAt(body as unknown as SlackActionBody, "user"), "id") ?? "";
    await executeConfirmedConnect(confirmId, clicker, respond as SlackIntentReply);
  });

  app.action("connect_cancel", async ({ ack, action, respond }) => {
    await ack();
    cancelPendingConnect("value" in action ? String(action.value) : "");
    await respond({ response_type: "ephemeral", replace_original: true, text: "Okay, not connecting anything." });
  });

  // The user approved a suggested follow-up — the agent executes it itself as a fresh
  // investigation in the same thread, carrying the original report as context.
  app.action("followup_do", async ({ ack, action, body, respond, client }) => {
    await ack();
    const report = getCachedReport("value" in action ? String(action.value) : "");
    const actionBody = body as unknown as SlackActionBody;
    const userId = stringAt(objectAt(actionBody, "user"), "id");
    const channelId = stringAt(objectAt(actionBody, "channel"), "id")
      ?? stringAt(objectAt(actionBody, "container"), "channel_id");
    const threadTs = stringAt(objectAt(actionBody, "message"), "thread_ts")
      ?? stringAt(objectAt(actionBody, "message"), "ts")
      ?? stringAt(objectAt(actionBody, "container"), "message_ts");
    const workspaceId = stringAt(objectAt(actionBody, "team"), "id") ?? process.env.SLACK_WORKSPACE_ID ?? "unknown";
    const followup = report?.recommendedActions.find((candidate) => candidate.trim());

    if (!report || !followup || !userId || !channelId) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "That follow-up expired — ask me again." });
      return;
    }
    await runInvestigation({
      question: followup,
      userId,
      channelId,
      workspaceId,
      pipeline,
      reply: (message) => respond(typeof message === "string"
        ? { response_type: "ephemeral", replace_original: false, text: message }
        : { replace_original: false, ...message }),
      postReport: (text, blocks) => client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text, blocks }),
      conversationContext:
        `The user clicked "Do it" on a follow-up you suggested. Original question: ${report.question}\n` +
        `Your earlier answer: ${report.shortAnswer}\nNow execute the follow-up: ${followup}`,
      source: "followup"
    });
  });

  app.action("followup_skip", async ({ ack, respond }) => {
    await ack();
    await respond({ response_type: "ephemeral", replace_original: false, text: "Okay, skipping that." });
  });

  return app;
}
