import { describe, expect, it, vi } from "vitest";
import { cacheReport } from "../src/slack/reportCache.js";
import type { InvestigationResult } from "../src/types/schemas.js";
import { setUserConnector } from "../src/auth/tokenStore.js";
import {
  FOLLOWUP_FALLBACK_MESSAGE,
  handleCreateFollowupAction,
  handleFollowupSubmitAction,
  handleSlackIntent
} from "../src/slack/app.js";

vi.mock("../src/auth/tokenStore.js", async () => {
  const userConnectors = new Map<string, Map<string, unknown>>();
  return {
    getValidGitHubToken: vi.fn(async (slackUserId: string) =>
      slackUserId === "U123"
        ? { token: "gh-token", login: "kjblu", connectedAt: "2026-07-07T00:00:00.000Z" }
        : undefined
    ),
    listUserConnectors: vi.fn((slackUserId: string) => [...(userConnectors.get(slackUserId)?.values() ?? [])]),
    setUserConnector: vi.fn((slackUserId: string, connector: unknown) => {
      const existing = userConnectors.get(slackUserId) ?? new Map<string, unknown>();
      const catalogId = (connector as { catalogId: string }).catalogId;
      existing.set(catalogId, connector);
      userConnectors.set(slackUserId, existing);
    })
  };
});

function createArgs(overrides: {
  triggerId?: string;
  openRejects?: boolean;
} = {}) {
  const ack = vi.fn().mockResolvedValue(undefined);
  const respond = vi.fn().mockResolvedValue(undefined);
  const open = overrides.openRejects
    ? vi.fn().mockRejectedValue(new Error("expired_trigger_id"))
    : vi.fn().mockResolvedValue({ ok: true });

  return {
    ack,
    action: { action_id: "create_followup", value: "report-123" },
    body: {
      type: "block_actions",
      trigger_id: overrides.triggerId,
      user: { id: "U123" },
      team: { id: "T123" },
      channel: { id: "C123" },
      message: { ts: "1710000000.000000" },
      container: { type: "message", channel_id: "C123", message_ts: "1710000000.000000" }
    },
    client: { views: { open } },
    respond
  };
}

describe("handleCreateFollowupAction", () => {
  it("opens the modal when Slack includes a trigger_id", async () => {
    const args = createArgs({ triggerId: "trigger-123" });

    await handleCreateFollowupAction(args);

    expect(args.ack).toHaveBeenCalledOnce();
    expect(args.client.views.open).toHaveBeenCalledWith(expect.objectContaining({
      trigger_id: "trigger-123",
      view: expect.objectContaining({
        type: "modal",
        private_metadata: expect.stringContaining("report-123")
      })
    }));
    expect(args.respond).not.toHaveBeenCalled();
  });

  it("logs a summarized action payload without dumping the raw Slack body", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const args = createArgs({ triggerId: "trigger-123" });

    await handleCreateFollowupAction(args);

    expect(info).toHaveBeenCalledWith(
      "Slack create_followup action received",
      expect.objectContaining({
        actionId: "create_followup",
        reportId: "report-123",
        bodyType: "block_actions",
        userId: "U123",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1710000000.000000",
        hasTriggerId: true,
        hasResponseUrl: false
      })
    );
    expect(info.mock.calls[0]?.[1]).not.toHaveProperty("trigger_id");
    expect(info.mock.calls[0]?.[1]).not.toHaveProperty("message");

    info.mockRestore();
  });

  it("responds ephemerally when trigger_id is missing", async () => {
    const args = createArgs();

    await handleCreateFollowupAction(args);

    expect(args.client.views.open).not.toHaveBeenCalled();
    expect(args.respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      replace_original: false,
      text: FOLLOWUP_FALLBACK_MESSAGE
    });
  });

  it("responds ephemerally when opening the modal fails", async () => {
    const args = createArgs({ triggerId: "trigger-123", openRejects: true });

    await handleCreateFollowupAction(args);

    expect(args.client.views.open).toHaveBeenCalledOnce();
    expect(args.respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      replace_original: false,
      text: FOLLOWUP_FALLBACK_MESSAGE
    });
  });
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

describe("handleFollowupSubmitAction", () => {
  it("posts the submitted follow-up back to the report thread", async () => {
    const reportId = cacheReport(report());
    const ack = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn().mockResolvedValue({ ok: true });

    await handleFollowupSubmitAction({
      ack,
      client: { chat: { postMessage } },
      body: {
        view: {
          private_metadata: JSON.stringify({
            reportId,
            channelId: "C123",
            threadTs: "1710000000.000000"
          }),
          state: {
            values: {
              followup: {
                text: {
                  value: "Add a checkout regression test."
                }
              }
            }
          }
        }
      }
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: "Follow-up created: Add a checkout regression test."
    }));
  });
});

describe("handleSlackIntent", () => {
  it("lets app mentions show the GitHub connect link", async () => {
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
      text: expect.stringContaining("Connect your GitHub")
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

  it("lets app mentions connect a catalog connector", async () => {
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

    expect(setUserConnector).toHaveBeenCalledWith("U123", expect.objectContaining({
      catalogId: "filesystem",
      credentials: { MCP_FS_ROOT: "C:\\Users\\kjblu\\Projects" }
    }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Connected")
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
      "Detective Report: The checkout loop regressed.",
      expect.any(Array)
    );
  });
});
