import type { Express } from "express";
import { randomBytes } from "node:crypto";
import { findService, isServiceConfigured, oauthClientCreds, type ServiceDefinition } from "../services/registry.js";
import {
  consumeOAuthIntent,
  createOAuthIntent,
  getStoredServiceToken,
  getWorkspaceClientCredentials,
  invalidateWorkspaceServiceConfig,
  setStoredServiceToken,
  type StoredServiceToken
} from "../state/repositories.js";
import { listWorkspaceAdministrators } from "./workspaceAdmin.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";
import { renderPage } from "./htmlPage.js";
import { directMessageUser } from "../slack/notify.js";

const refreshes = new Map<string, Promise<StoredServiceToken | undefined>>();

type TokenFields = Omit<StoredServiceToken, "connectedAt" | "health" | "scopes">;
type ExchangeResult = { token: TokenFields } | { deadClient: true } | { failed: true };

/**
 * "invalid_client"/"unauthorized_client" from a token endpoint means the client id/secret itself
 * is no longer accepted — the OAuth app was deleted or its secret rotated. That is distinct from
 * an expired user token, and it can't be fixed by re-authorizing; the workspace must redo setup.
 */
function isDeadClientError(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    const normalized = typeof code === "string" ? code.toLowerCase() : "";
    return normalized === "invalid_client" || normalized === "unauthorized_client";
  } catch {
    return /\b(?:invalid_client|unauthorized_client)\b/i.test(body);
  }
}

/**
 * The provider disowned this workspace's OAuth app. Reset the config so the next /connect restarts
 * setup, and DM every workspace admin a fresh setup link. Guarded so it fires once (invalidate
 * returns false after the first call) and never touches environment-provisioned credentials.
 */
async function handleDeadWorkspaceClient(
  service: ServiceDefinition,
  workspaceId: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const creds = getWorkspaceClientCredentials(workspaceId, service.id, env);
  if (!creds || creds.source !== "workspace") return;
  if (!invalidateWorkspaceServiceConfig(workspaceId, service.id, "provider_rejected_client", env)) return;
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const admins = await listWorkspaceAdministrators(workspaceId, env).catch(() => [] as string[]);
  for (const adminId of admins) {
    const link = base
      ? ` <${base}/auth/service-setup/${createOAuthIntent({ kind: "setup", serviceId: service.id, workspaceId, userId: adminId, expectedVersion: 0 })}|Redo the one-time setup here>.`
      : "";
    await directMessageUser(workspaceId, adminId,
      `Heads up — *${service.label}* stopped working. The provider rejected this workspace's OAuth app (it was deleted or its secret changed), so I've reset the connection. It needs a fresh one-time setup before anyone can use it again.${link}`
    ).catch(() => undefined);
  }
}

export function serviceConnectUrl(
  service: ServiceDefinition,
  workspaceId: string,
  userId: string,
  jobId?: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!base || !isServiceConfigured(service, workspaceId, env)) return null;
  const nonce = createOAuthIntent({ kind: "authorize", workspaceId, userId, serviceId: service.id, jobId });
  const state = signOAuthState({
    nonce, workspaceId, userId, serviceId: service.id, expiresAt: Date.now() + 15 * 60_000
  }, env);
  return `${base}/auth/services/${service.id}?state=${encodeURIComponent(state)}`;
}

async function exchangeToken(
  service: ServiceDefinition,
  workspaceId: string,
  params: Record<string, string>,
  env: NodeJS.ProcessEnv
): Promise<ExchangeResult> {
  const creds = oauthClientCreds(service, workspaceId, env);
  if (!creds) return { failed: true };
  const response = await fetch(service.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params })
  });
  const text = await response.text();
  if (!response.ok) {
    if (isDeadClientError(response.status, text)) return { deadClient: true };
    console.warn(`${service.label} token endpoint returned HTTP ${response.status}.`);
    return { failed: true };
  }
  try {
    const token = service.oauth.parseTokenResponse(JSON.parse(text) as Record<string, unknown>);
    return token ? { token } : { failed: true };
  } catch { return { failed: true }; }
}

