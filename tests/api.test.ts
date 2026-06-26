import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/server.js";
import { createConnectors } from "../src/connectors/index.js";
import { demoEvidence } from "../src/data/demoData.js";
import { fallbackSynthesis } from "../src/investigation/fallbackSynthesis.js";
import { InvestigationPipeline } from "../src/investigation/pipeline.js";

const pipeline = new InvestigationPipeline(createConnectors(demoEvidence), {
  async synthesize(question, evidence, timeline) {
    return fallbackSynthesis(question, evidence, timeline);
  }
});
const app = createApi(pipeline);

describe("HTTP API", () => {
  it("reports health", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("investigates a question", async () => {
    const response = await request(app)
      .post("/investigate")
      .send({ question: "Why did checkout latency spike?" });
    expect(response.status).toBe(200);
    expect(response.body.sourceMode).toBe("demo");
    expect(response.body.connectors).toContain("Slack messages");
    expect(response.body.timeline.length).toBeGreaterThan(2);
  });

  it("returns evidence by id", async () => {
    const response = await request(app).get("/evidence/incident-checkout-1");
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("incident");
  });
});
