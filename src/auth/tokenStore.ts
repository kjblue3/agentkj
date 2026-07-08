import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFilePath } from "../config/state.js";

/**
 * Per-Slack-user credential store, persisted to a gitignored local JSON file so `tsx watch`
 * restarts (which happen on every source edit) don't silently disconnect everyone — that was a
 * real failure mode during development: each code change wiped all GitHub connections and every
 * subsequent /detective quietly fell back to "connect your GitHub". Still hackathon-grade: no
 * encryption at rest, single-process only. A real deployment needs a real datastore.
 */

export interface GitHubUserToken {
  token: string;
  login: string;
  connectedAt: string;
  /** Present when the GitHub App has "Expire user authorization tokens" enabled (the default). */
  refreshToken?: string;
  /** ISO timestamp of when `token` stops working; absent means non-expiring. */
  expiresAt?: string;
}

const STORE_PATH = stateFilePath("userTokens.local.json");

interface PersistedStore {
  githubTokens: Record<string, GitHubUserToken>;
}

function loadStore(): PersistedStore {
  try {
    if (existsSync(STORE_PATH)) {
      return JSON.parse(readFileSync(STORE_PATH, "utf8")) as PersistedStore;
    }
  } catch (error) {
    console.warn("Token store unreadable; starting empty.", error);
  }
  return { githubTokens: {} };
}

function saveStore(): void {
  try {
    mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ githubTokens: Object.fromEntries(githubTokens) }, null, 2));
  } catch (error) {
    console.warn("Token store write failed; connections won't survive a restart.", error);
  }
}

const githubTokens = new Map<string, GitHubUserToken>(Object.entries(loadStore().githubTokens));

export function setGitHubToken(slackUserId: string, value: GitHubUserToken): void {
  githubTokens.set(slackUserId, value);
  saveStore();
}

export function getGitHubToken(slackUserId: string): GitHubUserToken | undefined {
  return githubTokens.get(slackUserId);
}

export function clearGitHubToken(slackUserId: string): void {
  githubTokens.delete(slackUserId);
  saveStore();
}

/**
 * Like getGitHubToken, but transparently refreshes an expired/expiring user-to-server token
 * using its refresh token (GitHub Apps expire these after 8h by default). Returns undefined if
 * the user never connected OR their token expired and can't be refreshed — callers treat both
 * as "not connected".
 */
export async function getValidGitHubToken(
  slackUserId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GitHubUserToken | undefined> {
  const record = githubTokens.get(slackUserId);
  if (!record) return undefined;
  if (!record.expiresAt) return record;

  const msLeft = new Date(record.expiresAt).getTime() - Date.now();
  if (msLeft > 5 * 60_000) return record;

  if (!record.refreshToken || !env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    console.warn(`GitHub token for ${slackUserId} expired and cannot be refreshed; clearing it.`);
    clearGitHubToken(slackUserId);
    return undefined;
  }

  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: record.refreshToken
      })
    });
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!payload.access_token) {
      console.warn(`GitHub token refresh failed for ${slackUserId}; clearing it.`, payload.error_description);
      clearGitHubToken(slackUserId);
      return undefined;
    }
    const refreshed: GitHubUserToken = {
      ...record,
      token: payload.access_token,
      refreshToken: payload.refresh_token ?? record.refreshToken,
      expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : undefined
    };
    setGitHubToken(slackUserId, refreshed);
    return refreshed;
  } catch (error) {
    console.warn(`GitHub token refresh errored for ${slackUserId}; using the stored token as-is.`, error);
    return record;
  }
}

/**
 * Part 3 (self-service MCP connectors): per-user set of connected catalog entries, e.g.
 * `{ "sheets": { ...credentials } }`. Kept alongside GitHub tokens so both live in one place
 * pending a real per-user datastore. See src/mcp/registry.ts for how these are consumed.
 * (Deliberately NOT persisted to disk: these are third-party setup values collected through a
 * backend form, and in-memory is the hackathon contract.)
 */
export interface UserConnector {
  catalogId: string;
  label: string;
  credentials: Record<string, string>;
  connectedAt: string;
}

const userConnectors = new Map<string, Map<string, UserConnector>>();
const userConnectorCredentialIntents = new Map<string, { slackUserId: string; catalogId: string; expiresAt: number }>();

export function setUserConnector(slackUserId: string, connector: UserConnector): void {
  const existing = userConnectors.get(slackUserId) ?? new Map<string, UserConnector>();
  existing.set(connector.catalogId, connector);
  userConnectors.set(slackUserId, existing);
}

export function listUserConnectors(slackUserId: string): UserConnector[] {
  return [...(userConnectors.get(slackUserId)?.values() ?? [])];
}

export function removeUserConnector(slackUserId: string, catalogId: string): void {
  userConnectors.get(slackUserId)?.delete(catalogId);
}

export function createUserConnectorCredentialIntent(slackUserId: string, catalogId: string): string {
  const secret = randomBytes(24).toString("base64url");
  userConnectorCredentialIntents.set(secret, {
    slackUserId,
    catalogId,
    expiresAt: Date.now() + 15 * 60_000
  });
  return secret;
}

export function getUserConnectorCredentialIntent(
  secret: string
): { slackUserId: string; catalogId: string } | undefined {
  const intent = userConnectorCredentialIntents.get(secret);
  if (!intent || intent.expiresAt < Date.now()) {
    userConnectorCredentialIntents.delete(secret);
    return undefined;
  }
  return { slackUserId: intent.slackUserId, catalogId: intent.catalogId };
}

export function consumeUserConnectorCredentialIntent(
  secret: string
): { slackUserId: string; catalogId: string } | undefined {
  const intent = getUserConnectorCredentialIntent(secret);
  if (intent) userConnectorCredentialIntents.delete(secret);
  return intent;
}
