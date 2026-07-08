import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/security/redaction.js";

describe("secret redaction", () => {
  it("redacts secret-like keys and exact credential values from connector output", () => {
    expect(redactSecrets({
      content: [{ text: "Bearer demo-token appeared in tool output." }],
      access_token: "demo-token",
      nested: { apiKey: "abc123" }
    }, ["demo-token"])).toEqual({
      content: [{ text: "Bearer [REDACTED] appeared in tool output." }],
      access_token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]" }
    });
  });
});
