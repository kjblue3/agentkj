import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicWebToolProvider } from "../src/connectors/publicWebTool.js";
import { UnsafeUrlError, validatePublicUrl } from "../src/security/publicUrl.js";

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
