import { afterEach, describe, expect, it, vi } from "vitest";

// verifySpecEndpoints probes drafted OAuth endpoints through safeFetch; fake the network here.
vi.mock("../src/security/publicUrl.js", () => ({
  safeFetch: vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("ghost.example")) throw new Error("getaddrinfo ENOTFOUND ghost.example");
    if (href.includes("missing.example")) return new Response("not found", { status: 404 });
    // Real authorize/token endpoints answer without params — typically a 400 complaint.
    return new Response("missing client_id", { status: 400 });
  }),
  validatePublicUrl: vi.fn(async (url: string) => new URL(url))
}));

import { synthesizeService, verifySpecEndpoints } from "../src/services/architect.js";
import { safeFetch } from "../src/security/publicUrl.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";
import { compactResponse, DynamicToolProvider } from "../src/services/dynamicTools.js";

const validSpec = {
  id: "acmefit",
  label: "AcmeFit",
  aliases: ["acmefit"],
  domain: "the user's own workouts, distances, and training stats",
  homepage: "https://acmefit.example",
  apiHosts: ["acmefit.example", "api.acmefit.example"],
  oauth: {
    authorizeUrl: "https://acmefit.example/oauth/authorize",
    tokenUrl: "https://acmefit.example/oauth/token",
    scope: "read",
    extraAuthParams: {}
  },
  setupInstructions: "Create an API app in AcmeFit developer settings and register {CALLBACK_URL}.",
  tools: [
    {
      name: "list_workouts",
      description: "List the connected user's recent workouts.",
      method: "GET",
      urlTemplate: "https://api.acmefit.example/v1/athletes/{accountId}/workouts",
      params: [{ name: "per_page", description: "Max results to return.", required: false, location: "query" }]
    }
  ]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dynamicServiceSpecSchema", () => {
  it("accepts a well-formed spec", () => {
    expect(dynamicServiceSpecSchema.safeParse(validSpec).success).toBe(true);
  });

  it("rejects tool hosts not declared in apiHosts", () => {
    const spec = structuredClone(validSpec);
    spec.tools[0]!.urlTemplate = "https://evil.example/v1/workouts";
    const result = dynamicServiceSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it("rejects http URLs and placeholder hostnames", () => {
    const insecure = structuredClone(validSpec);
    insecure.oauth.tokenUrl = "http://acmefit.example/oauth/token";
    expect(dynamicServiceSpecSchema.safeParse(insecure).success).toBe(false);

    const hostInjection = structuredClone(validSpec);
    hostInjection.tools[0]!.urlTemplate = "https://{host}/v1/workouts";
    expect(dynamicServiceSpecSchema.safeParse(hostInjection).success).toBe(false);
  });
});

describe("DynamicToolProvider", () => {
  const spec = dynamicServiceSpecSchema.parse(validSpec);
  const token = { token: "tok", accountId: "42", connectedAt: "2026-07-10T00:00:00.000Z", scopes: [], health: "ready" as const };

  it("builds the request from the template, encodes substitutions, and returns evidence", async () => {
    const safeFetchSpy = vi.mocked(safeFetch);
    safeFetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, name: "Morning run" }]), { status: 200 }));

    const provider = new DynamicToolProvider(spec, token, "conn1", "U1");
    const tools = await provider.listAgentTools();
    expect(tools[0]!.type === "function" && tools[0]!.function.name).toBe("connection_conn1__list_workouts");

    const result = (await provider.call("connection_conn1__list_workouts", { per_page: "5" })) as { data: string; evidence: unknown[] };
    expect(safeFetchSpy).toHaveBeenCalledWith(
      "https://api.acmefit.example/v1/athletes/42/workouts?per_page=5",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    );
    expect(result.data).toContain("Morning run");
    expect(result.evidence).toHaveLength(1);
  });

  it("reports a reconnect-worthy error on 401 instead of junk data", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    const provider = new DynamicToolProvider(spec, token, "conn1", "U1");
    await expect(provider.call("connection_conn1__list_workouts", {})).rejects.toMatchObject({
      name: "ConnectionAccessError",
      code: "authorization_required",
      connectionId: "conn1",
      ownerUserId: "U1"
    });
  });

  it("routes requests through the public-URL guard", async () => {
    const safeFetchSpy = vi.mocked(safeFetch);
    safeFetchSpy.mockClear();
    safeFetchSpy.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const provider = new DynamicToolProvider(spec, token, "conn1", "U1");

    await provider.call("connection_conn1__list_workouts", {});

    expect(safeFetchSpy).toHaveBeenCalledWith(
      "https://api.acmefit.example/v1/athletes/42/workouts",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    );
  });
});

