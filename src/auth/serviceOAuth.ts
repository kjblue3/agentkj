import type { Express } from "express";
import { randomBytes } from "node:crypto";
import { findService, isServiceConfigured, oauthClientCreds, type ServiceDefinition } from "../services/registry.js";
import {
  consumeOAuthIntent,
  createOAuthIntent,
  getStoredServiceToken,
  setStoredServiceToken,
  type StoredServiceToken
} from "../state/repositories.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";
import { renderPage } from "./htmlPage.js";

const refreshes = new Map<string, Promise<StoredServiceToken | undefined>>();

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
): Promise<Omit<StoredServiceToken, "connectedAt" | "health" | "scopes"> | null> {
  const creds = oauthClientCreds(service, workspaceId, env);
  if (!creds) return null;
  const response = await fetch(service.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params })
  });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`${service.label} token endpoint returned HTTP ${response.status}.`);
    return null;
  }
  try { return service.oauth.parseTokenResponse(JSON.parse(text) as Record<string, unknown>); }
  catch { return null; }
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
    if (!refreshed) return undefined;
    const merged: StoredServiceToken = {
      ...record, ...refreshed, refreshToken: refreshed.refreshToken ?? record.refreshToken,
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
    if (!parsed) {
      response.status(502).type("html").send(renderPage("Authorization failed", "<p>The authorization server did not return a usable access token. Try again from Slack.</p>"));
      return;
    }
    setStoredServiceToken(payload.workspaceId, payload.userId, service.id, {
      ...parsed,
      scopes: service.oauth.scope?.split(/\s+/).filter(Boolean) ?? [],
      health: "ready",
      connectedAt: new Date().toISOString()
    }, env);
    response.type("html").send(renderPage("Connected", `<p>${escapeHtml(service.label)} is ready. Return to Slack and ask away.</p>`, { autoCloseSeconds: 5 }));
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
