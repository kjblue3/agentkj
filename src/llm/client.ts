import OpenAI from "openai";

/**
 * Provider-agnostic LLM client. Groq's API is OpenAI-compatible (chat.completions only —
 * it does NOT support the `responses` API used by `ReportSynthesizer`), so both Groq and
 * OpenAI are reached through the same `openai` SDK with a configurable `baseURL`.
 *
 * Env vars:
 *   LLM_API_KEYS  - comma-separated pool of interchangeable keys (e.g. several free-tier Groq
 *                   keys, each with its own rate-limit budget). Requests round-robin across the
 *                   pool, so one key's tokens-per-minute window doesn't throttle the others, and
 *                   the 429 retry in the agent loop naturally lands on the next key.
 *   LLM_API_KEY   - single key. Falls back to OPENAI_API_KEY for back-compat.
 *   LLM_BASE_URL  - e.g. https://api.groq.com/openai/v1 for Groq. Omit for OpenAI.
 *   LLM_MODEL     - e.g. llama-3.3-70b-versatile (Groq) or gpt-4.1-mini (OpenAI).
 */

export function llmApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  // Both vars accept a comma-separated list — people naturally paste a second key onto
  // LLM_API_KEY, and keys can't contain commas, so splitting is always safe.
  const pool = [env.LLM_API_KEYS, env.LLM_API_KEY || env.OPENAI_API_KEY]
    .flatMap((value) => value?.split(",") ?? [])
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(pool)];
}

export function llmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return llmApiKeys(env)[0];
}

export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmApiKeys(env).length > 0;
}

export function llmModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLM_MODEL) return env.LLM_MODEL;
  if (env.LLM_BASE_URL?.includes("groq")) return "llama-3.3-70b-versatile";
  return env.OPENAI_MODEL ?? "gpt-4.1-mini";
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env): OpenAI | null {
  const keys = llmApiKeys(env);
  if (keys.length === 0) return null;
  const baseURL = env.LLM_BASE_URL?.trim() || undefined;
  if (keys.length === 1) return new OpenAI({ apiKey: keys[0], baseURL });
  return roundRobinClient(keys.map((apiKey) => new OpenAI({ apiKey, baseURL })));
}

/**
 * Groq's free-tier rate limit is per-key tokens-per-minute, and its 429 says exactly when the
 * window resets (a retry-after header and/or "try again in Xs" in the message). Returns how long
 * to wait before that key works again, or null when the error isn't a rate limit at all.
 */
export function rateLimitWaitMs(error: unknown): number | null {
  const err = error as { status?: number; headers?: { get?: (key: string) => string | null }; message?: string };
  if (err?.status !== 429) return null;
  const header = typeof err.headers?.get === "function" ? Number(err.headers.get("retry-after")) : NaN;
  const fromMessage = Number(/try again in ([\d.]+)s/i.exec(err.message ?? "")?.[1]);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(fromMessage) ? fromMessage : 15;
  return Math.round(Math.min(Math.max(seconds + 1, 2), 60) * 1000);
}

/**
 * Facade over a pool of per-key clients. Each chat.completions.create goes to the next key in
 * rotation; a key that 429s is benched only until its window resets (Groq windows reset every
 * minute) and the request immediately fails over to the next fresh key — the pool never sleeps
 * while an un-limited key exists. When EVERY key is cooling down, the 429 propagates so the
 * caller's own rate-limit handling (which sleeps until reset) takes over. Only the
 * chat-completions surface is proxied — it is the only one used through createLlmClient (the
 * ReportSynthesizer builds its own client).
 */
export function roundRobinClient(clients: OpenAI[]): OpenAI {
  const cooldownUntil = new Array<number>(clients.length).fill(0);
  let index = 0;

  const nextReady = (): number => {
    const now = Date.now();
    for (let step = 0; step < clients.length; step++) {
      const candidate = (index + step) % clients.length;
      if (cooldownUntil[candidate]! <= now) {
        index = candidate + 1;
        return candidate;
      }
    }
    // Every key is cooling down; use the one that resets soonest.
    let soonest = 0;
    for (let i = 1; i < clients.length; i++) {
      if (cooldownUntil[i]! < cooldownUntil[soonest]!) soonest = i;
    }
    index = soonest + 1;
    return soonest;
  };

  const create = async (...args: Parameters<OpenAI["chat"]["completions"]["create"]>) => {
    let lastRateLimit: unknown;
    for (let attempt = 0; attempt < clients.length; attempt++) {
      const i = nextReady();
      try {
        return await clients[i]!.chat.completions.create(...args);
      } catch (error) {
        const waitMs = rateLimitWaitMs(error);
        if (waitMs === null) throw error;
        cooldownUntil[i] = Date.now() + waitMs;
        lastRateLimit = error;
      }
    }
    throw lastRateLimit;
  };

  return { chat: { completions: { create } } } as unknown as OpenAI;
}
