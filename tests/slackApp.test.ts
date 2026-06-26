import { describe, expect, it, vi } from "vitest";
import {
  FOLLOWUP_FALLBACK_MESSAGE,
  handleCreateFollowupAction
} from "../src/slack/app.js";

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
        private_metadata: "report-123"
      })
    }));
    expect(args.respond).not.toHaveBeenCalled();
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
