import { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/types";
import type OpenAI from "openai";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import type { InvestigationContext, ConnectionDescriptor } from "../core/context.js";
import { ConnectionAccessError, investigationContext } from "../core/context.js";
import { extractPublicUrl, PublicWebToolProvider } from "../connectors/publicWebTool.js";
import { createLlmClient, LlmCapacityExhausted, llmModel } from "../llm/client.js";
import { synthesizeService, verifySpecEndpoints } from "../services/architect.js";
import { saveDynamicSpec } from "../services/dynamicSpec.js";
import {
  allServices,
  describeServices,
  findService,
  isServiceConfigured,
  resolveService,
  type ServiceDefinition
} from "../services/registry.js";
import { createServiceSetupIntent } from "../auth/serviceSetup.js";
import { getValidServiceToken, serviceConnectUrl } from "../auth/serviceOAuth.js";
import { createMcpLoginLink } from "../auth/mcpOAuthRoutes.js";
import { isWorkspaceAdministrator, listWorkspaceAdministrators } from "../auth/workspaceAdmin.js";
import {
  consumeActionIntent,
  bindActionIntentMessage,
  createActionIntent,
  createInvestigationJob,
  getInvestigationJob,
  getInvestigationJobResult,
  listDueCapacityJobs,
  listExpiredCapacityJobs,
  listWorkspaceTokens,
  markEventProcessed,
  saveSlackInstallation,
  saveSlackInstallationRecord,
  getSlackInstallationRecord,
  getSlackInstallationToken,
  updateInvestigationJob
} from "../state/repositories.js";
import type { InvestigationResult } from "../types/schemas.js";
import { investigationResultSchema } from "../types/schemas.js";
import { classifyIntent, heuristicIntent, type SlackIntent } from "./intentRouter.js";
import { buildReportBlocks } from "./blocks.js";
import { SlackToolProvider } from "./toolProvider.js";
import {
  approveRemoteConnector,
  AuthorizedConnectionToolProvider,
  createCredentialIntent,
  inspectRemoteConnector
} from "../mcp/connections.js";

type SlackBlock = Block | KnownBlock;
type SlackReply = (message: Record<string, unknown> | string) => Promise<unknown>;
const threadQueues = new Map<string, Promise<void>>();
let activeInvestigations = 0;
const investigationWaiters: Array<() => void> = [];
let classifierMemo: OpenAI | null | undefined;

function classifier(): OpenAI | null {
  if (classifierMemo === undefined) classifierMemo = createLlmClient();
  return classifierMemo;
}

function stripMention(text: string): string { return text.replace(/<@[A-Z0-9]+>/gi, "").trim(); }
function threadKey(context: InvestigationContext): string { return `${context.workspaceId}:${context.channelId}:${context.threadTs}`; }
function investigationLimit(): number {
  const configured = Number(process.env.MAX_CONCURRENT_INVESTIGATIONS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 4;
}

function enqueueThread(context: InvestigationContext, operation: () => Promise<void>): Promise<void> {
  const key = threadKey(context);
  const previous = threadQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => withInvestigationSlot(operation)).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function withInvestigationSlot(operation: () => Promise<void>): Promise<void> {
  const limit = investigationLimit();
  if (activeInvestigations >= limit) await new Promise<void>((resolve) => investigationWaiters.push(resolve));
  activeInvestigations++;
  try { await operation(); }
  finally {
    activeInvestigations--;
    investigationWaiters.shift()?.();
  }
}

async function connectionDescriptors(workspaceId: string, excluded = new Set<string>()): Promise<{
  descriptors: ConnectionDescriptor[];
  providers: ReturnType<ServiceDefinition["createToolProvider"]>[];
}> {
  const descriptors: ConnectionDescriptor[] = [];
  const providers: ReturnType<ServiceDefinition["createToolProvider"]>[] = [];
  for (const record of listWorkspaceTokens(workspaceId)) {
    const service = findService(record.serviceId);
    if (!service) continue;
    const connectionId = `${service.id}:${record.userId}`;
    if (excluded.has(connectionId)) continue;
    descriptors.push({
      id: connectionId,
      workspaceId,
      ownerUserId: record.userId,
      serviceId: service.id,
      serviceLabel: service.label,
      domain: service.domain,
      scopes: record.token.scopes,
      health: record.token.health,
      connectedAt: record.token.connectedAt
    });
    const token = await getValidServiceToken(service, workspaceId, record.userId);
    if (token) providers.push(service.createToolProvider(token, connectionId, record.userId));
  }
  return { descriptors, providers };
}

async function privateConnectMessage(
  service: ServiceDefinition,
  context: InvestigationContext
): Promise<string> {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!base) return `I can’t open an authorization flow until this deployment has a public callback URL.`;
  if (!isServiceConfigured(service, context.workspaceId)) {
    if (await isWorkspaceAdministrator(context.workspaceId, context.userId)) {
      const secret = createServiceSetupIntent(service.id, context.workspaceId, context.userId);
      return `This workspace needs a one-time administrator setup for *${service.label}*. <${base}/auth/service-setup/${secret}|Review and configure the shared OAuth application>. Other members will authorize only their own accounts.`;
    }
    const admins = await listWorkspaceAdministrators(context.workspaceId);
    const owners = admins.length > 0 ? admins.map((id) => `<@${id}>`).join(", ") : "a workspace administrator";
    return `*${service.label}* needs one-time workspace setup by ${owners}. No credentials or setup link are available to non-administrators.`;
  }
  const url = serviceConnectUrl(service, context.workspaceId, context.userId);
  if (!url) return `I couldn’t create a valid authorization link.`;
  return `By continuing, you authorize a read-only workspace connection. Other workspace members may trigger its use, it may be combined with other members’ connections, and evidence-backed findings may be posted in public Slack threads. <${url}|Authorize your ${service.label} account>.`;
}

export async function handleSlackIntent(args: {
  text: string;
  context: InvestigationContext;
  pipeline: InvestigationPipeline;
  privateReply: SlackReply;
  publicReply: SlackReply;
  updatePublicStatus?: (messageTs: string, text: string) => Promise<unknown>;
  conversationContext?: string;
  privateNotify?: (userId: string, message: string) => Promise<unknown>;
}): Promise<void> {
  const { text, context, pipeline, privateReply, publicReply, updatePublicStatus, conversationContext, privateNotify } = args;
  const available = await connectionDescriptors(context.workspaceId);
  let intent: SlackIntent;
  try {
    intent = await classifyIntent(
      text,
      {
        connected: ["slack", ...new Set(available.descriptors.map((item) => item.serviceId))],
        connectableSummary: describeServices(context.workspaceId)
      },
      classifier(),
      llmModel(),
      conversationContext
    );
  } catch (error) {
    if (!(error instanceof LlmCapacityExhausted)) throw error;
    intent = heuristicIntent(text);
    if (intent.kind === "investigate") {
      const job = createInvestigationJob(context, text);
      updateInvestigationJob(job.id, "waiting_for_capacity", { retryAt: error.retryAt.toISOString() });
      const posted = await publicReply(`All configured language-model keys are temporarily rate-limited. I saved this request and will resume it after ${error.retryAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
      const statusMessageTs = posted && typeof posted === "object" && "ts" in posted ? String((posted as { ts: unknown }).ts) : undefined;
      if (statusMessageTs) updateInvestigationJob(job.id, "waiting_for_capacity", { retryAt: error.retryAt.toISOString(), statusMessageTs });
      scheduleResume(job.id, pipeline, publicReply, updatePublicStatus);
      return;
    }
  }

  if (intent.kind === "connect") {
    for (const target of intent.targets) await handleConnect(target, context, privateReply);
    return;
  }
  if (intent.kind === "list_connectors") {
    const lines = available.descriptors.length > 0
      ? available.descriptors.map((item) => `• *${item.serviceLabel}* via <@${item.ownerUserId}> — ${item.health}`).join("\n")
      : "No member has authorized a connection yet.";
    await privateReply(`${intent.acknowledgement ? `${intent.acknowledgement}\n\n` : ""}*Workspace connections available to investigations:*\n${lines}\n\n*Integrations:*\n${describeServices(context.workspaceId)}`);
    return;
  }
  if (intent.kind === "help") {
    await publicReply(intent.acknowledgement ?? "Ask a question in this thread and I’ll investigate it across authorized workspace connections. Connection setup and account details stay private.");
    return;
  }
  if (intent.kind === "approve" || intent.kind === "share") {
    if (intent.kind === "share") {
      await privateReply("Connections authorized through this workspace are already available read-only to workspace investigations.");
      return;
    }
    const [, pendingId, credential = "none"] = text.trim().split(/\s+/);
    try {
      const connection = approveRemoteConnector(pendingId ?? "", context.userId, {
        scope: "shared",
        accessMode: "read-only",
        credential: credential === "oauth" ? "oauth" : credential === "bearer" ? "bearer" : "none"
      });
      if (credential === "oauth") {
        const login = await createMcpLoginLink(connection.id, context.userId);
        await privateReply("url" in login
          ? `The read-only workspace connection is approved. <${login.url}|Authorize it privately>.`
          : login.error);
      } else if (credential === "bearer") {
        const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
        const secret = createCredentialIntent(connection.id, context.userId);
        await privateReply(base
          ? `<${base}/auth/connectors/${secret}|Enter the credential privately>. It will be encrypted and available only to this workspace connection.`
          : "This deployment needs a public base URL before it can collect the credential privately.");
      } else {
        await privateReply("The inspected read-only connection is now available to workspace investigations.");
      }
    } catch (error) {
      await privateReply(error instanceof Error ? error.message : "The connection could not be approved.");
    }
    return;
  }

  const job = createInvestigationJob(context, text);
  if (threadQueues.has(threadKey(context)) || activeInvestigations >= investigationLimit()) {
    await publicReply("I’ve queued this investigation behind work already running for the workspace. It will stay in this thread and start automatically.");
  }
  await enqueueThread(context, () => runInvestigation({
    jobId: job.id,
    question: text,
    context,
    pipeline,
    publicReply,
    conversationContext,
    relevantSources: intent.relevantSources,
    acknowledgement: intent.acknowledgement,
    privateNotify,
    updatePublicStatus
  }));
}

async function handleConnect(target: string, context: InvestigationContext, privateReply: SlackReply): Promise<void> {
  const remoteUrl = extractPublicUrl(target);
  if (remoteUrl) {
    try {
      const pending = await inspectRemoteConnector(remoteUrl, {
        userId: context.userId,
        workspaceId: context.workspaceId,
        channelId: context.channelId
      });
      const tools = pending.tools.map((tool) => `• \`${tool.name}\` — ${tool.description ?? "No description"}`).join("\n") || "No tools were advertised.";
      await privateReply(`I inspected this experimental, untrusted remote MCP server.\n${tools}\n\nNothing is enabled yet. Approve it read-only for this workspace with \`approve ${pending.id}${pending.requiresAuth ? " oauth" : ""}\`. Use \`bearer\` only when the server explicitly requires a manually issued credential.`);
    } catch (error) {
      await privateReply(error instanceof Error ? error.message : "The remote MCP server could not be inspected.");
    }
    return;
  }
  let service = resolveService(target);
  if (!service) {
    const client = classifier();
    if (!client) {
      await privateReply("I can’t build a new integration while language-model capacity is unavailable.");
      return;
    }
    const result = await synthesizeService(target, client, llmModel());
    if ("error" in result) { await privateReply(result.error); return; }
    const invalid = await verifySpecEndpoints(result.spec);
    if (invalid) { await privateReply(`I couldn’t verify the proposed integration: ${invalid}.`); return; }
    saveDynamicSpec(result.spec);
    service = findService(result.spec.id);
  }
  if (!service) { await privateReply("The integration could not be loaded after validation."); return; }
  await privateReply(await privateConnectMessage(service, context));
}

export async function runInvestigation(args: {
  jobId: string;
  question: string;
  context: InvestigationContext;
  pipeline: InvestigationPipeline;
  publicReply: SlackReply;
  conversationContext?: string;
  relevantSources?: string[];
  acknowledgement?: string;
  privateNotify?: (userId: string, message: string) => Promise<unknown>;
  excludedConnectionIds?: Set<string>;
  updatePublicStatus?: (messageTs: string, text: string) => Promise<unknown>;
}): Promise<void> {
  const { jobId, question, context, pipeline, publicReply, conversationContext, relevantSources, privateNotify } = args;
  const previousJob = getInvestigationJob(jobId);
  updateInvestigationJob(jobId, "running");
  if (previousJob?.statusMessageTs && args.updatePublicStatus) {
    await args.updatePublicStatus(previousJob.statusMessageTs, "Language-model capacity is available again. I’ve resumed this investigation.");
  } else {
    await publicReply(args.acknowledgement ?? "I’m tracing this through the workspace’s authorized sources now.");
  }
  try {
    const available = await connectionDescriptors(context.workspaceId, args.excludedConnectionIds);
    const installation = getSlackInstallationToken(context.workspaceId);
    const workspaceChatProvider = installation
      ? new SlackToolProvider(installation.botToken, installation.userToken)
      : undefined;
    const remoteProvider = new AuthorizedConnectionToolProvider({
      userId: context.userId,
      workspaceId: context.workspaceId,
      channelId: context.channelId
    });
    const publicUrl = extractPublicUrl(question);
    const report = await pipeline.investigate(question, {
      context,
      publicUrl,
      toolProviders: [
        ...available.providers,
        remoteProvider,
        ...(workspaceChatProvider ? [workspaceChatProvider] : []),
        ...(publicUrl ? [new PublicWebToolProvider(publicUrl)] : [])
      ],
      connectionDescriptors: available.descriptors,
      relevantSources,
      connectableServices: allServices().filter((service) =>
        !available.descriptors.some((connection) => connection.serviceId === service.id)
      ).map((service) => service.id),
      conversationContext,
      requireLlm: true
    });
    updateInvestigationJob(jobId, "completed", { result: report });
    const actionId = createActionIntent({
      jobId,
      workspaceId: context.workspaceId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      kind: "followup",
      payload: {}
    });
    const owners = [...new Set(available.descriptors
      .filter((connection) => report.evidence.some((item) => item.id.startsWith(connection.id)))
      .map((connection) => `<@${connection.ownerUserId}>`))];
    const attribution = owners.length > 0 ? `\n_Connections used: ${owners.join(", ")}._` : "";
    const posted = await publicReply({ text: `${report.shortAnswer}${attribution}`, blocks: buildReportBlocks(report, actionId) });
    const postedTs = posted && typeof posted === "object" && "ts" in posted ? String((posted as { ts: unknown }).ts) : undefined;
    if (postedTs) bindActionIntentMessage(actionId, postedTs);
  } catch (error) {
    if (error instanceof ConnectionAccessError && error.connectionId && error.ownerUserId) {
      updateInvestigationJob(jobId, "waiting_for_authorization", { waitingConnectionId: error.connectionId });
      const service = findService(error.connectionId.split(":")[0] ?? "");
      const url = service ? serviceConnectUrl(service, context.workspaceId, error.ownerUserId, jobId) : null;
      if (privateNotify && url) {
        await privateNotify(error.ownerUserId,
          `This investigation needs your *${service!.label}* connection to be authorized again. Reauthorizing keeps it read-only and available to workspace investigations. <${url}|Reauthorize now>.`
        );
      }
      await publicReply(`I paused because a selected workspace connection needs renewed authorization. I’ve privately contacted <@${error.ownerUserId}>; I’ll resume automatically or try another compatible connection after 15 minutes.`);
      scheduleAuthorizationResume({ ...args, ownerUserId: error.ownerUserId, connectionId: error.connectionId });
      return;
    }
    if (error instanceof LlmCapacityExhausted) {
      updateInvestigationJob(jobId, "waiting_for_capacity", { retryAt: error.retryAt.toISOString() });
      const posted = await publicReply(`All configured language-model keys are temporarily rate-limited. I saved this investigation and will resume it after ${error.retryAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
      const statusMessageTs = posted && typeof posted === "object" && "ts" in posted ? String((posted as { ts: unknown }).ts) : undefined;
      if (statusMessageTs) updateInvestigationJob(jobId, "waiting_for_capacity", { retryAt: error.retryAt.toISOString(), statusMessageTs });
      scheduleResume(jobId, pipeline, publicReply, args.updatePublicStatus);
      return;
    }
    updateInvestigationJob(jobId, "failed");
    await publicReply("I couldn’t complete this investigation. The failure was recorded without exposing connection details; please try again shortly.");
  }
}

function scheduleAuthorizationResume(args: Parameters<typeof runInvestigation>[0] & { ownerUserId: string; connectionId: string }): void {
  const deadline = Date.now() + 15 * 60_000;
  const check = async (): Promise<void> => {
    const [serviceId] = args.connectionId.split(":");
    const service = findService(serviceId ?? "");
    const token = service ? await getValidServiceToken(service, args.context.workspaceId, args.ownerUserId) : undefined;
    if (token) {
      await enqueueThread(args.context, () => runInvestigation(args));
      return;
    }
    if (Date.now() >= deadline) {
      const excluded = new Set(args.excludedConnectionIds ?? []);
      excluded.add(args.connectionId);
      await enqueueThread(args.context, () => runInvestigation({ ...args, excludedConnectionIds: excluded }));
      return;
    }
    setTimeout(() => { void check(); }, 15_000);
  };
  setTimeout(() => { void check(); }, 15_000);
}

function scheduleResume(
  jobId: string,
  pipeline: InvestigationPipeline,
  publicReply: SlackReply,
  updatePublicStatus?: (messageTs: string, text: string) => Promise<unknown>
): void {
  const job = getInvestigationJob(jobId);
  if (!job?.retryAt) return;
  const delay = Math.max(0, new Date(job.retryAt).getTime() - Date.now());
  setTimeout(() => {
    const current = getInvestigationJob(jobId);
    if (!current || current.status !== "waiting_for_capacity" || new Date(current.expiresAt) <= new Date()) return;
    void enqueueThread(current.context, () => runInvestigation({
      jobId, question: current.question, context: current.context, pipeline, publicReply, updatePublicStatus
    }));
  }, Math.min(delay, 2_147_000_000));
}

export function createSlackApp(pipeline: InvestigationPipeline): App | null {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!appToken || !signingSecret) return null;
  if (token && process.env.SLACK_WORKSPACE_ID) {
    saveSlackInstallation(process.env.SLACK_WORKSPACE_ID, token, process.env.SLACK_USER_TOKEN);
  }
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const stateSecret = process.env.SLACK_STATE_SECRET;
  if (!token && (!clientId || !clientSecret || !stateSecret)) return null;
  const installationStore = {
    storeInstallation: async (installation: Record<string, unknown>) => {
      const teamId = (installation.team as { id?: string } | undefined)?.id;
      const enterpriseId = (installation.enterprise as { id?: string } | undefined)?.id;
      const workspaceId = teamId ?? enterpriseId;
      if (!workspaceId) throw new Error("Slack installation has no workspace identifier.");
      saveSlackInstallationRecord(workspaceId, installation, enterpriseId);
    },
    fetchInstallation: async (query: { teamId?: string; enterpriseId?: string }) => {
      const workspaceId = query.teamId ?? query.enterpriseId;
      const installation = workspaceId ? getSlackInstallationRecord(workspaceId) : undefined;
      if (!installation) throw new Error("Slack installation not found.");
      return installation;
    },
    deleteInstallation: async () => undefined
  };
  const app = token
    ? new App({ token, appToken, signingSecret, socketMode: true })
    : new App({
        clientId: clientId!, clientSecret: clientSecret!, stateSecret: stateSecret!, signingSecret,
        appToken, socketMode: true, installationStore: installationStore as never,
        scopes: ["app_mentions:read", "channels:history", "chat:write", "groups:history", "im:history", "im:read", "im:write", "users:read"]
      });

  app.event("app_mention", async ({ event, client, body }) => {
    if (!("user" in event) || typeof event.user !== "string") return;
    if (!event.team) return;
    const eventId = typeof (body as { event_id?: unknown }).event_id === "string"
      ? String((body as { event_id: string }).event_id)
      : `${event.team}:${event.channel}:${event.ts}`;
    if (!markEventProcessed(eventId)) return;
    const threadTs = event.thread_ts ?? event.ts;
    const context = investigationContext({
      requestId: eventId,
      workspaceId: event.team,
      channelId: event.channel,
      threadTs,
      userId: event.user
    });
    let transcript: string | undefined;
    try {
      const replies = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 20 });
      transcript = replies.messages?.filter((message) => message.ts !== event.ts && message.text)
        .slice(-15).map((message) => `${message.bot_id ? "assistant" : "member"}: ${message.text}`).join("\n");
    } catch { transcript = undefined; }
    const privateReply: SlackReply = (message) => {
      const payload = typeof message === "string" ? { text: message } : message;
      return client.chat.postEphemeral({ channel: event.channel, user: event.user, ...payload } as never);
    };
    const privateNotify = async (targetUserId: string, message: string): Promise<unknown> => {
      try {
        return await client.chat.postEphemeral({ channel: event.channel, user: targetUserId, text: message });
      } catch {
        const opened = await client.conversations.open({ users: targetUserId });
        if (!opened.channel?.id) throw new Error("Could not open a private conversation.");
        return client.chat.postMessage({ channel: opened.channel.id, text: message });
      }
    };
    const publicReply: SlackReply = (message) => {
      const payload = typeof message === "string" ? { text: message } : message;
      return client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, ...payload } as never);
    };
    const updatePublicStatus = (messageTs: string, text: string) => client.chat.update({
      channel: event.channel,
      ts: messageTs,
      text
    });
    await handleSlackIntent({
      text: stripMention(event.text), context, pipeline, privateReply, publicReply, updatePublicStatus, privateNotify, conversationContext: transcript
    });
  });

  app.action("followup_do", async ({ ack, action, body, client }) => {
    await ack();
    const raw = body as unknown as Record<string, unknown>;
    const workspaceId = String((raw.team as { id?: string } | undefined)?.id ?? "");
    const channelId = String((raw.channel as { id?: string } | undefined)?.id ?? (raw.container as { channel_id?: string } | undefined)?.channel_id ?? "");
    const threadTs = String((raw.message as { thread_ts?: string; ts?: string } | undefined)?.thread_ts ?? (raw.message as { ts?: string } | undefined)?.ts ?? "");
    const messageTs = String((raw.message as { ts?: string } | undefined)?.ts ?? "");
    const actionId = "value" in action ? String(action.value) : "";
    const intent = consumeActionIntent(actionId, { workspaceId, channelId, threadTs, messageTs, kind: "followup" });
    const original = intent ? investigationResultSchema.safeParse(getInvestigationJobResult(intent.jobId)) : undefined;
    const userId = String((raw.user as { id?: string } | undefined)?.id ?? "");
    const followup = original?.success ? original.data.recommendedActions.find(Boolean) : undefined;
    if (!intent || !original?.success || !followup || !userId) return;
    const context = investigationContext({ workspaceId, channelId, threadTs, userId });
    const job = createInvestigationJob(context, followup);
    await enqueueThread(context, () => runInvestigation({
      jobId: job.id,
      question: followup,
      context,
      pipeline,
      publicReply: (message) => {
        const payload = typeof message === "string" ? { text: message } : message;
        return client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...payload } as never);
      },
      conversationContext: `Earlier question: ${original.data.question}\nEarlier answer: ${original.data.shortAnswer}`
    }));
  });

  app.action("followup_skip", async ({ ack, action, body, client }) => {
    await ack();
    const raw = body as unknown as Record<string, unknown>;
    const workspaceId = String((raw.team as { id?: string } | undefined)?.id ?? "");
    const channelId = String((raw.channel as { id?: string } | undefined)?.id ?? (raw.container as { channel_id?: string } | undefined)?.channel_id ?? "");
    const threadTs = String((raw.message as { thread_ts?: string; ts?: string } | undefined)?.thread_ts ?? (raw.message as { ts?: string } | undefined)?.ts ?? "");
    const messageTs = String((raw.message as { ts?: string } | undefined)?.ts ?? "");
    const actionId = "value" in action ? String(action.value) : "";
    const intent = consumeActionIntent(actionId, { workspaceId, channelId, threadTs, messageTs, kind: "followup" });
    if (intent) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "Okay — I’ll leave that follow-up alone." });
    }
  });

  setInterval(() => {
    for (const job of listDueCapacityJobs()) {
      updateInvestigationJob(job.id, "queued");
      const publicReply: SlackReply = (message) => {
        const payload = typeof message === "string" ? { text: message } : message;
        return app.client.chat.postMessage({
          channel: job.context.channelId,
          thread_ts: job.context.threadTs,
          ...payload
        } as never);
      };
      void enqueueThread(job.context, () => runInvestigation({
        jobId: job.id,
        question: job.question,
        context: job.context,
        pipeline,
        publicReply,
        updatePublicStatus: (messageTs, text) => app.client.chat.update({ channel: job.context.channelId, ts: messageTs, text })
      }));
    }
    for (const job of listExpiredCapacityJobs()) {
      updateInvestigationJob(job.id, "failed");
      void app.client.chat.postMessage({
        channel: job.context.channelId,
        thread_ts: job.context.threadTs,
        text: "Language-model capacity did not recover within one hour, so I closed this saved investigation. Ask again when capacity is available."
      });
    }
  }, 30_000).unref();
  return app;
}
