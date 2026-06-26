import "dotenv/config";
import { createServer } from "node:http";
import { createApi } from "./api/server.js";
import { createConnectors, effectiveConnectorMode } from "./connectors/index.js";
import { loadEvidence } from "./data/store.js";
import { InvestigationPipeline } from "./investigation/pipeline.js";
import { ReportSynthesizer } from "./openai/synthesizer.js";
import { createSlackApp } from "./slack/app.js";

export async function createApplication() {
  const evidence = await loadEvidence();
  const connectors = createConnectors(evidence);
  const pipeline = new InvestigationPipeline(
    connectors,
    new ReportSynthesizer(),
    {
      sourceMode: effectiveConnectorMode(connectors),
      connectors: connectors.map((connector) => connector.name)
    }
  );
  return {
    api: createApi(pipeline),
    slack: createSlackApp(pipeline),
    pipeline
  };
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const { api, slack } = await createApplication();
  const server = createServer(api);
  server.listen(port, () => {
    console.log(`Slack Detective API listening on http://localhost:${port}`);
    console.log(slack ? "Slack Socket Mode enabled." : "Slack credentials absent; running API-only demo mode.");
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
