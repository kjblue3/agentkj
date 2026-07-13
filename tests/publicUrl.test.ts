import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicWebToolProvider } from "../src/connectors/publicWebTool.js";
import { safeFetch, UnsafeUrlError, validatePublicUrl } from "../src/security/publicUrl.js";

afterEach(() => vi.unstubAllGlobals());

describe("public URL safety", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.2/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
    "https://user:password@8.8.8.8/"
  ])("blocks unsafe URL %s", async (url) => {
    await expect(validatePublicUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("accepts a public HTTP address", async () => {
    await expect(validatePublicUrl("https://8.8.8.8/article")).resolves.toMatchObject({
      protocol: "https:",
      hostname: "8.8.8.8"
    });
  });

  it("does not forward credentials across redirect origins", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://1.1.1.1/final" }
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await safeFetch("https://8.8.8.8/start", {
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: "session=secret",
        Accept: "application/json"
      }
    });

    const firstHeaders = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    const redirectedHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer secret-token");
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("cookie")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json");
  });

  it("validates every redirect target and blocks private-network redirects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    })));

    await expect(safeFetch("https://8.8.8.8/start")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("reads bounded public HTML as untrusted text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><head><title>Useful page</title><script>steal()</script></head><body>Hello <b>world</b></body></html>",
      { status: 200, headers: { "content-type": "text/html" } }
    )));
    const provider = new PublicWebToolProvider("https://8.8.8.8/article");
    const [tool] = await provider.listAgentTools();
    expect(tool?.type).toBe("function");
    if (!tool || tool.type !== "function") throw new Error("Expected a function tool.");
    const result = await provider.call(tool.function.name) as Record<string, unknown>;

    expect(result.title).toBe("Useful page");
    expect(result.content).toBe("Useful page Hello world");
    expect(result.content).not.toContain("steal");
    expect(result.security).toContain("Untrusted");
  });
});
