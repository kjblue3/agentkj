import type { AgentToolProvider } from "../agent/toolProvider.js";
import { getClientCreds } from "../auth/deploymentCreds.js";
import { signOAuthState } from "../auth/githubOAuth.js";
import { getGitHubToken, getServiceToken, type ServiceToken } from "../auth/tokenStore.js";
import { dotPath, loadDynamicSpecs, type DynamicServiceSpec } from "./dynamicSpec.js";
import { DynamicToolProvider } from "./dynamicTools.js";

/**
 * Connectable services. There are deliberately no per-product rows here: services are
 * synthesized at runtime by the architect (src/services/architect.ts) when a user first asks to
 * connect one, and materialized from their persisted specs below. GitHub is the single
 * grandfathered built-in — its App-install flow (repo picker, revocation UI) and the
 * investigator's native tools predate the dynamic machinery; it should eventually migrate too.
 * Product names must never be hardcoded in this codebase.
 */

export interface ServiceOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scope?: string;
  /** Extra provider-required query params for the authorize redirect. */
  extraAuthParams?: Record<string, string>;
  /**
   * Translates the provider's token-endpoint response (authorization_code and refresh_token
   * grants alike) into the service-agnostic ServiceToken.
   */
  parseTokenResponse: (payload: Record<string, unknown>) => Omit<ServiceToken, "connectedAt"> | null;
}

export interface ServiceDefinition {
  id: string;
  label: string;
  /** Names and hostname fragments a user might call this service. */
  aliases: string[];
  /** What kind of data lives here — read by the agent to judge which sources fit a question. */
  domain: string;
  /** Generic OAuth config; omit for services with a bespoke connect flow. */
  oauth?: ServiceOAuthConfig;
  /** Tools this service contributes to an investigation for a user who connected it. */
  createToolProvider?: (token: ServiceToken) => AgentToolProvider;
  /** Bespoke connect link builder (used instead of the generic /auth/services/:id route). */
  connectUrl?: (slackUserId: string, env: NodeJS.ProcessEnv) => string | null;
  isConfigured: (env: NodeJS.ProcessEnv) => boolean;
  /** Bespoke connected-check for services with a legacy token store; default is the service token store. */
  isConnected?: (slackUserId: string) => boolean;
  /** Present on synthesized services: the spec that produced this definition. */
  dynamicSpec?: DynamicServiceSpec;
}

export function isServiceConnected(service: ServiceDefinition, slackUserId: string): boolean {
  if (service.isConnected) return service.isConnected(slackUserId);
  return Boolean(getServiceToken(service.id, slackUserId));
}

/** Client id/secret for a service's OAuth app: env override first, then the setup-form store. */
export function oauthClientCreds(
  service: ServiceDefinition,
  env: NodeJS.ProcessEnv = process.env
): { clientId: string; clientSecret: string } | undefined {
  return getClientCreds(service.id, env);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : undefined;
}

/** Best-effort account label from an OpenID id_token when the spec gave no explicit path. */
function emailFromIdToken(payload: Record<string, unknown>): string | undefined {
  const idToken = asString(payload.id_token);
  const middle = idToken?.split(".")[1];
  if (!middle) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(middle, "base64url").toString("utf8")) as Record<string, unknown>;
    return asString(claims.email) ?? asString(claims.name);
  } catch {
    return undefined;
  }
}

/**
 * Standard-OAuth2 token parsing for synthesized services: access_token, optional refresh_token,
 * expiry as either `expires_in` seconds or `expires_at` epoch seconds, and account identity via
 * the spec's dot-paths (or an id_token's email when present).
 */
function genericTokenParser(spec: DynamicServiceSpec) {
  return (payload: Record<string, unknown>): Omit<ServiceToken, "connectedAt"> | null => {
    const token = asString(payload.access_token);
    if (!token) return null;
    const expiresIn = asFiniteNumber(payload.expires_in);
    const expiresAt = asFiniteNumber(payload.expires_at);
    return {
      token,
      refreshToken: asString(payload.refresh_token),
      expiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : expiresAt
          ? new Date(expiresAt * 1000).toISOString()
          : undefined,
      accountId: dotPath(payload, spec.oauth.accountIdPath),
      accountLabel: dotPath(payload, spec.oauth.accountLabelPath) ?? emailFromIdToken(payload)
    };
  };
}

