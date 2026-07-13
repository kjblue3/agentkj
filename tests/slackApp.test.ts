import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { investigationContext } from "../src/core/context.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";
import { connectionCatalog, handleConnectCommand, handleSlackIntent, isDirectPromptMessage, stripAgentMention } from "../src/slack/app.js";
import { closeStateDatabase } from "../src/state/database.js";
import { saveServiceSpec, setStoredServiceToken, setWorkspaceClientCredentials } from "../src/state/repositories.js";

const spec = dynamicServiceSpecSchema.parse({
  id: "records-service",
  label: "Records Service",
  aliases: ["records service"],
  domain: "documents and records",
  homepage: "https://records.example",
  apiHosts: ["records.example"],
  oauth: {
    authorizeUrl: "https://records.example/oauth/authorize",
    tokenUrl: "https://records.example/oauth/token",
    extraAuthParams: {}
  },
  setupInstructions: "Register a read-only application and use {CALLBACK_URL} as its callback URL.",
  tools: [{
    name: "list_records",
    description: "List records available to the authorized account.",
    method: "GET",
    urlTemplate: "https://records.example/api/records",
    params: []
  }]
});

beforeAll(() => {
  closeStateDatabase();
  process.env.NODE_ENV = "test";
  process.env.STATE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "agentkj-slack-")), "state.sqlite");
  process.env.PUBLIC_BASE_URL = "https://agent.example";
  process.env.OAUTH_STATE_SECRET = "test-state-secret";
  saveServiceSpec(spec);
  setWorkspaceClientCredentials({ workspaceId: "T1", serviceId: spec.id, clientId: "client", clientSecret: "secret", configuredBy: "UADMIN", expectedVersion: 0 });
  for (const userId of ["U1", "U2"]) {
    setStoredServiceToken("T1", userId, spec.id, {
      token: `token-${userId}`,
      scopes: ["records:read"],
      health: "ready",
      connectedAt: new Date().toISOString()
    });
  }
});

function context(userId: string) {
  return investigationContext({ workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId });
}

describe("Slack visibility and capability boundaries", () => {
  it("keeps connection listings private and scoped to the requester", async () => {
    const privateReply = vi.fn(async (_message: unknown) => undefined);
    const publicReply = vi.fn(async (_message: unknown) => undefined);
    await handleSlackIntent({
      text: "is mine connected?",
      context: context("U1"),
      pipeline: { investigate: vi.fn() } as never,
      privateReply,
      publicReply
    });
    expect(String(privateReply.mock.calls[0]?.[0])).toContain("Records Service");
    expect(String(privateReply.mock.calls[0]?.[0])).not.toContain("<@U2>");
    expect(publicReply).not.toHaveBeenCalled();
  });

  it("filters dynamic service connections by exact Slack owner", () => {
    expect(connectionCatalog("T1", ["U1"]).map((connection) => connection.ownerUserId)).toEqual(["U1"]);
    expect(connectionCatalog("T1", ["U2"]).map((connection) => connection.ownerUserId)).toEqual(["U2"]);
  });

  it("posts capability help publicly", async () => {
    const privateReply = vi.fn(async (_message: unknown) => undefined);
    const publicReply = vi.fn(async (_message: unknown) => undefined);
    await handleSlackIntent({ text: "help", context: context("U1"), pipeline: { investigate: vi.fn() } as never, privateReply, publicReply });
    expect(String(publicReply.mock.calls[0]?.[0])).toContain("read-only");
    expect(privateReply).not.toHaveBeenCalled();
  });

  it("does not pretend to execute a mutation request", async () => {
    const investigate = vi.fn();
    const publicReply = vi.fn(async (_message: unknown) => undefined);
    await handleSlackIntent({
      text: "implement these code changes",
      context: context("U1"),
      pipeline: { investigate } as never,
      privateReply: vi.fn(async (_message: unknown) => undefined),
      publicReply
    });
    expect(String(publicReply.mock.calls[0]?.[0])).toContain("started any external action");
    expect(investigate).not.toHaveBeenCalled();
  });

  it("recognizes an existing personal grant through /connect", async () => {
    const privateReply = vi.fn(async (_message: unknown) => undefined);
    await handleConnectCommand({
      text: "records-service",
      context: context("U1"),
      privateReply
    });
    expect(String(privateReply.mock.calls[0]?.[0])).toContain("already connected");
  });

  it("redirects legacy mention-based connection requests to /connect", async () => {
    const privateReply = vi.fn(async (_message: unknown) => undefined);
    await handleSlackIntent({
      text: "connect records-service",
      context: context("U1"),
      pipeline: { investigate: vi.fn() } as never,
      privateReply,
      publicReply: vi.fn(async (_message: unknown) => undefined)
    });
    expect(String(privateReply.mock.calls[0]?.[0])).toContain("/connect records-service");
  });

  it("removes only the agent mention so a named member remains identifiable", () => {
    expect(stripAgentMention("<@UBOT> compare my records with <@U2>"))
      .toBe("compare my records with <@U2>");
    expect(stripAgentMention("compare <@U2> with <@UBOT>", "UBOT"))
      .toBe("compare <@U2> with");
  });

  it("accepts human direct messages as prompts and ignores bot deliveries", () => {
    expect(isDirectPromptMessage({ channel_type: "im", user: "U1", text: "What changed?" })).toBe(true);
    expect(isDirectPromptMessage({ channel_type: "channel", user: "U1", text: "What changed?" })).toBe(false);
    expect(isDirectPromptMessage({ channel_type: "im", user: "UBOT", text: "Answer", bot_id: "B1" })).toBe(false);
  });
});
