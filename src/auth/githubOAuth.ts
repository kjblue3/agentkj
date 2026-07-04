import type { Express } from "express";
import { GitHubRest } from "../github/githubRest.js";
import { setGitHubToken } from "./tokenStore.js";

/**
 * "Connect your GitHub" OAuth flow. Independent of Slack's Socket Mode connection — GitHub's
 * OAuth redirect needs a real public callback URL regardless of how Slack itself is wired, so
 * in local dev this route must be tunneled (e.g. `ngrok http $PORT`) and PUBLIC_BASE_URL set to
 * that tunnel URL, with the same URL registered as the GitHub OAuth App's callback.
 *
 * `state` carries the initiating Slack user id through the redirect round-trip so the callback
 * knows whose token this is — GitHub echoes `state` back unmodified, and it also functions as a
 * (light) CSRF guard against callbacks that weren't initiated by this app.
 */

export function registerGitHubOAuthRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const scopes = env.GITHUB_OAUTH_SCOPES ?? "repo";

  if (!clientId || !clientSecret || !baseUrl) {
    console.warn(
      "GitHub OAuth disabled; missing GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, or PUBLIC_BASE_URL."
    );
    return;
  }

  const redirectUri = `${baseUrl}/auth/github/callback`;

  app.get("/auth/github", (request, response) => {
    const slackUserId = typeof request.query.state === "string" ? request.query.state : "";
    if (!slackUserId) {
      response.status(400).send("Missing state (Slack user id).");
      return;
    }
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scopes);
    authorizeUrl.searchParams.set("state", slackUserId);
    response.redirect(authorizeUrl.toString());
  });

  app.get("/auth/github/callback", async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const slackUserId = typeof request.query.state === "string" ? request.query.state : "";
    if (!code || !slackUserId) {
      response.status(400).send("Missing code or state.");
      return;
    }

    try {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri })
      });
      const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
      if (!tokenPayload.access_token) {
        console.warn("GitHub OAuth token exchange failed.", tokenPayload.error_description);
        response.status(502).send("GitHub did not return an access token. Please try connecting again.");
        return;
      }

      const github = new GitHubRest(tokenPayload.access_token);
      const user = await github.getAuthenticatedUser();
      if (!user?.login) {
        response.status(502).send("Could not read your GitHub account after authorizing.");
        return;
      }

      setGitHubToken(slackUserId, {
        token: tokenPayload.access_token,
        login: user.login,
        connectedAt: new Date().toISOString()
      });

      response.send(htmlConfirmation(user.login));
    } catch (error) {
      console.error("GitHub OAuth callback failed.", error);
      response.status(500).send("Something went wrong connecting your GitHub account.");
    }
  });
}

function htmlConfirmation(login: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h1>✅ Connected as ${escapeHtml(login)}</h1>
  <p>You can close this tab and go back to Slack — try <code>/detective</code> again.</p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
