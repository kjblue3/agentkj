import type { EvidenceItem } from "../types/schemas.js";
import { LocalConnector } from "./localConnector.js";
import { SlackConnector } from "./slackConnector.js";
import type { EvidenceConnector } from "./types.js";

export type ConnectorMode = "demo" | "real" | "hybrid";

export function createConnectors(items: EvidenceItem[], env: NodeJS.ProcessEnv = process.env): EvidenceConnector[] {
  const local = createLocalConnectors(items);
  if (connectorMode(env) === "demo") return local;
  const live = env.SLACK_BOT_TOKEN
    ? [new SlackConnector(env.SLACK_BOT_TOKEN, undefined, env.SLACK_USER_TOKEN)]
    : [];
  if (connectorMode(env) === "real") return live.length > 0 ? live : local;
  return [...live, ...local];
}

function createLocalConnectors(items: EvidenceItem[]): EvidenceConnector[] {
  const sources = [...new Set(items.map((item) => item.source))];
  return sources.map((source) => new LocalConnector(`Demo ${source}`, source, items));
}

export function connectorMode(env: NodeJS.ProcessEnv = process.env): ConnectorMode {
  return env.CONNECTOR_MODE === "real" || env.CONNECTOR_MODE === "hybrid" ? env.CONNECTOR_MODE : "demo";
}

export function effectiveConnectorMode(connectors: EvidenceConnector[], env: NodeJS.ProcessEnv = process.env): ConnectorMode {
  const mode = connectorMode(env);
  if (mode === "demo") return mode;
  return connectors.some((connector) => connector instanceof SlackConnector) ? mode : "demo";
}

export type { EvidenceConnector } from "./types.js";
