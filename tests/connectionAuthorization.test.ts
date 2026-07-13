import { describe, expect, it } from "vitest";
import {
  connectionAuthorizationError,
  remoteConnectorEvidence,
  selectAuthorizedConnections,
  type RemoteConnection,
  type RemoteToolDefinition
} from "../src/mcp/connections.js";
import { evidenceItemSchema } from "../src/types/schemas.js";

const readTool: RemoteToolDefinition = {
  name: "search_pages",
  inputSchema: { type: "object", properties: {} },
  readOnlyHint: true,
  requiredScopes: ["pages:read"]
};

function connection(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    id: "conn",
    name: "records.example",
    url: "https://records.example/mcp",
    ownerSlackUserId: "UOWNER",
    workspaceId: "T1",
    allowedSlackUserIds: [],
    allowedSlackChannelIds: [],
    allowedToolNames: ["search_pages"],
    accessMode: "read-only",
    scope: "personal",
    providerScopes: ["pages:read"],
    tools: [readTool],
    active: true,
    approved: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("remote connection authorization", () => {
  it("normalizes arbitrary MCP output into citable evidence", () => {
    const item = remoteConnectorEvidence(
      connection({ id: "status-1", name: "status.example", url: "https://status.example/mcp" }),
      { name: "search_rows" },
      { rows: [{ project: "Project", status: "late" }] },
      new Date("2026-07-12T12:00:00.000Z")
    );
    expect(evidenceItemSchema.parse(item)).toEqual(item);
    expect(item.body).toContain("Project");
    expect(item.source).toBe("mcp:status.example");
  });

  it("orders personal, shared, then delegated credentials", () => {
    const personal = connection({ id: "personal", ownerSlackUserId: "U1" });
    const shared = connection({
      id: "shared",
      ownerSlackUserId: "U2",
      scope: "shared",
      allowedSlackChannelIds: ["C1"]
    });
    const delegated = connection({
      id: "delegated",
      ownerSlackUserId: "U3",
      allowedSlackUserIds: ["U1"]
    });

    expect(selectAuthorizedConnections(
      { userId: "U1", workspaceId: "T1", channelId: "C1" },
      [delegated, shared, personal]
    ).map(({ id }) => id)).toEqual(["personal", "shared", "delegated"]);
  });

  it("applies the prompt's owner scope after normal authorization", () => {
    const requester = connection({ id: "requester", ownerSlackUserId: "U1" });
    const teammate = connection({
      id: "teammate",
      ownerSlackUserId: "U2",
      scope: "shared",
      allowedSlackChannelIds: ["C1"]
    });
    expect(selectAuthorizedConnections(
      { userId: "U1", workspaceId: "T1", channelId: "C1", ownerUserIds: ["U1"] },
      [requester, teammate]
    ).map(({ id }) => id)).toEqual(["requester"]);
  });

  it("checks user, channel, tool, provider scope, and active approval", () => {
    const context = { userId: "UOTHER", workspaceId: "T1", channelId: "C1" };
    expect(connectionAuthorizationError(connection(), readTool, context)).toContain("not allowed");
    expect(connectionAuthorizationError(
      connection({ allowedSlackUserIds: ["UOTHER"], allowedToolNames: [] }),
      readTool,
      context
    )).toContain("tool is not allowed");
    expect(connectionAuthorizationError(
      connection({ allowedSlackUserIds: ["UOTHER"], providerScopes: [] }),
      readTool,
      context
    )).toContain("OAuth scope");
    expect(connectionAuthorizationError(
      connection({ allowedSlackUserIds: ["UOTHER"], active: false }),
      readTool,
      context
    )).toContain("not active");
  });

  it("prevents write-like tools on a read-only share", () => {
    const writeTool = { ...readTool, name: "create_page", readOnlyHint: false, requiredScopes: [] };
    const target = connection({
      scope: "shared",
      allowedSlackChannelIds: ["C1"],
      allowedToolNames: ["create_page"]
    });

    expect(connectionAuthorizationError(
      target,
      writeTool,
      { userId: "UOTHER", workspaceId: "T1", channelId: "C1" }
    )).toContain("read-only");
  });
});
