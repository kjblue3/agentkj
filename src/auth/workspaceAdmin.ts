import { getSlackInstallationToken } from "../state/repositories.js";

interface SlackUser {
  id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_stranger?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  real_name?: string;
  name?: string;
}

const cache = new Map<string, { allowed: boolean; expiresAt: number }>();
const CACHE_MS = 5 * 60_000;

function tokenFor(workspaceId: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const stored = getSlackInstallationToken(workspaceId, env);
    if (stored) return stored.botToken;
  } catch {
    // Fail closed below if neither encrypted installation state nor a matching static token works.
  }
  const configuredWorkspace = env.SLACK_WORKSPACE_ID?.trim();
  if (configuredWorkspace && configuredWorkspace !== workspaceId) return undefined;
  return env.SLACK_BOT_TOKEN?.trim();
}

export function userHasWorkspaceAdministration(user: SlackUser | undefined): boolean {
  return Boolean(
    user?.id && !user.deleted && !user.is_bot && !user.is_app_user && !user.is_stranger &&
    (user.is_admin || user.is_owner || user.is_primary_owner)
  );
}

export async function isWorkspaceAdministrator(
  workspaceId: string,
  userId: string,
  options: { fresh?: boolean; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}
): Promise<boolean> {
  const key = `${workspaceId}:${userId}`;
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.allowed;
  const env = options.env ?? process.env;
  const token = tokenFor(workspaceId, env);
  if (!token) return false;
  try {
    const response = await (options.fetcher ?? fetch)(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const payload = await response.json() as { ok?: boolean; user?: SlackUser };
    const allowed = Boolean(payload.ok && userHasWorkspaceAdministration(payload.user));
    cache.set(key, { allowed, expiresAt: Date.now() + CACHE_MS });
    return allowed;
  } catch {
    return false;
  }
}

export async function listWorkspaceAdministrators(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<string[]> {
  const token = tokenFor(workspaceId, env);
  if (!token) return [];
  const admins: string[] = [];
  let cursor = "";
  try {
    do {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const response = await fetcher(`https://slack.com/api/users.list?${query}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const payload = await response.json() as {
        ok?: boolean; members?: SlackUser[]; response_metadata?: { next_cursor?: string };
      };
      if (!payload.ok) return [];
      admins.push(...(payload.members ?? []).filter(userHasWorkspaceAdministration).flatMap((user) => user.id ? [user.id] : []));
      cursor = payload.response_metadata?.next_cursor?.trim() ?? "";
    } while (cursor);
    return admins;
  } catch {
    return [];
  }
}

export function clearWorkspaceAdminCache(): void {
  cache.clear();
}
