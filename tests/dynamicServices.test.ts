import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeService } from "../src/services/architect.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";
import { DynamicToolProvider } from "../src/services/dynamicTools.js";

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
  const token = { token: "tok", accountId: "42", connectedAt: "2026-07-10T00:00:00.000Z" };

  it("builds the request from the template, encodes substitutions, and returns evidence", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify([{ id: 1, name: "Morning run" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new DynamicToolProvider(spec, token);
    const tools = await provider.listAgentTools();
    expect(tools[0]!.type === "function" && tools[0]!.function.name).toBe("acmefit__list_workouts");

    const result = (await provider.call("acmefit__list_workouts", { per_page: "5" })) as { data: string; evidence: unknown[] };
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.acmefit.example/v1/athletes/42/workouts?per_page=5",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    );
    expect(result.data).toContain("Morning run");
    expect(result.evidence).toHaveLength(1);
  });

  it("reports a reconnect-worthy error on 401 instead of junk data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const provider = new DynamicToolProvider(spec, token);
    const result = (await provider.call("acmefit__list_workouts", {})) as { error?: string };
    expect(result.error).toContain("reconnect");
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
