import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createConnectors, effectiveConnectorMode } from "../src/connectors/index.js";
import { GitHubConnector } from "../src/connectors/githubConnector.js";
import { GoogleDriveConnector } from "../src/connectors/googleDriveConnector.js";
import { IncidentConnector } from "../src/connectors/incidentConnector.js";
import { JiraConnector } from "../src/connectors/jiraConnector.js";
import { McpGitHubConnector } from "../src/connectors/mcpGitHubConnector.js";
import { SlackConnector } from "../src/connectors/slackConnector.js";
import type { McpToolClient } from "../src/connectors/mcpClient.js";
import type { InvestigationQuery } from "../src/types/schemas.js";

const query: InvestigationQuery = {
  originalQuestion: "Why did checkout latency spike?",
  keywords: ["checkout", "latency"],
  entities: ["checkout"],
  tags: ["latency"]
};

describe("real evidence connectors", () => {
  it("normalizes Slack search results", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      ok: true,
      messages: {
        matches: [{
          channel: { id: "C123", name: "incidents" },
          username: "Sam",
          ts: "1760000000.000100",
          text: "Checkout latency rose after the tax lookup deploy.",
          permalink: "https://example.slack.com/archives/C123/p1760000000000100"
        }]
      }
    }));

    const [item] = await new SlackConnector("xoxb-test", fetcher).search(query);

    expect(item?.source).toBe("slack");
    expect(item?.id).toBe("slack:C123:1760000000.000100");
    expect(item?.body).toContain("tax lookup");
  });

  it("normalizes GitHub issue and code search results", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues")) {
        return jsonResponse({
          items: [{
            number: 42,
            title: "Checkout latency regression",
            body: "N+1 tax lookup in checkout-service.",
            html_url: "https://github.com/acme/shop/issues/42",
            updated_at: "2026-01-02T00:00:00Z",
            user: { login: "devon" },
            labels: [{ name: "latency" }],
            repository_url: "https://api.github.com/repos/acme/shop"
          }]
        });
      }
      return jsonResponse({
        items: [{
          name: "tax.ts",
          path: "src/tax.ts",
          sha: "abc123",
          html_url: "https://github.com/acme/shop/blob/main/src/tax.ts",
          repository: { full_name: "acme/shop" }
        }]
      });
    });

    const results = await new GitHubConnector("ghp-test", "acme", ["shop"], fetcher).search(query);

    expect(results.map((item) => item.source)).toEqual(["github", "github"]);
    expect(results[0]?.tags).toContain("latency");
    expect(results[1]?.id).toContain("github:code:acme/shop");
  });

  it("normalizes GitHub MCP issue and code tool responses", async () => {
    const client: McpToolClient = {
      async listTools() {
        return [{ name: "search_issues" }, { name: "search_code" }, { name: "get_issue" }];
      },
      async callTool(name: string) {
        if (name === "search_issues") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                items: [{
                  number: 1842,
                  title: "Regional tax calculation",
                  body: "Review found a tax_rule lookup inside the cart item loop.",
                  html_url: "https://github.com/acme/slack-detective-demo/pull/1842",
                  updated_at: "2026-05-14T16:00:00Z",
                  user: { login: "leo" },
                  labels: [{ name: "n+1" }],
                  repository: { full_name: "acme/slack-detective-demo" },
                  pull_request: {}
                }]
              })
            }]
          };
        }

        return {
          structuredContent: {
            items: [{
              name: "taxRules.ts",
              path: "src/checkout/taxRules.ts",
              sha: "def456",
              html_url: "https://github.com/acme/slack-detective-demo/blob/main/src/checkout/taxRules.ts",
              repository: { full_name: "acme/slack-detective-demo" },
              text: "loadTaxRule is called inside the cart item loop."
            }]
          }
        };
      },
      async close() {
        return undefined;
      }
    };

    const results = await new McpGitHubConnector({
      owner: "acme",
      repo: "slack-detective-demo",
      client
    }).search(query);

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe("github:issue:acme/slack-detective-demo:1842");
    expect(results[0]?.tags).toContain("mcp");
    expect(results[1]?.body).toContain("loadTaxRule");
  });

  it("normalizes Jira issues and comments", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      issues: [{
        key: "OPS-7",
        fields: {
          summary: "Checkout p95 is high",
          description: { content: [{ content: [{ text: "Tax lookup fanout is the likely cause." }] }] },
          updated: "2026-01-03T00:00:00.000Z",
          reporter: { displayName: "Priya" },
          labels: ["checkout"],
          comment: {
            comments: [{ body: { content: [{ content: [{ text: "Rollback restored latency." }] }] } }]
          }
        }
      }]
    }));

    const [item] = await new JiraConnector(
      "https://acme.atlassian.net",
      "user@example.com",
      "token",
      ["OPS"],
      fetcher
    ).search(query);

    expect(item?.id).toBe("jira:OPS-7");
    expect(item?.url).toBe("https://acme.atlassian.net/browse/OPS-7");
    expect(item?.body).toContain("Rollback restored latency");
  });

  it("normalizes Google Drive files and exported document text", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/drive/v3/files?")) {
        return jsonResponse({
          files: [{
            id: "doc-1",
            name: "Checkout Incident Review",
            mimeType: "application/vnd.google-apps.document",
            webViewLink: "https://docs.google.com/document/d/doc-1",
            modifiedTime: "2026-01-04T00:00:00Z",
            owners: [{ displayName: "Mina" }]
          }]
        });
      }
      return new Response("Checkout latency was caused by repeated tax lookups.");
    });

    const [item] = await new GoogleDriveConnector(
      { accessToken: "ya29-test" },
      ["folder-1"],
      fetcher
    ).search(query);

    expect(item?.source).toBe("docs");
    expect(item?.id).toBe("docs:doc-1");
    expect(item?.body).toContain("repeated tax lookups");
  });

  it("normalizes incident records from a production JSON file", async () => {
    const path = join(tmpdir(), `incidents-${Date.now()}.json`);
    await writeFile(path, JSON.stringify([
      {
        id: "inc-1",
        title: "Checkout latency",
        summary: "Checkout latency spiked during tax lookups.",
        url: "https://status.example.com/inc-1",
        updatedAt: "2026-01-05T00:00:00Z",
        services: ["checkout"],
        tags: ["sev2"]
      }
    ]));

    const [item] = await new IncidentConnector({ jsonPath: path }).search(query);

    expect(item?.source).toBe("incident");
    expect(item?.entities).toContain("checkout");
    expect(item?.tags).toContain("sev2");
  });

  it("falls back to demo connectors when real mode has no configured credentials", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const connectors = createConnectors([], { CONNECTOR_MODE: "real" });

    expect(connectors).toHaveLength(6);
    expect(connectors.map((connector) => connector.name)).toContain("Slack messages");
    expect(connectors.map((connector) => connector.name)).toContain("Public web pages");
    expect(effectiveConnectorMode(connectors, { CONNECTOR_MODE: "real" })).toBe("demo");
    warn.mockRestore();
  });

  it("uses GitHub MCP when MCP_GITHUB_ENABLED is true", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const connectors = createConnectors([], {
      CONNECTOR_MODE: "real",
      MCP_GITHUB_ENABLED: "true",
      MCP_GITHUB_COMMAND: "node fake-github-mcp.js",
      GITHUB_OWNER: "acme",
      GITHUB_DEMO_REPO: "slack-detective-demo",
      GITHUB_TOKEN: "ghp-test",
      GITHUB_REPOS: "legacy-repo"
    });

    expect(connectors.map((connector) => connector.name)).toEqual(["GitHub MCP"]);
    expect(effectiveConnectorMode(connectors, { CONNECTOR_MODE: "real" })).toBe("real");
    warn.mockRestore();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
}
