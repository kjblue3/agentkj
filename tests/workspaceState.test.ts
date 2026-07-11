import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { investigationContext } from "../src/core/context.js";
import { closeStateDatabase, stateDatabase } from "../src/state/database.js";
import {
  consumeOAuthIntent,
  consumeActionIntent,
  createActionIntent,
  createInvestigationJob,
  createOAuthIntent,
  getStoredServiceToken,
  getWorkspaceClientCredentials,
  listDueCapacityJobs,
  listWorkspaceTokens,
  saveServiceSpec,
  setStoredServiceToken,
  setWorkspaceClientCredentials,
  updateInvestigationJob
} from "../src/state/repositories.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";
import { createServiceSetupIntent, registerServiceSetupRoutes } from "../src/auth/serviceSetup.js";
import { userHasWorkspaceAdministration } from "../src/auth/workspaceAdmin.js";

const directory = mkdtempSync(path.join(tmpdir(), "agentkj-state-"));
const databasePath = path.join(directory, "state.sqlite");
const env = {
  NODE_ENV: "test",
  STATE_DB_PATH: databasePath,
  STATE_ENCRYPTION_KEY: "test-encryption-key",
  PUBLIC_BASE_URL: "https://agent.example.test",
  OAUTH_STATE_SECRET: "test-state-secret"
} as NodeJS.ProcessEnv;

const spec = dynamicServiceSpecSchema.parse({
  id: "acme-records",
  label: "Acme Records",
  aliases: ["acme records"],
  domain: "workspace records, changes, and review history",
  homepage: "https://records.example.test",
  apiHosts: ["records.example.test"],
  oauth: {
    authorizeUrl: "https://records.example.test/oauth/authorize",
    tokenUrl: "https://records.example.test/oauth/token",
    scope: "records:read",
    extraAuthParams: {}
  },
  setupInstructions: "Register a read-only application and use {CALLBACK_URL} as its callback URL.",
  tools: [{ name: "search_records", description: "Search workspace records by query text.", method: "GET", urlTemplate: "https://records.example.test/api/search", params: [{ name: "q", description: "Search query", required: true, location: "query" }] }]
});

beforeAll(() => {
  closeStateDatabase();
  Object.assign(process.env, env);
  saveServiceSpec(spec);
});

