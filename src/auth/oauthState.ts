import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthStatePayload {
  nonce: string;
  workspaceId: string;
  userId: string;
  serviceId: string;
  expiresAt: number;
}

function secret(env: NodeJS.ProcessEnv): string {
  const value = env.OAUTH_STATE_SECRET?.trim();
  if (!value) throw new Error("OAUTH_STATE_SECRET is required for OAuth links.");
  return value;
}

export function signOAuthState(payload: OAuthStatePayload, env: NodeJS.ProcessEnv = process.env): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret(env)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(state: string, env: NodeJS.ProcessEnv = process.env): OAuthStatePayload | null {
  try {
    const [encoded, signature] = state.split(".");
    if (!encoded || !signature) return null;
    const expected = createHmac("sha256", secret(env)).update(encoded).digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
    if (!payload.nonce || !payload.workspaceId || !payload.userId || !payload.serviceId || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
