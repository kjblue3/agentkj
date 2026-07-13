import { SlackConnector } from "./slackConnector.js";
import type { EvidenceConnector } from "./types.js";

/**
 * Deployment-level evidence connectors. There is no bundled or demo data: without operator
 * Slack tokens the evidence store simply exposes no search tool, and investigations rely on
 * the per-user authorized connections alone.
 */
export function createConnectors(env: NodeJS.ProcessEnv = process.env): EvidenceConnector[] {
  return env.SLACK_BOT_TOKEN
    ? [new SlackConnector(env.SLACK_BOT_TOKEN, undefined, env.SLACK_USER_TOKEN)]
    : [];
}

export type { EvidenceConnector } from "./types.js";
