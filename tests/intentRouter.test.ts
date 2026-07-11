import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyIntent, heuristicIntent } from "../src/slack/intentRouter.js";

// Point STATE_DIR at a temp dir BEFORE importing the registry, and seed one synthesized
// integration (a fictional service) so resolution over dynamic specs is what's under test.
const stateDir = mkdtempSync(path.join(tmpdir(), "agentkj-intent-"));
process.env.STATE_DIR = stateDir;
const { resolveService } = await import("../src/services/registry.js");

const fictionalSpec = {
  id: "acmefit",
  label: "AcmeFit",
  aliases: ["acmefit", "acme fit", "acmefit.example"],
  domain: "the user's own workouts, distances, and training stats",
  homepage: "https://acmefit.example",
  apiHosts: ["acmefit.example", "api.acmefit.example"],
  oauth: {
    authorizeUrl: "https://acmefit.example/oauth/authorize",
    tokenUrl: "https://acmefit.example/oauth/token",
    scope: "read",
    extraAuthParams: {}
  },
  setupInstructions: "Create an API application in the AcmeFit developer settings and register {CALLBACK_URL}.",
  tools: [
    {
      name: "list_workouts",
      description: "List the connected user's recent workouts with distances.",
      method: "GET",
      urlTemplate: "https://api.acmefit.example/v1/workouts",
      params: []
    }
  ]
};

beforeAll(() => {
  writeFileSync(path.join(stateDir, "dynamicServices.local.json"), JSON.stringify({ acmefit: fictionalSpec }));
});

describe("heuristicIntent (no-LLM fallback)", () => {
  it("routes connect phrasings to connect with the remainder as targets", () => {
    expect(heuristicIntent("connect github")).toEqual({ kind: "connect", targets: ["github"] });
    expect(heuristicIntent("connect to my acmefit")).toEqual({ kind: "connect", targets: ["to my acmefit"] });
    expect(heuristicIntent("connect-github")).toEqual({ kind: "connect", targets: ["github"] });
  });

  it("splits multi-service connect requests into separate targets", () => {
    expect(heuristicIntent("connect github and acmefit")).toEqual({ kind: "connect", targets: ["github", "acmefit"] });
    expect(heuristicIntent("connect github, acmefit & flurbo")).toEqual({
      kind: "connect",
      targets: ["github", "acmefit", "flurbo"]
    });
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
      "connect acmefit",
      { connected: ["slack"], connectableSummary: "" },
      null,
      "test-model"
    );
    expect(intent).toEqual({ kind: "connect", targets: ["acmefit"] });
  });

  it("drops relevantSources ids the user has not actually connected", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({ kind: "investigate", relevantSources: ["acmefit", "github"] }) } }]
          })
        }
      }
    };
    const intent = await classifyIntent(
      "how many miles did I run this week?",
      { connected: ["acmefit", "slack"], connectableSummary: "" },
      client as never,
      "test-model"
    );
    expect(intent).toEqual({ kind: "investigate", relevantSources: ["acmefit"] });
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
    expect(intent).toEqual({ kind: "connect", targets: ["github"] });
  });
});

describe("resolveService (over synthesized integrations)", () => {
  it("matches service names in any surrounding phrasing, including multi-word aliases", () => {
    expect(resolveService("through github")?.id).toBe("github");
    expect(resolveService("my acme fit account")?.id).toBe("acmefit");
  });

  it("matches pasted URLs by hostname only", () => {
    expect(resolveService("https://acmefit.example/athletes/12345#week")?.id).toBe("acmefit");
    expect(resolveService("https://remote-mcp.example/acmefit-in-the-path")).toBeUndefined();
  });

  it("resolves close typos to the existing integration instead of triggering a rebuild", () => {
    expect(resolveService("acmefitt")?.id).toBe("acmefit");
    expect(resolveService("acme fitt")?.id).toBe("acmefit");
  });

  it("matches nothing for unknown services", () => {
    expect(resolveService("flurbo")).toBeUndefined();
  });
});