function materialize(spec: DynamicServiceSpec): ServiceDefinition {
  return {
    id: spec.id,
    label: spec.label,
    aliases: spec.aliases,
    domain: spec.domain,
    dynamicSpec: spec,
    oauth: {
      authorizeUrl: spec.oauth.authorizeUrl,
      tokenUrl: spec.oauth.tokenUrl,
      scope: spec.oauth.scope,
      extraAuthParams: spec.oauth.extraAuthParams,
      parseTokenResponse: genericTokenParser(spec)
    },
    createToolProvider: (token) => new DynamicToolProvider(spec, token),
    isConfigured: (env) => Boolean(getClientCreds(spec.id, env) && env.PUBLIC_BASE_URL)
  };
}

const githubService: ServiceDefinition = {
  id: "github",
  label: "GitHub",
  aliases: ["github", "github.com", "gh"],
  domain: "code repositories, commits and their diffs, files, issues, and pull requests",
  connectUrl: (slackUserId, env) => {
    const base = env.PUBLIC_BASE_URL;
    if (!base) return null;
    return `${base}/auth/github?state=${encodeURIComponent(signOAuthState(slackUserId, env))}`;
  },
  isConfigured: (env) => Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET && env.PUBLIC_BASE_URL),
  isConnected: (slackUserId) => Boolean(getGitHubToken(slackUserId))
};

/** All connectable services: the grandfathered built-in plus every synthesized one. */
export function allServices(): ServiceDefinition[] {
  return [githubService, ...loadDynamicSpecs().map(materialize)];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Plain two-row Levenshtein, only ever run on short normalized alias strings. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Tolerance scaled to alias length: "googlegocs" should find "googledocs", but "gh" must not fuzz. */
function withinTypoDistance(candidate: string, alias: string): boolean {
  if (alias.length < 5) return false;
  return editDistance(candidate, alias) <= (alias.length >= 10 ? 2 : 1);
}

/**
 * Matches free text from the intent router — a service name in any phrasing, or a pasted URL
 * whose hostname belongs to a known service — against the known services. Deliberately fuzzy:
 * the LLM already decided the user wants to connect SOMETHING; this only pins down which
 * service that is. URLs match by hostname ONLY, so a URL that merely mentions a service name in
 * its path can't be misrouted.
 */
export function resolveService(text: string): ServiceDefinition | undefined {
  const trimmed = text.trim();
  const hostname = (() => {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  const normalized = normalizeText(trimmed);

  const services = allServices();
  const exact = services.find((service) =>
    service.aliases.some((alias) => {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias) return false;
      if (hostname !== undefined) return hostname.includes(normalizedAlias.replace(/com$/, ""));
      return normalized.includes(normalizedAlias);
    })
  );
  if (exact || hostname !== undefined) return exact;

  // Typo pass: "google gocs" must find an existing google-docs integration rather than send the
  // architect off to build whatever product the mangled letters happen to resemble.
  return services.find((service) =>
    service.aliases.some((alias) => withinTypoDistance(normalized, normalizeText(alias)))
  );
}

export function findService(id: string): ServiceDefinition | undefined {
  return allServices().find((service) => service.id === id);
}

/** One line per service, for "what can I connect?" replies and the intent router's context. */
export function describeServices(env: NodeJS.ProcessEnv = process.env): string {
  const lines = allServices().map(
    (service) =>
      `• \`${service.id}\` — ${service.label}: ${service.domain}${service.isConfigured(env) ? "" : " _(needs one-time API credential setup)_"}`
  );
  lines.push("• …any other well-known service — name it and I'll build the integration on the spot.");
  return lines.join("\n");
}
