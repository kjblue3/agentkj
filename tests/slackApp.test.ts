import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { InvestigationResult } from "../src/types/schemas.js";
import { createUserConnectorCredentialIntent, setUserConnector } from "../src/auth/tokenStore.js";
import { executeConfirmedConnect, handleSlackIntent } from "../src/slack/app.js";

vi.mock("../src/auth/tokenStore.js", async () => {
  const userConnectors = new Map<string, Map<string, unknown>>();
  const githubToken = { token: "gh-token", login: "kjblu", connectedAt: "2026-07-07T00:00:00.000Z" };
  return {
    getValidGitHubToken: vi.fn(async (slackUserId: string) => (slackUserId === "U123" ? githubToken : undefined)),
    getGitHubToken: vi.fn((slackUserId: string) => (slackUserId === "U123" ? githubToken : undefined)),
    getServiceToken: vi.fn(() => undefined),
    setServiceToken: vi.fn(),
    clearServiceToken: vi.fn(),
    listConnectedServiceIds: vi.fn(() => []),
    listUserConnectors: vi.fn((slackUserId: string) => [...(userConnectors.get(slackUserId)?.values() ?? [])]),
    createUserConnectorCredentialIntent: vi.fn(() => "catalog-secret"),
    setUserConnector: vi.fn((slackUserId: string, connector: unknown) => {
      const existing = userConnectors.get(slackUserId) ?? new Map<string, unknown>();
      const catalogId = (connector as { catalogId: string }).catalogId;
      existing.set(catalogId, connector);
      userConnectors.set(slackUserId, existing);
    })
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

function report(): InvestigationResult {
  return {
    question: "Why is checkout slow?",
    shortAnswer: "The checkout loop regressed.",
    confidence: "high",
    likelyRootCause: "A recent commit added repeated tax rule reads.",
    timeline: [],
    evidence: [],
    openQuestions: [],
    recommendedActions: ["Add a query-count regression test for checkout."]
  };
}

/** Pulls the confirm-button value out of the Yes/No prompt the connect flow replies with. */
function confirmIdFrom(reply: Mock): string {
  const call = reply.mock.calls.find(([message]) => {
    const blocks = (message as { blocks?: Array<{ type: string }> }).blocks;
    return Array.isArray(blocks) && blocks.some((block) => block.type === "actions");
  });
  const blocks = (call![0] as { blocks: Array<{ type: string; elements?: Array<{ value?: string }> }> }).blocks;
  return blocks.find((block) => block.type === "actions")!.elements![0]!.value!;
}

async function confirmConnect(reply: Mock): Promise<Mock> {
  const confirmed = vi.fn().mockResolvedValue(undefined);
  await executeConfirmedConnect(confirmIdFrom(reply), "U123", confirmed);
  return confirmed;
}

describe("handleSlackIntent", () => {
  beforeEach(() => {
    // The GitHub registry row is only connectable when its OAuth app is configured.
    process.env.GITHUB_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-client-secret";
  });

  it("asks to confirm, then sends the GitHub connect link on Yes", async () => {
    process.env.PUBLIC_BASE_URL = "https://agentkj.example";
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connect github",
      userId: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      response_type: "ephemeral",
      text: expect.stringContaining("Connect *GitHub*?")
    }));

    const confirmed = await confirmConnect(reply);
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Connect your GitHub")
    }));
  });

  it.each([
    "connect through github",
    "connect to my github",
    "Connect GitHub please",
    "connect my github account",
    "connect-github"
  ])("routes %j to the GitHub confirmation", async (text) => {
    process.env.PUBLIC_BASE_URL = "https://agentkj.example";
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text,
      userId: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      response_type: "ephemeral",
      text: expect.stringContaining("Connect *GitHub*?")
    }));
  });

  it("confirms multiple targets in one message and connects each on Yes", async () => {
    process.env.PUBLIC_BASE_URL = "https://agentkj.example";
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connect github and flurbo",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Connect *GitHub* and *flurbo* (I'll build the integration)?")
    }));

    const confirmed = await confirmConnect(reply);
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Connect your GitHub")
    }));
    // No LLM is configured in tests, so the architect step reports the second target honestly.
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("can't synthesize new integrations right now")
    }));
  });

  it("refuses confirmation clicks from someone other than the requester", async () => {
    process.env.PUBLIC_BASE_URL = "https://agentkj.example";
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connect github",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });

    const outsider = vi.fn().mockResolvedValue(undefined);
    await executeConfirmedConnect(confirmIdFrom(reply), "U999", outsider);
    expect(outsider).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Only the person who asked")
    }));
  });

  it("lets app mentions list connectors", async () => {
    setUserConnector("U123", {
      catalogId: "filesystem",
      label: "Local filesystem (read-only)",
      credentials: { MCP_FS_ROOT: "C:\\Users\\kjblu\\Projects" },
      connectedAt: "2026-07-07T00:00:00.000Z"
    });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connectors",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      response_type: "ephemeral",
      text: expect.stringContaining("@agentkj connect <catalog-id>")
    }));
  });

  it("does not collect catalog connector credentials in Slack", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connect filesystem MCP_FS_ROOT=C:\\Users\\kjblu\\Projects",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });
    const confirmed = await confirmConnect(reply);

    expect(setUserConnector).not.toHaveBeenCalled();
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("I won't collect connector credentials in Slack")
    }));
  });

  it("opens a secure setup link for catalog connectors", async () => {
    process.env.PUBLIC_BASE_URL = "https://agentkj.example";
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "connect filesystem",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate: vi.fn() } as never,
      reply,
      postReport: vi.fn(),
      source: "mention"
    });
    const confirmed = await confirmConnect(reply);

    expect(createUserConnectorCredentialIntent).toHaveBeenCalledWith("U123", "filesystem");
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("/auth/catalog-connectors/catalog-secret")
    }));
  });

  it("lets app mentions run investigations with owner/repo scope", async () => {
    const investigate = vi.fn().mockResolvedValue(report());
    const reply = vi.fn().mockResolvedValue(undefined);
    const postReport = vi.fn().mockResolvedValue(undefined);

    await handleSlackIntent({
      text: "kjblu/casual-timeline why is the timeline off?",
      userId: "U123",
      channelId: "C123",
      pipeline: { investigate } as never,
      reply,
      postReport,
      source: "mention"
    });

    expect(investigate).toHaveBeenCalledWith("why is the timeline off?", expect.objectContaining({
      githubToken: "gh-token",
      githubLogin: "kjblu",
      owner: "kjblu",
      repo: "casual-timeline"
    }));
    expect(postReport).toHaveBeenCalledWith(
      "The checkout loop regressed.",
      expect.any(Array)
    );
  });
});
