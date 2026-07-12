import OpenAI from "openai";

export function llmApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [env.LLM_API_KEYS, env.LLM_API_KEY || env.OPENAI_API_KEY]
    .flatMap((value) => value?.split(",") ?? [])
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export function llmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined { return llmApiKeys(env)[0]; }
export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean { return llmApiKeys(env).length > 0; }
export function llmModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLM_MODEL) return env.LLM_MODEL;
  if (env.LLM_BASE_URL?.includes("generativelanguage")) return "gemini-3.5-flash";
  if (env.LLM_BASE_URL?.includes("groq")) return "llama-3.3-70b-versatile";
  return env.OPENAI_MODEL ?? "gpt-4.1-mini";
}

export interface RateLimitDetails { waitMs: number; retryAt: Date; }

export function rateLimitDetails(error: unknown): RateLimitDetails | null {
  const value = error as { status?: number; headers?: { get?: (key: string) => string | null }; message?: string };
  if (value?.status !== 429) return null;
  const get = typeof value.headers?.get === "function" ? value.headers.get.bind(value.headers) : undefined;
  const retryAfter = Number(get?.("retry-after"));
  const reset = get?.("x-ratelimit-reset-tokens") ?? get?.("x-ratelimit-reset-requests");
  const resetSeconds = reset ? durationSeconds(reset) : NaN;
  const messageSeconds = Number(/(?:try again in|retry after)\s*([\d.]+)s/i.exec(value.message ?? "")?.[1]);
  const seconds = [retryAfter, resetSeconds, messageSeconds].find((candidate) => Number.isFinite(candidate) && candidate > 0) ?? 15;
  const waitMs = Math.max(1000, Math.ceil(seconds * 1000) + 250);
  return { waitMs, retryAt: new Date(Date.now() + waitMs) };
}

function durationSeconds(value: string): number {
  if (/^[\d.]+$/.test(value)) return Number(value);
  const match = /(?:(\d+)m)?([\d.]+)s/i.exec(value);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : NaN;
}

export function rateLimitWaitMs(error: unknown): number | null { return rateLimitDetails(error)?.waitMs ?? null; }

export class LlmCapacityExhausted extends Error {
  constructor(readonly retryAt: Date, readonly attemptedKeyCount: number) {
    super(`Language-model capacity is unavailable until ${retryAt.toISOString()}.`);
    this.name = "LlmCapacityExhausted";
  }
}

export class LlmGateway {
  private readonly clients: OpenAI[];
  private readonly cooldownUntil: number[];
  private index = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  readonly maxConcurrency: number;

  constructor(keys: string[], baseURL?: string, maxConcurrency = Math.min(4, Math.max(1, keys.length))) {
    this.clients = keys.map((apiKey) => new OpenAI({ apiKey, baseURL }));
    this.cooldownUntil = new Array(keys.length).fill(0);
    this.maxConcurrency = maxConcurrency;
  }

  asClient(): OpenAI {
    const create = async (...args: Parameters<OpenAI["chat"]["completions"]["create"]>) => this.create(...args);
    return { chat: { completions: { create } } } as unknown as OpenAI;
  }

  async create(...args: Parameters<OpenAI["chat"]["completions"]["create"]>) {
    await this.acquire();
    try {
      let attempted = 0;
      const attemptedIndexes = new Set<number>();
      while (attempted < this.clients.length) {
        const candidate = this.nextReady(attemptedIndexes);
        if (candidate === null) {
          const retryAt = new Date(Math.min(...this.cooldownUntil.filter((time) => time > Date.now())));
          throw new LlmCapacityExhausted(retryAt, attempted);
        }
        attemptedIndexes.add(candidate);
        attempted++;
        try {
          return await this.clients[candidate]!.chat.completions.create(...args);
        } catch (error) {
          const limit = rateLimitDetails(error);
          if (!limit) throw error;
          this.cooldownUntil[candidate] = limit.retryAt.getTime();
        }
      }
      const retryAt = new Date(Math.min(...this.cooldownUntil));
      throw new LlmCapacityExhausted(retryAt, attempted);
    } finally {
      this.release();
    }
  }

  private nextReady(excluded: Set<number>): number | null {
    const now = Date.now();
    for (let step = 0; step < this.clients.length; step++) {
      const candidate = (this.index + step) % this.clients.length;
      if (!excluded.has(candidate) && this.cooldownUntil[candidate]! <= now) {
        this.index = (candidate + 1) % this.clients.length;
        return candidate;
      }
    }
    return null;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) { this.active++; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

let shared: { signature: string; gateway: LlmGateway } | undefined;
export function sharedLlmGateway(env: NodeJS.ProcessEnv = process.env): LlmGateway | null {
  const keys = llmApiKeys(env);
  if (keys.length === 0) return null;
  const max = Number(env.MAX_CONCURRENT_INVESTIGATIONS);
  const concurrency = Number.isFinite(max) && max > 0 ? Math.floor(max) : Math.min(4, Math.max(1, keys.length));
  const signature = JSON.stringify([keys, env.LLM_BASE_URL?.trim() || "", concurrency]);
  if (!shared || shared.signature !== signature) {
    shared = { signature, gateway: new LlmGateway(keys, env.LLM_BASE_URL?.trim() || undefined, concurrency) };
  }
  return shared.gateway;
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env): OpenAI | null {
  return sharedLlmGateway(env)?.asClient() ?? null;
}

export function roundRobinClient(clients: OpenAI[]): OpenAI {
  const cooldownUntil = new Array<number>(clients.length).fill(0);
  let index = 0;
  const create = async (...args: Parameters<OpenAI["chat"]["completions"]["create"]>) => {
    let attempted = 0;
    let visited = 0;
    while (visited < clients.length) {
      const candidate = index++ % clients.length;
      visited++;
      if (cooldownUntil[candidate]! > Date.now()) continue;
      attempted++;
      try { return await clients[candidate]!.chat.completions.create(...args); }
      catch (error) {
        const details = rateLimitDetails(error);
        if (!details) throw error;
        cooldownUntil[candidate] = details.retryAt.getTime();
      }
    }
    const future = cooldownUntil.filter((value) => value > Date.now());
    throw new LlmCapacityExhausted(new Date(future.length > 0 ? Math.min(...future) : Date.now() + 15_000), attempted);
  };
  return { chat: { completions: { create } } } as unknown as OpenAI;
}
