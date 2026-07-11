import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFilePath } from "../config/state.js";
import { safeFetch } from "../security/publicUrl.js";

/**
 * OAuth for remote MCP servers — the zero-setup connect path. Spec-compliant MCP servers
 * advertise their authorization server via RFC 9728 protected-resource metadata (or host RFC
 * 8414 metadata directly) and support RFC 7591 dynamic client registration, so this bot
 * registers ITSELF as an OAuth client programmatically: no human creates an app anywhere.
 * PKCE (S256) carries the security normally provided by a client secret.
 *
 * All discovery/registration traffic goes through safeFetch, keeping the SSRF protections that
 * govern every other remote-MCP request.
 */

export interface AuthServerMeta {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await safeFetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metadataToMeta(payload: Record<string, unknown> | null): AuthServerMeta | null {
  if (!payload) return null;
  const authorizationEndpoint = typeof payload.authorization_endpoint === "string" ? payload.authorization_endpoint : undefined;
  const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint : undefined;
  if (!authorizationEndpoint?.startsWith("https://") || !tokenEndpoint?.startsWith("https://")) return null;
  return {
    issuer: typeof payload.issuer === "string" ? payload.issuer : new URL(authorizationEndpoint).origin,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof payload.registration_endpoint === "string" && payload.registration_endpoint.startsWith("https://")
        ? payload.registration_endpoint
        : undefined,
    scopesSupported: Array.isArray(payload.scopes_supported)
      ? payload.scopes_supported.filter((scope): scope is string => typeof scope === "string")
      : undefined
  };
}

/** RFC 8414 well-known URL variants for an issuer that may include a path component. */
function wellKnownUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const trimmedPath = url.pathname.replace(/\/$/, "");
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${trimmedPath}`,
    `${url.origin}/.well-known/openid-configuration${trimmedPath}`
  ];
  if (trimmedPath) {
    urls.push(`${url.origin}${trimmedPath}/.well-known/oauth-authorization-server`);
    urls.push(`${url.origin}/.well-known/oauth-authorization-server`);
  }
  return urls;
}

/**
 * Finds the authorization server for an MCP endpoint: protected-resource metadata first
 * (RFC 9728, the current MCP spec's path), then RFC 8414 metadata on the MCP origin itself
 * (how earlier MCP drafts hosted it).
 */
export async function discoverAuthServer(mcpUrl: string): Promise<AuthServerMeta | null> {
  const mcp = new URL(mcpUrl);
  const trimmedPath = mcp.pathname.replace(/\/$/, "");
  const resourceMetadata =
    (await fetchJson(`${mcp.origin}/.well-known/oauth-protected-resource${trimmedPath}`)) ??
    (await fetchJson(`${mcp.origin}/.well-known/oauth-protected-resource`));
  const advertised = Array.isArray(resourceMetadata?.authorization_servers)
    ? resourceMetadata.authorization_servers.filter((value): value is string => typeof value === "string")
    : [];

  for (const issuer of [...advertised, mcp.origin]) {
    for (const candidate of wellKnownUrls(issuer)) {
      const meta = metadataToMeta(await fetchJson(candidate));
      if (meta) return meta;
    }
  }
  return null;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

const CLIENT_STORE_PATH = stateFilePath("mcpOAuthClients.local.json");

function loadClientStore(): Record<string, RegisteredClient> {
  try {
    if (existsSync(CLIENT_STORE_PATH)) return JSON.parse(readFileSync(CLIENT_STORE_PATH, "utf8")) as Record<string, RegisteredClient>;
  } catch {
    // fall through to empty
  }
  return {};
}

const clientStore = new Map<string, RegisteredClient>(Object.entries(loadClientStore()));

function saveClientStore(): void {
  try {
    mkdirSync(path.dirname(CLIENT_STORE_PATH), { recursive: true });
    writeFileSync(CLIENT_STORE_PATH, JSON.stringify(Object.fromEntries(clientStore), null, 2), { mode: 0o600 });
  } catch {
    console.warn("MCP OAuth client registrations could not be persisted.");
  }
}

/**
 * Registers this bot with the authorization server (RFC 7591), once per server — the
 * registration is cached so every later user of the same server reuses the same client id.
 */
export async function ensureClientRegistration(
  meta: AuthServerMeta,
  redirectUri: string
): Promise<RegisteredClient | null> {
  const cacheKey = `${meta.issuer}|${redirectUri}`;
  const cached = clientStore.get(cacheKey);
  if (cached) return cached;
  if (!meta.registrationEndpoint) return null;

  try {
    const response = await safeFetch(meta.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "agentkj (Slack investigation agent)",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    });
    if (!response.ok) {
      console.warn(`MCP dynamic client registration failed with HTTP ${response.status}.`);
      return null;
    }
    const payload = (await response.json()) as { client_id?: string; client_secret?: string };
    if (!payload.client_id) return null;
    const registered: RegisteredClient = { clientId: payload.client_id, clientSecret: payload.client_secret };
    clientStore.set(cacheKey, registered);
    saveClientStore();
    return registered;
  } catch (error) {
    console.warn("MCP dynamic client registration errored.", error);
    return null;
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