export async function getValidServiceToken(
  service: ServiceDefinition,
  workspaceId: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<StoredServiceToken | undefined> {
  const key = `${workspaceId}:${userId}:${service.id}`;
  const existing = refreshes.get(key);
  if (existing) return existing;
  const operation = (async () => {
    const record = getStoredServiceToken(workspaceId, userId, service.id, env);
    if (!record || record.health !== "ready") return undefined;
    if (!record.expiresAt || new Date(record.expiresAt).getTime() - Date.now() > 5 * 60_000) return record;
    if (!record.refreshToken) return undefined;
    const refreshed = await exchangeToken(service, workspaceId, {
      grant_type: "refresh_token", refresh_token: record.refreshToken
    }, env);
    if ("deadClient" in refreshed) { await handleDeadWorkspaceClient(service, workspaceId, env); return undefined; }
    if (!("token" in refreshed)) return undefined;
    const merged: StoredServiceToken = {
      ...record, ...refreshed.token, refreshToken: refreshed.token.refreshToken ?? record.refreshToken,
      scopes: record.scopes, health: "ready"
    };
    setStoredServiceToken(workspaceId, userId, service.id, merged, env);
    return merged;
  })().finally(() => refreshes.delete(key));
  refreshes.set(key, operation);
  return operation;
}

export function registerServiceOAuthRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  app.get("/auth/services/:serviceId", (request, response) => {
    const service = findService(String(request.params.serviceId ?? ""));
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const payload = state ? verifyOAuthState(state, env) : null;
    if (!service || !payload || payload.serviceId !== service.id || !baseUrl ||
        !isServiceConfigured(service, payload.workspaceId, env)) {
      response.status(400).type("html").send(renderPage("Authorization link expired", "<p>This authorization link is invalid, expired, or no longer configured. Ask the bot for a fresh one in Slack.</p>"));
      return;
    }
    const creds = oauthClientCreds(service, payload.workspaceId, env)!;
    const authorizeUrl = new URL(service.oauth.authorizeUrl);
    authorizeUrl.searchParams.set("client_id", creds.clientId);
    authorizeUrl.searchParams.set("redirect_uri", `${baseUrl}/auth/services/${service.id}/callback`);
    authorizeUrl.searchParams.set("response_type", "code");
    if (service.oauth.scope) authorizeUrl.searchParams.set("scope", service.oauth.scope);
    for (const [key, value] of Object.entries(service.oauth.extraAuthParams ?? {})) authorizeUrl.searchParams.set(key, value);
    authorizeUrl.searchParams.set("state", state);
    response.redirect(authorizeUrl.toString());
  });

  app.get("/auth/services/:serviceId/callback", async (request, response) => {
    const service = findService(String(request.params.serviceId ?? ""));
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const payload = state ? verifyOAuthState(state, env) : null;
    const intent = payload ? consumeOAuthIntent(payload.nonce, "authorize") : undefined;
    if (!service || !payload || !intent || intent.workspaceId !== payload.workspaceId ||
        intent.userId !== payload.userId || intent.serviceId !== service.id || !code || !baseUrl) {
      response.status(400).type("html").send(renderPage("Authorization expired", "<p>This authorization callback is invalid or expired. Ask the bot for a fresh link in Slack.</p>"));
      return;
    }
    const parsed = await exchangeToken(service, payload.workspaceId, {
      grant_type: "authorization_code", code,
      redirect_uri: `${baseUrl}/auth/services/${service.id}/callback`
    }, env);
    if ("deadClient" in parsed) {
      await handleDeadWorkspaceClient(service, payload.workspaceId, env);
      response.status(400).type("html").send(renderPage("Setup needs redoing",
        `<p>This workspace's connection to ${escapeHtml(service.label)} is no longer valid — its OAuth app was removed or its credentials changed. I've reset it and messaged the workspace admins; ask an admin to run the one-time setup again from Slack.</p>`));
      return;
    }
    if (!("token" in parsed)) {
      response.status(502).type("html").send(renderPage("Authorization failed", "<p>The authorization server did not return a usable access token. Try again from Slack.</p>"));
      return;
    }
    setStoredServiceToken(payload.workspaceId, payload.userId, service.id, {
      ...parsed.token,
      scopes: service.oauth.scope?.split(/\s+/).filter(Boolean) ?? [],
      health: "ready",
      connectedAt: new Date().toISOString()
    }, env);
    response.type("html").send(renderPage("Connected", `<p>${escapeHtml(service.label)} is ready. Return to Slack and ask away.</p>`, { autoCloseSeconds: 5 }));
    void directMessageUser(payload.workspaceId, payload.userId,
      `Your *${service.label}* account is connected (read-only) and ready. Ask me anything that needs it — no need to run connect again.`);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
