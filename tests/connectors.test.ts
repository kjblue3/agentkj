import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createConnectors, effectiveConnectorMode } from "../src/connectors/index.js";
import { GitHubConnector } from "../src/connectors/githubConnector.js";
import { GoogleDriveConnector } from "../src/connectors/googleDriveConnector.js";
import { IncidentConnector } from "../src/connectors/incidentConnector.js";
import { JiraConnector } from "../src/connectors/jiraConnector.js";
import { SlackConnector } from "../src/connectors/slackConnector.js";
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

    expect(connectors).toHaveLength(5);
    expect(connectors.map((connector) => connector.name)).toContain("Slack messages");
    expect(effectiveConnectorMode(connectors, { CONNECTOR_MODE: "real" })).toBe("demo");
    warn.mockRestore();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
}
