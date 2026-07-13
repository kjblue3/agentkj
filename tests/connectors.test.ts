import { describe, expect, it } from "vitest";
import { createConnectors } from "../src/connectors/index.js";
import { SlackConnector } from "../src/connectors/slackConnector.js";

describe("deployment connectors", () => {
  it("exposes no evidence connector without operator Slack tokens — there is no bundled data", () => {
    expect(createConnectors({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("exposes only the live Slack connector when tokens are configured", () => {
    const connectors = createConnectors({ SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv);
    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toBeInstanceOf(SlackConnector);
  });
});
