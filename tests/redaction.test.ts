import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/security/redaction.js";

describe("secret redaction", () => {
  it("redacts secret-like keys and exact credential values from connector output", () => {
    expect(redactSecrets({
      content: [{ text: "Bearer test-token appeared in tool output." }],
      access_token: "test-token",
      nested: { apiKey: "abc123" }
    }, ["test-token"])).toEqual({
      content: [{ text: "Bearer [REDACTED] appeared in tool output." }],
      access_token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]" }
    });
  });
});
