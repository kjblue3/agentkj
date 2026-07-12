import type OpenAI from "openai";
import { LlmCapacityExhausted } from "../llm/client.js";

/**
 * Decides what an incoming Slack message wants — with the LLM, not keyword prefixes. Users say
 * "hey can you hook up my <service>?" or paste a link to their account page; none of that survives
 * string matching. The classifier sees the user's connected/connectable sources so it can also
 * mark which connected sources are plausibly relevant to a question (the investigation then
 * never rummages through an unrelated source.
 *
 * The deterministic parse below is strictly a degraded fallback for when no LLM is configured
 * (tests, keyless demo mode) or the classification call itself fails — never the primary path.
 */

export type SlackIntent = (
  | {
      kind: "investigate";
      /**
       * Connected source ids that could plausibly hold the answer. Undefined means "no signal"
       * (fallback path — don't gate anything); an empty array means the classifier judged NONE
       * of the connected sources relevant.
       */
      relevantSources?: string[];
    }
  | { kind: "connect"; targets: string[] }
  | { kind: "list_connectors" }
  | { kind: "approve" }
  | { kind: "share" }
  | { kind: "help" }
) & { /** Natural copy drafted in the routing call; never contains links or security decisions. */ acknowledgement?: string };

export interface IntentContext {
  /** Source ids workspace members already connected. */
  connected: string[];
  /** One-line-per-service description of what is connectable, for the prompt. */
  connectableSummary: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You route one Slack message sent to an investigation agent. Reply with JSON only:
{"kind": "investigate" | "connect" | "list_connectors" | "approve" | "share" | "help", "targets"?: string[], "relevantSources"?: string[], "acknowledgement"?: string}

Rules, in priority order:
For every kind, include one short, natural "acknowledgement" appropriate to what the user asked. Do not invent links, permissions, completion, or security facts.
1. "approve <id> ..." and "share <id> ..." are literal bot-issued commands — return those kinds only for messages that start with those words followed by an id.
2. "connect": the user wants to link/hook up/add one or MORE services, accounts, data sources, or MCP servers — in ANY phrasing ("can you connect <name>", "add my <name> and <other> accounts", "hook this up: https://..."). Also choose connect when the message is essentially just a link to the user's own account/profile/dashboard on a service that requires login (a fitness profile, a SaaS workspace) — pasting it means they want that service's data. Set "targets" to the list of service names or URLs, one entry per service, exactly as the user referenced each.
3. "list_connectors": asking what data sources are connected to or available to connect to THIS agent. NOT follow-ups about things an earlier answer mentioned — when thread context shows an investigation and the new message refers back to it ("can you list them?", "show me those", "break that down"), that continues the investigation: classify it "investigate".
4. "help": empty greetings, "what can you do".
5. Everything else is "investigate": a question or task to research. Set "relevantSources" to the subset of the user's CONNECTED sources that could plausibly contain the answer, judged by each source's data domain — include a source only if the question's subject matter matches it; return [] when none fit. A plain public article link to read counts as investigate, not connect. Also write one short, natural acknowledgement that fits the request without claiming work is already complete.

Never invent source ids not in the connected list. JSON only, no prose.`;

function safeParse(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const INTENT_KINDS = new Set(["investigate", "connect", "list_connectors", "approve", "share", "help"]);

/**
 * Degraded deterministic parse, used ONLY when there is no LLM to ask. Recognizes the legacy
 * command shapes so a keyless deployment still functions; free-form phrasings need the LLM.
 */
export function heuristicIntent(text: string): SlackIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "help" };
  if (/^(?:help|hi|hello|hey)$/i.test(trimmed)) return { kind: "help" };
  if (/^connectors?$/i.test(trimmed)) return { kind: "list_connectors" };
  const [head, ...rest] = trimmed.split(/\s+/);
  if (/^approve$/i.test(head ?? "") && rest.length > 0) return { kind: "approve" };
  if (/^share$/i.test(head ?? "") && rest.length > 0) return { kind: "share" };
  if (/^connect/i.test(head ?? "")) {
    // "connect service", "connect-service", "connect a and b" — targets are everything after the
    // verb (or the verb's own suffix for the hyphenated form), split on list separators.
    const inline = head!.replace(/^connect[-:]?/i, "");
    const targets = [inline, ...rest].filter(Boolean).join(" ").trim()
      .split(/\s*(?:,|&|\band\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
    return targets.length > 0 ? { kind: "connect", targets } : { kind: "help" };
  }
  return { kind: "investigate" };
}

export async function classifyIntent(
  text: string,
  context: IntentContext,
  client: OpenAI | null,
  model: string,
  conversationContext?: string
): Promise<SlackIntent> {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "help" };
  if (!client) return heuristicIntent(trimmed);

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        {
          role: "system",
          content:
            `Connected sources for this user: ${context.connected.length > 0 ? context.connected.join(", ") : "(none)"}\n` +
            `Connectable services on this deployment:\n${context.connectableSummary}`
        },
        ...(conversationContext ? [{
          role: "system" as const,
          content: `Recent messages in this Slack thread, oldest first (context for reading the new message):\n${conversationContext.slice(-3000)}`
        }] : []),
        { role: "user", content: trimmed }
      ]
    });
    const parsed = safeParse(response.choices[0]?.message?.content ?? "");
    const kind = typeof parsed?.kind === "string" && INTENT_KINDS.has(parsed.kind) ? parsed.kind : null;
    if (!kind) return heuristicIntent(trimmed);

    const acknowledgement = typeof parsed!.acknowledgement === "string" && parsed!.acknowledgement.trim()
      ? parsed!.acknowledgement.trim().slice(0, 300)
      : undefined;
    if (kind === "connect") {
      const rawTargets = Array.isArray(parsed!.targets)
        ? parsed!.targets
        : typeof (parsed as Record<string, unknown>).target === "string"
          ? [(parsed as Record<string, unknown>).target]
          : [];
      const targets = rawTargets
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim())
        .slice(0, 5);
      // A connect with no discernible target is unactionable — treat as help so the user gets usage.
      return targets.length > 0 ? { kind: "connect", targets, ...(acknowledgement ? { acknowledgement } : {}) } : { kind: "help" };
    }
    if (kind === "investigate") {
      const relevantSources = Array.isArray(parsed!.relevantSources)
        ? parsed!.relevantSources.filter((id): id is string => typeof id === "string" && context.connected.includes(id))
        : undefined;
      return { kind: "investigate", relevantSources, ...(acknowledgement ? { acknowledgement } : {}) };
    }
    return { kind, ...(acknowledgement ? { acknowledgement } : {}) } as SlackIntent;
  } catch (error) {
    if (error instanceof LlmCapacityExhausted) throw error;
    console.warn("Intent classification failed; falling back to the deterministic parse.", error);
    return heuristicIntent(trimmed);
  }
}