describe("workspace transactional state", () => {
  it("isolates workspace OAuth configuration and encrypts secrets", () => {
    setWorkspaceClientCredentials({ workspaceId: "T1", serviceId: spec.id, clientId: "client", clientSecret: "super-secret", configuredBy: "UADMIN", expectedVersion: 0, env });
    expect(getWorkspaceClientCredentials("T1", spec.id, env)?.clientSecret).toBe("super-secret");
    expect(getWorkspaceClientCredentials("T2", spec.id, env)).toBeUndefined();
    expect(readFileSync(databasePath).includes(Buffer.from("super-secret"))).toBe(false);
    const provisioned = { ...env, ACME_RECORDS_CLIENT_ID: "env-client", ACME_RECORDS_CLIENT_SECRET: "env-secret" } as NodeJS.ProcessEnv;
    expect(getWorkspaceClientCredentials("T1", spec.id, provisioned)).toMatchObject({
      clientId: "env-client",
      clientSecret: "env-secret",
      source: "environment"
    });
  });

  it("keeps same-workspace member grants separate while listing both as eligible", () => {
    for (const userId of ["U1", "U2"]) {
      setStoredServiceToken("T1", userId, spec.id, { token: `token-${userId}`, scopes: ["records:read"], health: "ready", connectedAt: new Date().toISOString() }, env);
    }
    expect(listWorkspaceTokens("T1", env).map((value) => value.userId).sort()).toEqual(["U1", "U2"]);
    expect(getStoredServiceToken("T2", "U1", spec.id, env)).toBeUndefined();
  });

  it("consumes OAuth intents once", () => {
    const nonce = createOAuthIntent({ kind: "authorize", workspaceId: "T1", userId: "U1", serviceId: spec.id });
    expect(consumeOAuthIntent(nonce, "authorize")?.workspaceId).toBe("T1");
    expect(consumeOAuthIntent(nonce, "authorize")).toBeUndefined();
  });

  it("deduplicates investigation jobs by Slack request id", () => {
    const context = investigationContext({ requestId: "Ev1", workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1" });
    expect(createInvestigationJob(context, "question").id).toBe(createInvestigationJob(context, "question").id);
  });

  it("persists capacity waits for restart recovery", () => {
    const context = investigationContext({ requestId: "Ev-capacity", workspaceId: "T1", channelId: "C2", threadTs: "2.1", userId: "U2" });
    const job = createInvestigationJob(context, "question");
    updateInvestigationJob(job.id, "waiting_for_capacity", { retryAt: new Date(Date.now() - 1_000).toISOString() });
    expect(listDueCapacityJobs().map((value) => value.id)).toContain(job.id);
  });

  it("binds actions to one workspace thread and consumes them once", () => {
    const context = investigationContext({ requestId: "Ev-action", workspaceId: "T1", channelId: "C3", threadTs: "3.1", userId: "U1" });
    const job = createInvestigationJob(context, "question");
    const id = createActionIntent({ jobId: job.id, workspaceId: "T1", channelId: "C3", threadTs: "3.1", kind: "followup", payload: { action: "next" } });
    expect(consumeActionIntent(id, { workspaceId: "T1", channelId: "OTHER", threadTs: "3.1", kind: "followup" })).toBeUndefined();
    expect(consumeActionIntent(id, { workspaceId: "T1", channelId: "C3", threadTs: "3.1", kind: "followup" })?.payload).toEqual({ action: "next" });
    expect(consumeActionIntent(id, { workspaceId: "T1", channelId: "C3", threadTs: "3.1", kind: "followup" })).toBeUndefined();
  });
});

describe("workspace administrator setup", () => {
  it("recognizes administrator and owner powers but not guests or bots", () => {
    expect(userHasWorkspaceAdministration({ id: "U1", is_admin: true })).toBe(true);
    expect(userHasWorkspaceAdministration({ id: "U2", is_owner: true })).toBe(true);
    expect(userHasWorkspaceAdministration({ id: "U3", is_primary_owner: true })).toBe(true);
    expect(userHasWorkspaceAdministration({ id: "U4", is_admin: true, is_stranger: true })).toBe(false);
    expect(userHasWorkspaceAdministration({ id: "U5", is_admin: true, is_bot: true })).toBe(false);
  });

  it("refuses setup pages when live administrator verification fails", async () => {
    const app = express();
    registerServiceSetupRoutes(app, env, async () => false);
    const secret = createServiceSetupIntent(spec.id, "T1", "UNONADMIN");
    expect((await request(app).get(`/auth/service-setup/${secret}`)).status).toBe(404);
  });

  it("lets a verified administrator configure one workspace", async () => {
    const app = express();
    registerServiceSetupRoutes(app, env, async () => true);
    const secret = createServiceSetupIntent(spec.id, "T2", "UADMIN");
    expect((await request(app).get(`/auth/service-setup/${secret}`)).status).toBe(200);
    expect((await request(app).post(`/auth/service-setup/${secret}`).type("form").send({ clientId: "workspace-client", clientSecret: "workspace-secret" })).status).toBe(200);
    expect(getWorkspaceClientCredentials("T2", spec.id, env)?.clientId).toBe("workspace-client");
  });

  it("fails closed when administrator rights are revoked before submission", async () => {
    let checks = 0;
    const app = express();
    registerServiceSetupRoutes(app, env, async () => ++checks === 1);
    const secret = createServiceSetupIntent(spec.id, "T3", "UFORMERADMIN");
    expect((await request(app).get(`/auth/service-setup/${secret}`)).status).toBe(200);
    expect((await request(app).post(`/auth/service-setup/${secret}`).type("form").send({ clientId: "client", clientSecret: "secret" })).status).toBe(403);
    expect(getWorkspaceClientCredentials("T3", spec.id, env)).toBeUndefined();
  });
});
