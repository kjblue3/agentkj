import { describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "../src/auth/oauthState.js";

const env = { OAUTH_STATE_SECRET: "state-secret" } as NodeJS.ProcessEnv;

describe("generic OAuth state", () => {
  it("preserves workspace, user, service, and nonce identity", () => {
    const payload = { nonce: "nonce", workspaceId: "T1", userId: "U1", serviceId: "records-service", expiresAt: Date.now() + 60_000 };
    expect(verifyOAuthState(signOAuthState(payload, env), env)).toEqual(payload);
  });
  it("rejects tampering, expiry, and a different signing secret", () => {
    const state = signOAuthState({ nonce: "nonce", workspaceId: "T1", userId: "U1", serviceId: "records-service", expiresAt: Date.now() - 1 }, env);
    expect(verifyOAuthState(state, env)).toBeNull();
    expect(verifyOAuthState(state.replace(/.$/, "x"), env)).toBeNull();
    expect(verifyOAuthState(state, { OAUTH_STATE_SECRET: "different" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("rejects malformed shapes and extra token segments", () => {
    const malformed = signOAuthState({
      nonce: "nonce",
      workspaceId: "T1",
      userId: "U1",
      serviceId: "records-service",
      expiresAt: Number.NaN
    }, env);
    const valid = signOAuthState({
      nonce: "nonce",
      workspaceId: "T1",
      userId: "U1",
      serviceId: "records-service",
      expiresAt: Date.now() + 60_000
    }, env);

    expect(verifyOAuthState(malformed, env)).toBeNull();
    expect(verifyOAuthState(`${valid}.ignored`, env)).toBeNull();
    expect(verifyOAuthState("not-a-state", env)).toBeNull();
  });
});
