import type { Express } from "express";
import { findService, oauthClientCreds, type ServiceDefinition } from "../services/registry.js";
import { signOAuthState, verifyOAuthState } from "./githubOAuth.js";
import { clearServiceToken, getServiceToken, setServiceToken, type ServiceToken } from "./tokenStore.js";

/**
 * One OAuth implementation for every registry service that declares an `oauth` config —
 * authorize redirect, code exchange, and refresh are identical across providers; only the
 * endpoints, env var names, and response shape (handled by the row's parseTokenResponse)
 * differ. Adding a connectable product must never mean adding another copy of this flow.
 */

export function serviceConnectUrl(
  service: ServiceDefinition,
  slackUserId: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (service.connectUrl) return service.connectUrl(slackUserId, env);
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!service.oauth || !base || !service.isConfigured(env)) return null;
  return `${base}/auth/services/${service.id}?state=${encodeURIComponent(signOAuthState(slackUserId, env))}`;
}

async function exchangeToken(
  service: ServiceDefinition,
  params: Record<string, string>,
  env: NodeJS.ProcessEnv
): Promise<Omit<ServiceToken, "connectedAt"> | null> {
  const oauth = service.oauth!;
  const creds = oauthClientCreds(service, env);
  const body = new URLSearchParams({
    client_id: creds?.clientId ?? "",
    client_secret: creds?.clientSecret ?? "",
    ...params
  });
  const response = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    // Provider error bodies ({error, error_description}) are the only way to debug a failed
    // exchange; they never contain secrets, so log them.
    console.warn(`${service.label} token endpoint returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    return null;
  }
  try {
    const parsed = oauth.parseTokenResponse(JSON.parse(text) as Record<string, unknown>);
    if (!parsed) console.warn(`${service.label} token response had no access token: ${text.slice(0, 300)}`);
    return parsed;
  } catch {
    console.warn(`${service.label} token endpoint returned non-JSON: ${text.slice(0, 200)}`);
    return null;
  }
}

/**
 * Returns a usable token for this user+service, transparently refreshing an expiring one.
 * Undefined means "not connected" — callers offer the connect flow, never an error.
 */
export async function getValidServiceToken(
  service: ServiceDefinition,
  slackUserId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ServiceToken | undefined> {
  const record = getServiceToken(service.id, slackUserId);
  if (!record) return undefined;
  if (!record.expiresAt || new Date(record.expiresAt).getTime() - Date.now() > 5 * 60_000) return record;

  if (!record.refreshToken || !service.oauth) {
    console.warn(`${service.label} token for ${slackUserId} expired and cannot be refreshed; clearing it.`);
    clearServiceToken(service.id, slackUserId);
    return undefined;
  }
  try {
    const refreshed = await exchangeToken(
      service,
      { grant_type: "refresh_token", refresh_token: record.refreshToken },
      env
    );
    if (!refreshed) {
      clearServiceToken(service.id, slackUserId);
      return undefined;
    }
    const merged: ServiceToken = {
      ...record,
      ...refreshed,
      // Refresh responses usually omit account identity — and some providers omit the refresh
      // token itself on refresh grants; keep what the original connect stored in both cases.
      refreshToken: refreshed.refreshToken ?? record.refreshToken,
      accountId: refreshed.accountId ?? record.accountId,
      accountLabel: refreshed.accountLabel ?? record.accountLabel
    };
    setServiceToken(service.id, slackUserId, merged);
    return merged;
  } catch (error) {
    console.warn(`${service.label} token refresh errored for ${slackUserId}; using the stored token as-is.`, error);
    return record;
  }
}

export function registerServiceOAuthRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "");

  app.get("/auth/services/:serviceId", (request, response) => {
    const service = findService(String(request.params.serviceId ?? ""));
    const state = typeof request.query.state === "string" ? request.query.state : "";
    if (!service?.oauth || !service.isConfigured(env) || !baseUrl) {
      response.status(404).send("This service is not connectable on this deployment.");
      return;
    }
    if (!state || !verifyOAuthState(state, env)) {
      response.status(400).send(`This connect link is invalid or has expired. Ask the bot to connect ${service.label} again for a fresh one.`);
      return;
    }
    const authorizeUrl = new URL(service.oauth.authorizeUrl);
    authorizeUrl.searchParams.set("client_id", oauthClientCreds(service, env)?.clientId ?? "");
    authorizeUrl.searchParams.set("redirect_uri", `${baseUrl}/auth/services/${service.id}/callback`);
    authorizeUrl.searchParams.set("response_type", "code");
    if (service.oauth.scope) authorizeUrl.searchParams.set("scope", service.oauth.scope);
    for (const [key, value] of Object.entries(service.oauth.extraAuthParams ?? {})) {
      authorizeUrl.searchParams.set(key, value);
    }
    authorizeUrl.searchParams.set("state", state);
    response.redirect(authorizeUrl.toString());
  });

  app.get("/auth/services/:serviceId/callback", async (request, response) => {
    const service = findService(String(request.params.serviceId ?? ""));
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const slackUserId = state ? verifyOAuthState(state, env) : null;

    if (!service?.oauth || !service.isConfigured(env)) {
      response.status(404).send("This service is not connectable on this deployment.");
      return;
    }
    if (!code || !slackUserId) {
      response.status(400).send(`Missing code, or the connect link expired. Ask the bot to connect ${service.label} again for a fresh one.`);
      return;
    }

    try {
      // redirect_uri is REQUIRED in the code exchange when it was sent on the authorize redirect
      // (RFC 6749 §4.1.3). Some providers tolerate omitting it; strict ones reject the exchange.
      const parsed = await exchangeToken(
        service,
        { grant_type: "authorization_code", code, redirect_uri: `${baseUrl}/auth/services/${service.id}/callback` },
        env
      );
      if (!parsed) {
        response.status(502).send(`${service.label} did not return an access token. Please try connecting again.`);
        return;
      }
      setServiceToken(service.id, slackUserId, { ...parsed, connectedAt: new Date().toISOString() });
      response.send(htmlConfirmation(service.label, parsed.accountLabel));
    } catch (error) {
      console.error(`${service.label} OAuth callback failed.`, error);
      response.status(500).send(`Something went wrong connecting your ${service.label} account.`);
    }
  });
}

function htmlConfirmation(serviceLabel: string, accountLabel?: string): string {
  const who = accountLabel ? ` as ${escapeHtml(accountLabel)}` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h1>✅ ${escapeHtml(serviceLabel)} connected${who}</h1>
  <p>You can close this tab and go back to Slack — just ask your question.</p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
