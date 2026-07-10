import type { AgentToolProvider } from "../agent/toolProvider.js";
import { signOAuthState } from "../auth/githubOAuth.js";
import { getGitHubToken, getServiceToken, type ServiceToken } from "../auth/tokenStore.js";
import { StravaToolProvider } from "./stravaTools.js";

/**
 * The one place a product's name is allowed to appear in this codebase. Everything else —
 * intent routing, the connect flow, OAuth routes, the investigation pipeline — works off this
 * registry's rows, so adding a service is adding data here, never adding control flow anywhere.
 * The LLM intent router decides WHICH row a message refers to; nothing keyword-matches product
 * names outside of resolving against these rows' aliases.
 */

export interface ServiceOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
  /** Extra provider-required query params for the authorize redirect. */
  extraAuthParams?: Record<string, string>;
  /**
   * Translates the provider's token-endpoint response (authorization_code and refresh_token
   * grants alike) into the service-agnostic ServiceToken. This is the only code that knows the
   * provider's response shape.
   */
  parseTokenResponse: (payload: Record<string, unknown>) => Omit<ServiceToken, "connectedAt"> | null;
}

export interface ServiceDefinition {
  id: string;
  label: string;
  /** Names and hostname fragments a user might call this service ("strava", "strava.com"). */
  aliases: string[];
  /** What kind of data lives here — read by the agent to judge which sources fit a question. */
  domain: string;
  /** Generic OAuth config; omit for services with a bespoke connect flow (GitHub's App install). */
  oauth?: ServiceOAuthConfig;
  /** Tools this service contributes to an investigation for a user who connected it. */
  createToolProvider?: (token: ServiceToken) => AgentToolProvider;
  /** Bespoke connect link builder (used instead of the generic /auth/services/:id route). */
  connectUrl?: (slackUserId: string, env: NodeJS.ProcessEnv) => string | null;
  isConfigured: (env: NodeJS.ProcessEnv) => boolean;
  /** Bespoke connected-check for services with a legacy token store; default is the service token store. */
  isConnected?: (slackUserId: string) => boolean;
}

export function isServiceConnected(service: ServiceDefinition, slackUserId: string): boolean {
  if (service.isConnected) return service.isConnected(slackUserId);
  return Boolean(getServiceToken(service.id, slackUserId));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export const serviceRegistry: ServiceDefinition[] = [
  {
    id: "github",
    label: "GitHub",
    aliases: ["github", "github.com", "gh"],
    domain: "code repositories, commits and their diffs, files, issues, and pull requests",
    // GitHub keeps its bespoke App-install flow (repo picker + revocation UI) from
    // src/auth/githubOAuth.ts; its tools are the investigator's native GitHub tools.
    connectUrl: (slackUserId, env) => {
      const base = env.PUBLIC_BASE_URL;
      if (!base) return null;
      return `${base}/auth/github?state=${encodeURIComponent(signOAuthState(slackUserId, env))}`;
    },
    isConfigured: (env) => Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET && env.PUBLIC_BASE_URL),
    isConnected: (slackUserId) => Boolean(getGitHubToken(slackUserId))
  },
  {
    id: "strava",
    label: "Strava",
    aliases: ["strava", "strava.com"],
    domain: "the user's own workouts: runs, rides, swims, distances, pace, and training stats",
    oauth: {
      authorizeUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      clientIdEnv: "STRAVA_CLIENT_ID",
      clientSecretEnv: "STRAVA_CLIENT_SECRET",
      scope: "read,activity:read",
      extraAuthParams: { approval_prompt: "auto" },
      parseTokenResponse: (payload) => {
        const token = asString(payload.access_token);
        if (!token) return null;
        const athlete = payload.athlete as { id?: number; firstname?: string; lastname?: string } | undefined;
        const expiresAtEpoch = asNumber(payload.expires_at);
        return {
          token,
          refreshToken: asString(payload.refresh_token),
          expiresAt: expiresAtEpoch ? new Date(expiresAtEpoch * 1000).toISOString() : undefined,
          accountId: athlete?.id ? String(athlete.id) : undefined,
          accountLabel: [athlete?.firstname, athlete?.lastname].filter(Boolean).join(" ") || undefined
        };
      }
    },
    createToolProvider: (token) => new StravaToolProvider(token),
    isConfigured: (env) => Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.PUBLIC_BASE_URL)
  }
];

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, "");
}

/**
 * Matches free text from the intent router — a service name in any phrasing, or a pasted URL
 * whose hostname belongs to a known service — against the registry. Deliberately fuzzy: the LLM
 * already decided the user wants to connect SOMETHING; this only pins down which row that is.
 */
export function resolveService(text: string): ServiceDefinition | undefined {
  const tokens = text.split(/\s+/).map(normalizeToken).filter(Boolean);
  const hostname = (() => {
    try {
      return new URL(text.trim()).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  return serviceRegistry.find((service) =>
    service.aliases.some((alias) => {
      const normalizedAlias = normalizeToken(alias);
      return tokens.includes(normalizedAlias) || (hostname !== undefined && hostname.includes(normalizedAlias.replace(/\.com$/, "")));
    })
  );
}

export function findService(id: string): ServiceDefinition | undefined {
  return serviceRegistry.find((service) => service.id === id);
}

/** One line per service, for "what can I connect?" replies and the intent router's context. */
export function describeServices(env: NodeJS.ProcessEnv = process.env): string {
  return serviceRegistry
    .map((service) =>
      `• \`${service.id}\` — ${service.label}: ${service.domain}${service.isConfigured(env) ? "" : " _(not configured on this deployment)_"}`
    )
    .join("\n");
}
