import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { investigationContext } from "../src/core/context.js";
import { closeStateDatabase } from "../src/state/database.js";
import { handleSlackIntent } from "../src/slack/app.js";

beforeAll(() => {
  closeStateDatabase();
  process.env.NODE_ENV = "test";
  process.env.STATE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "agentkj-slack-")), "state.sqlite");
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
});
