import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { llmApiKeys, rateLimitWaitMs, roundRobinClient } from "../src/llm/client.js";

function fakeClient(create: (...args: unknown[]) => Promise<unknown>): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(create);
  return { client: { chat: { completions: { create: spy } } } as unknown as OpenAI, create: spy };
}

function rateLimit(seconds: number): Error & { status: number } {
  return Object.assign(new Error(`Rate limit reached. Please try again in ${seconds}s.`), { status: 429 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("llmApiKeys", () => {
  it("prefers the LLM_API_KEYS pool and dedupes the single-key fallbacks", () => {
    expect(llmApiKeys({ LLM_API_KEYS: "a, b ,a", LLM_API_KEY: "b" } as NodeJS.ProcessEnv)).toEqual(["a", "b"]);
    expect(llmApiKeys({ LLM_API_KEY: "solo" } as NodeJS.ProcessEnv)).toEqual(["solo"]);
  });

  it("accepts a comma-separated pool pasted into LLM_API_KEY too", () => {
    expect(llmApiKeys({ LLM_API_KEY: "one,two" } as NodeJS.ProcessEnv)).toEqual(["one", "two"]);
  });
});

describe("roundRobinClient", () => {
  it("fails over to the next key immediately on 429 and benches the limited key", async () => {
    vi.useFakeTimers();
    const first = fakeClient(async () => { throw rateLimit(30); });
    const second = fakeClient(async () => ({ ok: true }));
    const pool = roundRobinClient([first.client, second.client]);

    // First request: key 1 is rate-limited, key 2 answers — no sleep in between.
    await expect(pool.chat.completions.create({} as never)).resolves.toEqual({ ok: true });
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(second.create).toHaveBeenCalledTimes(1);

    // While key 1 cools down, requests keep going to key 2 without touching key 1.
    await pool.chat.completions.create({} as never);
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(second.create).toHaveBeenCalledTimes(2);

    // Groq windows reset every minute — after the reset, key 1 is back in rotation.
    vi.advanceTimersByTime(61_000);
    first.create.mockResolvedValueOnce({ ok: "first-again" });
    await expect(pool.chat.completions.create({} as never)).resolves.toEqual({ ok: "first-again" });
    expect(first.create).toHaveBeenCalledTimes(2);
  });

  it("propagates the 429 only when every key is cooling down", async () => {
    const first = fakeClient(async () => { throw rateLimit(10); });
    const second = fakeClient(async () => { throw rateLimit(10); });
    const pool = roundRobinClient([first.client, second.client]);

    await expect(pool.chat.completions.create({} as never)).rejects.toMatchObject({ status: 429 });
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(second.create).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-rate-limit errors without failing over", async () => {
    const first = fakeClient(async () => { throw new Error("bad request"); });
    const second = fakeClient(async () => ({ ok: true }));
    const pool = roundRobinClient([first.client, second.client]);

    await expect(pool.chat.completions.create({} as never)).rejects.toThrow("bad request");
    expect(second.create).not.toHaveBeenCalled();
  });
});

describe("rateLimitWaitMs", () => {
  it("reads the reset from the message and returns null for non-429s", () => {
    expect(rateLimitWaitMs(rateLimit(5))).toBe(6000);
    expect(rateLimitWaitMs(new Error("boom"))).toBeNull();
  });
});
