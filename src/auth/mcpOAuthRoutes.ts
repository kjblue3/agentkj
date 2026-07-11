import { randomBytes } from "node:crypto";
import type { Express } from "express";
import { completeMcpOAuth, getConnection } from "../mcp/connections.js";
import { createPkce, discoverAuthServer, ensureClientRegistration } from "../mcp/mcpOAuth.js";

/**
 * Per-user OAuth login for remote MCP connections. The whole flow is machine-negotiated —
 * discovery + dynamic client registration + PKCE — so connecting an OAuth-gated MCP server
 * needs zero provider-side setup from anyone: the user just clicks the login link and approves
 * on the provider's own page.
 */

interface LoginSession {
  connectionId: string;
  slackUserId: string;
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  redirectUri: string;
  expiresAt: number;
}

const sessions = new Map<string, LoginSession>();

export async function createMcpLoginLink(
  connectionId: string,
  slackUserId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ url: string } | { error: string }> {
  const connection = getConnection(connectionId);
  if (!connection || connection.credentialKind !== "oauth") {
    return { error: "That connection doesn't exist or isn't an OAuth connector." };
  }
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return { error: "This deployment has no `PUBLIC_BASE_URL`, so OAuth logins can't round-trip." };

  const meta = await discoverAuthServer(connection.url);
  if (!meta) {
    return { error: `${connection.name} doesn't advertise an OAuth authorization server I can discover.` };
  }
  const redirectUri = `${baseUrl}/auth/mcp/callback`;
  const client = await ensureClientRegistration(meta, redirectUri);
  if (!client) {
    return {
      error:
        `${connection.name}'s authorization server doesn't support dynamic client registration, so I can't ` +
        "self-register. If the provider issues tokens manually, approve the connector with `bearer` instead."
    };
  }

  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString("base64url");
  sessions.set(state, {
    connectionId,
    slackUserId,
    verifier,
    tokenEndpoint: meta.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    resource: connection.url,
    redirectUri,
    expiresAt: Date.now() + 15 * 60_000
  });

  const authorize = new URL(meta.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  // RFC 8707 resource indicator — the MCP spec requires tokens be audience-bound to the server.
  authorize.searchParams.set("resource", connection.url);
  if (meta.scopesSupported && meta.scopesSupported.length > 0) {
    authorize.searchParams.set("scope", meta.scopesSupported.join(" "));
  }
  return { url: authorize.toString() };
}

export function registerMcpOAuthRoutes(app: Express): void {
  app.get("/auth/mcp/callback", async (request, response) => {
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const providerError = typeof request.query.error === "string" ? request.query.error : "";
    const session = sessions.get(state);
    sessions.delete(state);

    if (!session || session.expiresAt < Date.now()) {
      response.status(400).send(page("Login expired", "This login link is invalid or expired. Ask the bot for a fresh one in Slack."));
      return;
    }
    if (providerError || !code) {
      response.status(400).send(page("Login failed", `The provider reported: ${escapeHtml(providerError || "no authorization code")}.`));
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: session.redirectUri,
        client_id: session.clientId,
        code_verifier: session.verifier,
        resource: session.resource,
        ...(session.clientSecret ? { client_secret: session.clientSecret } : {})
      });
      const tokenResponse = await fetch(session.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body
      });
      const text = await tokenResponse.text();
      if (!tokenResponse.ok) {
        console.warn(`MCP OAuth token exchange failed with HTTP ${tokenResponse.status}: ${text.slice(0, 300)}`);
        response.status(502).send(page("Login failed", "The authorization server rejected the token exchange. Try again from Slack."));
        return;
      }
      const payload = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!payload.access_token) {
        response.status(502).send(page("Login failed", "The authorization server returned no access token."));
        return;
      }
      const connection = await completeMcpOAuth(session.connectionId, session.slackUserId, {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : undefined,
        tokenEndpoint: session.tokenEndpoint,
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        resource: session.resource
      });
      response.send(page(
        "Connected",
        `You're logged into ${escapeHtml(connection.name)} (${connection.tools.length} tool${connection.tools.length === 1 ? "" : "s"} available). ` +
          "Close this tab and ask the bot to use it in Slack."
      ));
    } catch (error) {
      console.error("MCP OAuth callback failed.", error);
      response.status(500).send(page("Login failed", "Something went wrong completing the login. Try again from Slack."));
    }
  });
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center;"><h1>${title}</h1><p>${message}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
