import type { AgentToolProvider } from "../agent/toolProvider.js";
import {
  getStoredServiceToken,
  getWorkspaceClientCredentials,
  type StoredServiceToken
} from "../state/repositories.js";
import { dotPath, loadDynamicSpecs, type DynamicServiceSpec } from "./dynamicSpec.js";
import { DynamicToolProvider } from "./dynamicTools.js";

export interface ServiceOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scope?: string;
  extraAuthParams?: Record<string, string>;
  parseTokenResponse: (payload: Record<string, unknown>) => Omit<StoredServiceToken, "connectedAt" | "health" | "scopes"> | null;
}

export interface ServiceDefinition {
  id: string;
  label: string;
  aliases: string[];
  domain: string;
  oauth: ServiceOAuthConfig;
  createToolProvider: (token: StoredServiceToken, connectionId: string, ownerUserId: string) => AgentToolProvider;
  dynamicSpec: DynamicServiceSpec;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : undefined;
}

function emailFromIdToken(payload: Record<string, unknown>): string | undefined {
  const middle = asString(payload.id_token)?.split(".")[1];
  if (!middle) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(middle, "base64url").toString("utf8")) as Record<string, unknown>;
    return asString(claims.email) ?? asString(claims.name);
  } catch {
    return undefined;
  }
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
      parseTokenResponse: (payload) => {
        const token = asString(payload.access_token);
        if (!token) return null;
        const expiresIn = asFiniteNumber(payload.expires_in);
        const expiresAt = asFiniteNumber(payload.expires_at);
        return {
          token,
          refreshToken: asString(payload.refresh_token),
          expiresAt: expiresIn
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined,
          accountId: dotPath(payload, spec.oauth.accountIdPath),
          accountLabel: dotPath(payload, spec.oauth.accountLabelPath) ?? emailFromIdToken(payload)
        };
      }
    },
    createToolProvider: (token, connectionId, ownerUserId) =>
      new DynamicToolProvider(spec, token, connectionId, ownerUserId)
  };
}

export function allServices(): ServiceDefinition[] {
  return loadDynamicSpecs().map(materialize);
}

export function findService(id: string): ServiceDefinition | undefined {
  return allServices().find((service) => service.id === id);
}

export function isServiceConfigured(
  service: ServiceDefinition,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(env.PUBLIC_BASE_URL && getWorkspaceClientCredentials(workspaceId, service.id, env));
}

export function isServiceConnected(service: ServiceDefinition, workspaceId: string, userId: string): boolean {
  return getStoredServiceToken(workspaceId, userId, service.id)?.health === "ready";
}

export function oauthClientCreds(service: ServiceDefinition, workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  return getWorkspaceClientCredentials(workspaceId, service.id, env);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

export function resolveService(text: string): ServiceDefinition | undefined {
  const normalized = normalizeText(text);
  const hostname = (() => { try { return new URL(text.trim()).hostname.toLowerCase(); } catch { return undefined; } })();
  return allServices().find((service) => service.aliases.some((alias) => {
    const candidate = normalizeText(alias);
    if (hostname) return hostname.includes(candidate.replace(/com$/, ""));
    return normalized.includes(candidate) || (candidate.length >= 5 && editDistance(normalized, candidate) <= (candidate.length >= 10 ? 2 : 1));
  }));
}

export function describeServices(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  const services = allServices();
  if (services.length === 0) return "No integrations have been built yet; name a service to create one.";
  return services.map((service) =>
    `• \`${service.id}\` — ${service.label}: ${service.domain}${isServiceConfigured(service, workspaceId, env) ? "" : " _(needs workspace administrator setup)_"}`
  ).join("\n");
}
