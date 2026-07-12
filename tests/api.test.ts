import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/server.js";
import { createConnectors } from "../src/connectors/index.js";
import { demoEvidence } from "../src/data/demoData.js";
import { InvestigationPipeline } from "../src/investigation/pipeline.js";
import { scriptedLlm } from "./fakeLlm.js";

const pipeline = new InvestigationPipeline(createConnectors(demoEvidence), { sourceMode: "demo" }, undefined, {}, scriptedLlm());
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
    expect(response.body.connectors).toContain("Demo slack");
    expect(response.body.timeline.length).toBeGreaterThan(2);
  });

  it("returns 503 instead of a templated answer when no language model is configured", async () => {
    const keyless = createApi(new InvestigationPipeline(createConnectors(demoEvidence), { sourceMode: "demo" }, undefined, {}, null));
    const response = await request(keyless)
      .post("/investigate")
      .send({ question: "Why did checkout latency spike?" });
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("language model");
  });

  it("returns evidence by id", async () => {
    const response = await request(app).get("/evidence/incident-checkout-1");
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("incident");
  });
});
