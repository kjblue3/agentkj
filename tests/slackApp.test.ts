import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { investigationContext } from "../src/core/context.js";
import { closeStateDatabase } from "../src/state/database.js";
import { handleSlackIntent } from "../src/slack/app.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";
import { saveServiceSpec, setStoredServiceToken, setWorkspaceClientCredentials } from "../src/state/repositories.js";

beforeAll(() => {
  closeStateDatabase();
  process.env.NODE_ENV = "test";
  process.env.STATE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "agentkj-slack-")), "state.sqlite");
  process.env.PUBLIC_BASE_URL = "https://agent.example.test";
  process.env.OAUTH_STATE_SECRET = "test-state-secret";
});

describe("Slack visibility", () => {
  it("keeps connector listings private", async () => {
    const privateReply = vi.fn(async () => undefined);
    const publicReply = vi.fn(async () => undefined);
    await handleSlackIntent({ text: "connectors", context: investigationContext({ workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1" }), pipeline: { investigate: vi.fn() } as never, privateReply, publicReply });
    expect(privateReply).toHaveBeenCalledOnce();
    expect(publicReply).not.toHaveBeenCalled();
  });
  it("posts normal help publicly", async () => {
    const privateReply = vi.fn(async () => undefined);
    const publicReply = vi.fn(async () => undefined);
    await handleSlackIntent({ text: "help", context: investigationContext({ workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U2" }), pipeline: { investigate: vi.fn() } as never, privateReply, publicReply });
    expect(publicReply).toHaveBeenCalledOnce();
    expect(privateReply).not.toHaveBeenCalled();
  });
  it("tells already-connected members so instead of re-sending the consent pitch", async () => {
    const spec = dynamicServiceSpecSchema.parse({
      id: "acme-conn",
      label: "Acme Conn",
      aliases: ["acme conn"],
      domain: "chat guilds, memberships, and message history",
      homepage: "https://conn.example.test",
      apiHosts: ["conn.example.test"],
      oauth: { authorizeUrl: "https://conn.example.test/oauth/authorize", tokenUrl: "https://conn.example.test/oauth/token", extraAuthParams: {} },
      setupInstructions: "Register a read-only application and use {CALLBACK_URL} as its callback URL.",
      tools: [{ name: "list_guilds", description: "List the guilds the authorized account belongs to.", method: "GET", urlTemplate: "https://conn.example.test/api/guilds", params: [] }]
    });
    saveServiceSpec(spec);
    setWorkspaceClientCredentials({ workspaceId: "T1", serviceId: spec.id, clientId: "client", clientSecret: "secret", configuredBy: "UADMIN", expectedVersion: 0 });
    setStoredServiceToken("T1", "U3", spec.id, { token: "token-U3", scopes: [], health: "ready", connectedAt: new Date().toISOString() });
    const privateReply = vi.fn(async () => undefined);
    const publicReply = vi.fn(async () => undefined);
    await handleSlackIntent({ text: "connect acme-conn", context: investigationContext({ workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U3" }), pipeline: { investigate: vi.fn() } as never, privateReply, publicReply });
    const message = String((privateReply.mock.calls[0] as unknown[] | undefined)?.[0]);
    expect(message).toContain("already connected");
    expect(message).not.toContain("Watch out");
    expect(publicReply).not.toHaveBeenCalled();
  });
});
