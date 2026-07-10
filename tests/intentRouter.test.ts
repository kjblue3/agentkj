import { describe, expect, it } from "vitest";
import { classifyIntent, heuristicIntent } from "../src/slack/intentRouter.js";
import { resolveService } from "../src/services/registry.js";

describe("heuristicIntent (no-LLM fallback)", () => {
  it("routes connect phrasings to connect with the remainder as target", () => {
    expect(heuristicIntent("connect github")).toEqual({ kind: "connect", target: "github" });
    expect(heuristicIntent("connect to my strava")).toEqual({ kind: "connect", target: "to my strava" });
    expect(heuristicIntent("connect-github")).toEqual({ kind: "connect", target: "github" });
  });

  it("recognizes the bot-issued command shapes", () => {
    expect(heuristicIntent("connectors")).toEqual({ kind: "list_connectors" });
    expect(heuristicIntent("approve p-123 personal read-only").kind).toBe("approve");
    expect(heuristicIntent("share c-1 user U42").kind).toBe("share");
  });

  it("treats everything else as an investigation with no relevance signal", () => {
    expect(heuristicIntent("why did checkout latency spike?")).toEqual({ kind: "investigate" });
    expect(heuristicIntent("")).toEqual({ kind: "help" });
  });
});

describe("classifyIntent", () => {
  it("uses the heuristic when no LLM client is configured", async () => {
    const intent = await classifyIntent(
      "connect strava",
      { connected: ["slack"], connectableSummary: "" },
      null,
      "test-model"
    );
    expect(intent).toEqual({ kind: "connect", target: "strava" });
  });

  it("drops relevantSources ids the user has not actually connected", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({ kind: "investigate", relevantSources: ["strava", "github"] }) } }]
          })
        }
      }
    };
    const intent = await classifyIntent(
      "how many miles did I run this week?",
      { connected: ["strava", "slack"], connectableSummary: "" },
      client as never,
      "test-model"
    );
    expect(intent).toEqual({ kind: "investigate", relevantSources: ["strava"] });
  });

  it("falls back to the heuristic when the LLM call fails", async () => {
    const client = {
      chat: { completions: { create: async () => { throw new Error("boom"); } } }
    };
    const intent = await classifyIntent(
      "connect github",
      { connected: [], connectableSummary: "" },
      client as never,
      "test-model"
    );
    expect(intent).toEqual({ kind: "connect", target: "github" });
  });
});

describe("resolveService", () => {
  it("matches service names in any surrounding phrasing", () => {
    expect(resolveService("through github")?.id).toBe("github");
    expect(resolveService("my strava account")?.id).toBe("strava");
  });

  it("matches pasted URLs by hostname", () => {
    expect(resolveService("https://www.strava.com/athletes/113555702#interval")?.id).toBe("strava");
    expect(resolveService("https://remote-mcp.example/mcp")).toBeUndefined();
  });

  it("matches nothing for unknown services", () => {
    expect(resolveService("flurbo")).toBeUndefined();
  });
});
