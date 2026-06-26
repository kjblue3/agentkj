import type { EvidenceItem, EvidenceSource } from "../types/schemas.js";
import { GitHubConnector } from "./githubConnector.js";
import { GoogleDriveConnector } from "./googleDriveConnector.js";
import { IncidentConnector } from "./incidentConnector.js";
import { JiraConnector } from "./jiraConnector.js";
import { LocalConnector } from "./localConnector.js";
import { McpGitHubConnector } from "./mcpGitHubConnector.js";
import { SlackConnector } from "./slackConnector.js";
import type { EvidenceConnector } from "./types.js";
import { warnMissingConnector } from "./connectorUtils.js";

const labels: Record<EvidenceSource, string> = {
  slack: "Slack messages",
  github: "GitHub",
  jira: "Jira",
  docs: "Google Docs",
  incident: "Incident reports"
};

export type ConnectorMode = "demo" | "real" | "hybrid";

export function createConnectors(
  items: EvidenceItem[],
  env: NodeJS.ProcessEnv = process.env
): EvidenceConnector[] {
  const mode = connectorMode(env);
  if (mode === "demo") return createLocalConnectors(items);

  const realConnectors = createRealConnectors(env);
  if (mode === "real") {
    if (realConnectors.length > 0) return realConnectors;
    console.warn("CONNECTOR_MODE=real but no real connectors are configured; falling back to demo evidence.");
    return createLocalConnectors(items);
  }

  return [...realConnectors, ...createLocalConnectors(items)];
}

function createLocalConnectors(items: EvidenceItem[]): EvidenceConnector[] {
  return (Object.keys(labels) as EvidenceSource[]).map(
    (source) => new LocalConnector(labels[source], source, items)
  );
}

function createRealConnectors(env: NodeJS.ProcessEnv): EvidenceConnector[] {
  const connectors: EvidenceConnector[] = [];

  if (env.SLACK_BOT_TOKEN) {
    connectors.push(new SlackConnector(env.SLACK_BOT_TOKEN));
  } else {
    warnMissingConnector("Slack", ["SLACK_BOT_TOKEN"]);
  }

  const githubRepos = splitList(env.GITHUB_REPOS);
  const githubDemoRepo = env.GITHUB_DEMO_REPO?.trim();
  const githubMcpConfigured = env.MCP_GITHUB_ENABLED === "true"
    && Boolean(env.GITHUB_OWNER)
    && Boolean(githubDemoRepo || githubRepos[0])
    && Boolean(env.MCP_GITHUB_COMMAND);
  if (env.MCP_GITHUB_ENABLED === "true" && env.GITHUB_OWNER && (githubDemoRepo || githubRepos[0]) && env.MCP_GITHUB_COMMAND) {
    connectors.push(new McpGitHubConnector({
      owner: env.GITHUB_OWNER,
      repo: githubDemoRepo || githubRepos[0]!,
      command: env.MCP_GITHUB_COMMAND,
      toolNames: {
        searchIssues: env.MCP_GITHUB_SEARCH_ISSUES_TOOL,
        searchCode: env.MCP_GITHUB_SEARCH_CODE_TOOL,
        getIssue: env.MCP_GITHUB_GET_ISSUE_TOOL,
        getPullRequest: env.MCP_GITHUB_GET_PULL_REQUEST_TOOL,
        getFileContents: env.MCP_GITHUB_GET_FILE_TOOL
      }
    }));
  } else if (env.MCP_GITHUB_ENABLED === "true") {
    warnMissingConnector("GitHub MCP", ["GITHUB_OWNER", "GITHUB_DEMO_REPO or GITHUB_REPOS", "MCP_GITHUB_COMMAND"]);
  }

  if (!githubMcpConfigured && env.GITHUB_TOKEN && env.GITHUB_OWNER && githubRepos.length > 0) {
    connectors.push(new GitHubConnector(env.GITHUB_TOKEN, env.GITHUB_OWNER, githubRepos));
  } else if (!githubMcpConfigured) {
    warnMissingConnector("GitHub", ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPOS"]);
  }

  const jiraProjects = splitList(env.JIRA_PROJECTS);
  if (env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    connectors.push(new JiraConnector(env.JIRA_BASE_URL, env.JIRA_EMAIL, env.JIRA_API_TOKEN, jiraProjects));
  } else {
    warnMissingConnector("Jira", ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]);
  }

  const driveFolders = splitList(env.GOOGLE_DRIVE_FOLDER_IDS);
  if (env.GOOGLE_ACCESS_TOKEN) {
    connectors.push(new GoogleDriveConnector({ accessToken: env.GOOGLE_ACCESS_TOKEN }, driveFolders));
  } else if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    connectors.push(new GoogleDriveConnector({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON }, driveFolders));
  } else if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    connectors.push(new GoogleDriveConnector({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN
    }, driveFolders));
  } else {
    warnMissingConnector("Google Drive", [
      "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_ACCESS_TOKEN or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN"
    ]);
  }

  if (env.INCIDENT_API_URL || env.INCIDENT_DATA_PATH) {
    connectors.push(new IncidentConnector({
      apiUrl: env.INCIDENT_API_URL,
      apiToken: env.INCIDENT_API_TOKEN,
      jsonPath: env.INCIDENT_DATA_PATH
    }));
  } else {
    warnMissingConnector("Incident", ["INCIDENT_API_URL or INCIDENT_DATA_PATH"]);
  }

  return connectors;
}

export function connectorMode(env: NodeJS.ProcessEnv = process.env): ConnectorMode {
  return parseConnectorMode(env.CONNECTOR_MODE);
}

export function effectiveConnectorMode(
  connectors: EvidenceConnector[],
  env: NodeJS.ProcessEnv = process.env
): ConnectorMode {
  const requestedMode = connectorMode(env);
  if (requestedMode === "demo") return "demo";

  const localNames = new Set(Object.values(labels));
  const hasRealConnector = connectors.some((connector) => !localNames.has(connector.name));
  return hasRealConnector ? requestedMode : "demo";
}

function parseConnectorMode(value: string | undefined): ConnectorMode {
  if (value === "real" || value === "hybrid" || value === "demo") return value;
  return "demo";
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

export type { EvidenceConnector } from "./types.js";
