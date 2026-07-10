import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { GitHubRest } from "../github/githubRest.js";
import { setGitHubToken } from "./tokenStore.js";

/**
 * "Connect your GitHub" flow, backed by a GitHub App (not a classic OAuth App) so each user
 * picks — during installation, at github.com/settings/installations afterward — either all
 * repos or an individual allow-list, and can revoke/change it any time without touching this
 * app. Requires the App's "Request user authorization (OAuth) during installation" setting
 * enabled; the authorize/token endpoints are otherwise identical to a classic OAuth App's.
 * Independent of Slack's Socket Mode connection — GitHub's redirect needs a real public
 * callback URL regardless of how Slack itself is wired, so in local dev this route must be
 * tunneled and PUBLIC_BASE_URL set to that tunnel URL, with the same URL registered as the
 * GitHub App's callback.
 *
 * `state` carries the initiating Slack user id through the redirect round-trip so the callback
 * knows whose token this is — GitHub echoes `state` back unmodified. It is HMAC-signed with an
 * expiry (signOAuthState/verifyOAuthState below): a bare user id in `state` would let anyone who
 * knows a victim's Slack id (visible to every workspace member) complete the flow with their OWN
 * GitHub account bound to the victim's Slack identity, silently poisoning the victim's
 * investigations with the attacker's repos.
 */

const STATE_TTL_MS = 30 * 60_000;

/**
 * HMAC key for OAuth `state`, shared by every service's connect flow (every service alike).
 * OAUTH_STATE_SECRET decouples state signing from any one provider's credentials; the GitHub
 * client secret remains the fallback so existing deployments keep working unchanged.
 */
function stateSecret(env: NodeJS.ProcessEnv): string | undefined {
  return env.OAUTH_STATE_SECRET || env.GITHUB_OAUTH_CLIENT_SECRET;
}

export function signOAuthState(slackUserId: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = stateSecret(env);
  if (!secret) return slackUserId; // Without the secret the OAuth routes are disabled; nothing consumes this.
  const payload = `${slackUserId}.${Date.now() + STATE_TTL_MS}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Returns the Slack user id if the state is authentic and unexpired, else null. */
export function verifyOAuthState(state: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = stateSecret(env);
  const [slackUserId, expires, signature] = state.split(".");
  if (!secret || !slackUserId || !expires || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${slackUserId}.${expires}`).digest("base64url");
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return null;
  return slackUserId;
}

export function registerGitHubOAuthRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const appSlug = env.GITHUB_APP_SLUG;
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "");

  if (!clientId || !clientSecret || !baseUrl || !appSlug) {
    console.warn(
      "GitHub OAuth disabled; missing GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, GITHUB_APP_SLUG, or PUBLIC_BASE_URL."
    );
    return;
  }

  const redirectUri = `${baseUrl}/auth/github/callback`;

  app.get("/auth/github", (request, response) => {
    const state = typeof request.query.state === "string" ? request.query.state : "";
    if (!state || !verifyOAuthState(state, env)) {
      response.status(400).send("This connect link is invalid or has expired. Run `/detective connect github` in Slack to get a fresh one.");
      return;
    }
    // The plain /login/oauth/authorize endpoint only verifies identity for a GitHub App — it never
    // installs the app, so the resulting token can't see ANY repos (every API call 404s). The
    // /installations/new flow runs the repo picker (all repos or a hand-picked list) and, because
    // the App has "Request user authorization (OAuth) during installation" enabled, GitHub then
    // redirects to our callback with the usual code+state — so the token exchange below is unchanged.
    const installUrl = new URL(`https://github.com/apps/${appSlug}/installations/new`);
    installUrl.searchParams.set("state", state);
    response.redirect(installUrl.toString());
  });

  app.get("/auth/github/callback", async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const setupAction = typeof request.query.setup_action === "string" ? request.query.setup_action : "";
    const slackUserId = state ? verifyOAuthState(state, env) : null;

    if (!code) {
      // Reconfiguring an EXISTING installation (setup_action=update, or re-running the install
      // flow when already installed) redirects here without a code. Identity auth is instant
      // once installed, so bounce through the plain authorize endpoint to mint a fresh token
      // rather than dead-ending with an error.
      if (slackUserId) {
        const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("state", state);
        response.redirect(authorizeUrl.toString());
        return;
      }
      response
        .status(400)
        .send(
          setupAction
            ? "Installation updated, but this window lost track of your Slack user. Run `/detective connect github` in Slack to finish connecting."
            : "Missing code, or the connect link expired. Run `/detective connect github` in Slack to get a fresh one."
        );
      return;
    }
    if (!slackUserId) {
      response.status(400).send("This connect link is invalid or has expired. Run `/detective connect github` in Slack to get a fresh one.");
      return;
    }

    try {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri })
      });
      const tokenPayload = (await tokenResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
      };
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
        connectedAt: new Date().toISOString(),
        refreshToken: tokenPayload.refresh_token,
        expiresAt: tokenPayload.expires_in
          ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString()
          : undefined
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
  <p>Change or revoke which repos this can see any time at <a href="https://github.com/settings/installations">github.com/settings/installations</a>.</p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
