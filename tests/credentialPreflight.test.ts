import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/security/publicUrl.js", () => ({ safeFetch: vi.fn() }));

import { safeFetch } from "../src/security/publicUrl.js";
import { clientCredentialPreflight } from "../src/auth/credentialPreflight.js";
import { dynamicServiceSpecSchema } from "../src/services/dynamicSpec.js";

const spec = dynamicServiceSpecSchema.parse({
  id: "acme-chat-probe",
  label: "Acme Chat",
  aliases: ["acme chat probe"],
  domain: "chat guilds, memberships, and message history",
  homepage: "https://chat.example.test",
  apiHosts: ["chat.example.test"],
  oauth: {
    authorizeUrl: "https://chat.example.test/oauth/authorize",
    tokenUrl: "https://chat.example.test/oauth/token",
    scope: "identify",
    extraAuthParams: {}
  },
  setupInstructions: "Register a read-only application and use {CALLBACK_URL} as its callback URL.",
  tools: [{ name: "list_guilds", description: "List the guilds the authorized account belongs to.", method: "GET", urlTemplate: "https://chat.example.test/api/guilds", params: [] }]
});

const mockedFetch = vi.mocked(safeFetch);
const callback = "https://agent.example.test/auth/services/acme-chat-probe/callback";

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

// mockReset() here trips a vitest 4 spy quirk that misattributes caught rejections from the
// throwing implementation below as unhandled; clearing + a benign default isolates tests equally.
beforeEach(() => {
  mockedFetch.mockClear();
  mockedFetch.mockImplementation(async () => respond(200, "<html>login page</html>"));
});

describe("client credential preflight", () => {
  it("rejects a client id the authorization endpoint disowns", async () => {
    mockedFetch.mockResolvedValueOnce(respond(401, "Error 401: invalid_client. The OAuth client was not found."));
    const verdict = await clientCredentialPreflight(spec, "112233445566778899", "secret-value", callback, spec.label);
    expect(verdict).toContain("did not recognize this client ID");
    const probeUrl = new URL(String(mockedFetch.mock.calls[0]?.[0]));
    expect(probeUrl.searchParams.get("client_id")).toBe("112233445566778899");
    expect(probeUrl.searchParams.get("redirect_uri")).toBe(callback);
  });

  it("rejects field-keyed client_id complaints in provider JSON", async () => {
    mockedFetch.mockResolvedValueOnce(respond(400, '{"client_id": ["Value \\"8a3ecd\\" is not snowflake."]}'));
    const verdict = await clientCredentialPreflight(spec, "8a3ecd", "secret-value", callback, spec.label);
    expect(verdict).toContain("did not recognize this client ID");
  });

  it("passes scope and redirect complaints — the client was recognized", async () => {
    mockedFetch.mockResolvedValueOnce(respond(400, '{"redirect_uri": ["Redirect URI is not registered."]}'));
    mockedFetch.mockResolvedValueOnce(respond(400, '{"error": "unsupported_grant_type"}'));
    expect(await clientCredentialPreflight(spec, "112233445566778899", "secret-value", callback, spec.label)).toBeNull();
  });

  it("rejects an id+secret pair the token endpoint authenticates as invalid_client", async () => {
    mockedFetch.mockResolvedValueOnce(respond(200, "<html>login page</html>"));
    mockedFetch.mockResolvedValueOnce(respond(401, '{"error": "invalid_client"}'));
    const verdict = await clientCredentialPreflight(spec, "112233445566778899", "wrong-secret", callback, spec.label);
    expect(verdict).toContain("rejected this client ID and secret as a pair");
    const tokenInit = mockedFetch.mock.calls[1]?.[1];
    expect(String((tokenInit?.headers as Record<string, string>)?.authorization)).toContain("Basic ");
    expect(String(tokenInit?.body)).toContain("grant_type=client_credentials");
  });

  it("fails open on non-JSON errors, other grant errors, and unreachable providers", async () => {
    mockedFetch.mockResolvedValueOnce(respond(200, "<html>login page</html>"));
    mockedFetch.mockResolvedValueOnce(respond(400, "<html>bad request</html>"));
    expect(await clientCredentialPreflight(spec, "112233445566778899", "secret-value", callback, spec.label)).toBeNull();

    mockedFetch.mockResolvedValueOnce(respond(200, "<html>login page</html>"));
    mockedFetch.mockResolvedValueOnce(respond(400, '{"error": "invalid_scope"}'));
    expect(await clientCredentialPreflight(spec, "112233445566778899", "secret-value", callback, spec.label)).toBeNull();

    mockedFetch.mockImplementation(async () => {
      throw new Error("unreachable");
    });
    expect(await clientCredentialPreflight(spec, "112233445566778899", "secret-value", callback, spec.label)).toBeNull();
  });
});
