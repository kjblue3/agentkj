import OpenAI from "openai";

/**
 * Provider-agnostic LLM client. Groq's API is OpenAI-compatible (chat.completions only —
 * it does NOT support the `responses` API used by `ReportSynthesizer`), so both Groq and
 * OpenAI are reached through the same `openai` SDK with a configurable `baseURL`.
 *
 * Env vars:
 *   LLM_API_KEY   - Groq or OpenAI key. Falls back to OPENAI_API_KEY for back-compat.
 *   LLM_BASE_URL  - e.g. https://api.groq.com/openai/v1 for Groq. Omit for OpenAI.
 *   LLM_MODEL     - e.g. llama-3.3-70b-versatile (Groq) or gpt-4.1-mini (OpenAI).
 */

export function llmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LLM_API_KEY || env.OPENAI_API_KEY;
}

export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(llmApiKey(env));
}

export function llmModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLM_MODEL) return env.LLM_MODEL;
  if (env.LLM_BASE_URL?.includes("groq")) return "llama-3.3-70b-versatile";
  return env.OPENAI_MODEL ?? "gpt-4.1-mini";
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env): OpenAI | null {
  const apiKey = llmApiKey(env);
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: env.LLM_BASE_URL?.trim() || undefined });
}
