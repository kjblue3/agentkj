import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "agentkj-mcpoauth-"));

const fetched: string[] = [];
vi.mock("../src/security/publicUrl.js", () => ({
  safeFetch: vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    fetched.push(href);
    if (href === "https://mcp.example/.well-known/oauth-protected-resource") {
      return Response.json({ authorization_servers: ["https://auth.example"] });
    }
    if (href === "https://auth.example/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        scopes_supported: ["mcp.read"]
      });
    }
    if (href === "https://auth.example/register" && init?.method === "POST") {
      return Response.json({ client_id: "dyn-client-1" });
    }
    return new Response("not found", { status: 404 });
  }),
  validatePublicUrl: vi.fn(async (url: string) => new URL(url))
}));

const { createPkce, discoverAuthServer, ensureClientRegistration } = await import("../src/mcp/mcpOAuth.js");

describe("createPkce", () => {
  it("produces an S256 challenge of the verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier.length).toBeGreaterThan(42);
  });
});

describe("discoverAuthServer", () => {
  it("follows protected-resource metadata to the authorization server's RFC 8414 metadata", async () => {
    const meta = await discoverAuthServer("https://mcp.example/mcp");
    expect(meta).toMatchObject({
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      registrationEndpoint: "https://auth.example/register",
      scopesSupported: ["mcp.read"]
    });
  });
});

describe("ensureClientRegistration", () => {
  it("registers dynamically once and reuses the cached client afterwards", async () => {
    const meta = (await discoverAuthServer("https://mcp.example/mcp"))!;
    const first = await ensureClientRegistration(meta, "https://bot.example/auth/mcp/callback");
    expect(first?.clientId).toBe("dyn-client-1");

    const registrationCalls = () => fetched.filter((url) => url === "https://auth.example/register").length;
    const before = registrationCalls();
    const second = await ensureClientRegistration(meta, "https://bot.example/auth/mcp/callback");
    expect(second?.clientId).toBe("dyn-client-1");
    expect(registrationCalls()).toBe(before);
  });
});
