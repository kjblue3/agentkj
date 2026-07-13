import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/server.js";

const app = createApi();

describe("HTTP API", () => {
  it("reports health", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "slack-detective" });
  });

  it("does not expose a context-free investigation endpoint", async () => {
    expect((await request(app).post("/investigate").send({ question: "What changed?" })).status).toBe(404);
    expect((await request(app).get("/evidence/record-id")).status).toBe(404);
  });
});
