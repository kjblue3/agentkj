import "dotenv/config";
import { createServer } from "node:http";
import { createApi } from "./api/server.js";
import { createConnectors } from "./connectors/index.js";
import { InvestigationPipeline } from "./investigation/pipeline.js";
import { loadGlobalServerSpecs, McpToolRegistry } from "./mcp/registry.js";
import { createSlackApp } from "./slack/app.js";

export async function createApplication() {
  const connectors = createConnectors();
  const globalMcpRegistry = new McpToolRegistry(loadGlobalServerSpecs());
  const pipeline = new InvestigationPipeline(
    connectors,
    { connectors: connectors.map((connector) => connector.name) },
    globalMcpRegistry
  );
  return {
    api: createApi(pipeline),
    slack: createSlackApp(pipeline),
    pipeline
  };
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  const { api, slack } = await createApplication();
  const server = createServer(api);
  server.listen(port, host, () => {
    console.log(`Slack Detective API listening on http://${host}:${port}`);
    console.log(slack ? "Slack Socket Mode enabled." : "Slack credentials absent; running API-only mode.");
  });
  if (slack) await slack.start();
}

const entry = process.argv[1]?.replace(/\\/g, "/");
if (entry && import.meta.url.endsWith(entry.replace(/^.*?:\//, "/"))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
