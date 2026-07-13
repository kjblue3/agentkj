import { getSlackInstallationToken } from "../state/repositories.js";

async function slackApi(token: string, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await response.json() as Record<string, unknown>;
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

/**
 * Direct-messages a workspace member from outside any Bolt handler — the OAuth web routes use
 * this to hand the user their next step instead of making them re-ask the bot in Slack.
 */
export async function directMessageUser(workspaceId: string, userId: string, text: string): Promise<boolean> {
  const installation = getSlackInstallationToken(workspaceId);
  if (!installation) return false;
  const opened = await slackApi(installation.botToken, "conversations.open", { users: userId });
  const channelId = (opened?.channel as { id?: string } | undefined)?.id;
  if (!channelId) return false;
  return Boolean(await slackApi(installation.botToken, "chat.postMessage", { channel: channelId, text }));
}