describe("synthesizeService", () => {
  function stubClient(responses: string[]): { client: never; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn();
    for (const content of responses) create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
    return { client: { chat: { completions: { create } } } as never, create };
  }

  it("returns a validated spec on the first good draft", async () => {
    const { client } = stubClient([JSON.stringify(validSpec)]);
    const result = await synthesizeService("acmefit", client, "test-model");
    expect("spec" in result && result.spec.id).toBe("acmefit");
  });

  it("repairs once using the validator's complaints", async () => {
    const broken = structuredClone(validSpec) as Record<string, unknown>;
    delete broken.setupInstructions;
    const { client, create } = stubClient([JSON.stringify(broken), JSON.stringify(validSpec)]);
    const result = await synthesizeService("acmefit", client, "test-model");
    expect(create).toHaveBeenCalledTimes(2);
    expect("spec" in result).toBe(true);
  });

  it("passes the model's honest refusal through", async () => {
    const { client } = stubClient([JSON.stringify({ error: "That service has no public OAuth2 API." })]);
    const result = await synthesizeService("flurbo", client, "test-model");
    expect("error" in result && result.error).toContain("no public OAuth2 API");
  });
});

describe("verifySpecEndpoints", () => {
  it("accepts specs whose OAuth endpoints answer (even with a 4xx param complaint)", async () => {
    const spec = dynamicServiceSpecSchema.parse(validSpec);
    expect(await verifySpecEndpoints(spec)).toBeNull();
  });

  it("rejects hallucinated hosts that fail DNS or 404", async () => {
    const ghost = structuredClone(validSpec);
    ghost.apiHosts = ["ghost.example"];
    ghost.oauth.authorizeUrl = "https://ghost.example/oauth/authorize";
    ghost.oauth.tokenUrl = "https://ghost.example/oauth/token";
    ghost.homepage = "https://ghost.example";
    ghost.tools[0]!.urlTemplate = "https://ghost.example/v1/workouts";
    expect(await verifySpecEndpoints(dynamicServiceSpecSchema.parse(ghost))).toContain("unreachable");

    const missing = structuredClone(ghost);
    for (const key of ["authorizeUrl", "tokenUrl"] as const) missing.oauth[key] = missing.oauth[key].replace("ghost", "missing");
    missing.apiHosts = ["missing.example", "ghost.example"];
    expect(await verifySpecEndpoints(dynamicServiceSpecSchema.parse(missing))).toContain("doesn't exist");
  });

  it("tolerates token endpoints that 404 anonymous probes (GitHub-style) when the authorize endpoint answers", async () => {
    const githubStyle = structuredClone(validSpec);
    githubStyle.apiHosts = [...githubStyle.apiHosts, "missing.example"];
    githubStyle.oauth.tokenUrl = "https://missing.example/login/oauth/access_token";
    expect(await verifySpecEndpoints(dynamicServiceSpecSchema.parse(githubStyle))).toBeNull();
  });
});

describe("compactResponse", () => {
  it("keeps every list item when shrinking an oversized payload — no server left behind", () => {
    const guilds = Array.from({ length: 12 }, (_, index) => ({
      id: `10000000000000${index.toString().padStart(4, "0")}`,
      name: `Guild Number ${index}`,
      icon: "a".repeat(400),
      banner: "b".repeat(400),
      permissions: "562949953421311",
      features: Array.from({ length: 12 }, (_, f) => `FEATURE_FLAG_${f}_${"x".repeat(30)}`)
    }));
    const raw = JSON.stringify(guilds);
    expect(raw.length).toBeGreaterThan(12_000);
    const compacted = compactResponse(raw);
    expect(compacted.length).toBeLessThanOrEqual(12_000);
    for (let index = 0; index < 12; index++) expect(compacted).toContain(`Guild Number ${index}`);
    const parsed = JSON.parse(compacted) as { name: string }[];
    expect(parsed).toHaveLength(12);
  });

  it("leaves small responses untouched and labels unsalvageable overflow", () => {
    expect(compactResponse('{"ok":true}')).toBe('{"ok":true}');
    const overflowing = compactResponse("plain text ".repeat(2000));
    expect(overflowing.length).toBeLessThanOrEqual(12_000);
    expect(overflowing).toContain("[response truncated");
  });
});
