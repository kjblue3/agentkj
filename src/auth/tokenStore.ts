/**
 * In-memory per-Slack-user credential store, mirroring the singleton-Map pattern in
 * src/slack/reportCache.ts. Hackathon-grade: lost on every process restart, no encryption.
 * A real deployment needs a real datastore (and secret encryption at rest) before this is
 * used with real user tokens.
 */

export interface GitHubUserToken {
  token: string;
  login: string;
  connectedAt: string;
}

const githubTokens = new Map<string, GitHubUserToken>();

export function setGitHubToken(slackUserId: string, value: GitHubUserToken): void {
  githubTokens.set(slackUserId, value);
}

export function getGitHubToken(slackUserId: string): GitHubUserToken | undefined {
  return githubTokens.get(slackUserId);
}

export function clearGitHubToken(slackUserId: string): void {
  githubTokens.delete(slackUserId);
}

/**
 * Part 3 (self-service MCP connectors): per-user set of connected catalog entries, e.g.
 * `{ "sheets": { ...credentials } }`. Kept alongside GitHub tokens so both live in one place
 * pending a real per-user datastore. See src/mcp/registry.ts for how these are consumed.
 */
export interface UserConnector {
  catalogId: string;
  label: string;
  credentials: Record<string, string>;
  connectedAt: string;
}

const userConnectors = new Map<string, Map<string, UserConnector>>();

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
