import type OpenAI from "openai";

/**
 * Decides what an incoming Slack message wants — with the LLM, not keyword prefixes. Users say
 * "hey can you hook up my strava?" or paste a link to their account page; none of that survives
 * string matching. The classifier sees the user's connected/connectable sources so it can also
 * mark which connected sources are plausibly relevant to a question (the investigation then
 * never rummages through an unrelated source, e.g. GitHub for a workout question).
 *
 * The deterministic parse below is strictly a degraded fallback for when no LLM is configured
 * (tests, keyless demo mode) or the classification call itself fails — never the primary path.
 */

export type SlackIntent =
  | {
      kind: "investigate";
      /**
       * Connected source ids that could plausibly hold the answer. Undefined means "no signal"
       * (fallback path — don't gate anything); an empty array means the classifier judged NONE
       * of the connected sources relevant.
       */
      relevantSources?: string[];
    }
  | { kind: "connect"; target: string }
  | { kind: "list_connectors" }
  | { kind: "approve" }
  | { kind: "share" }
  | { kind: "help" };

export interface IntentContext {
  /** Source ids the user already connected (e.g. ["github", "strava", "filesystem"]). */
  connected: string[];
  /** One-line-per-service description of what is connectable, for the prompt. */
  connectableSummary: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You route one Slack message sent to an investigation agent. Reply with JSON only:
{"kind": "investigate" | "connect" | "list_connectors" | "approve" | "share" | "help", "target"?: string, "relevantSources"?: string[]}

Rules, in priority order:
1. "approve <id> ..." and "share <id> ..." are literal bot-issued commands — return those kinds only for messages that start with those words followed by an id.
2. "connect": the user wants to link/hook up/add a service, account, data source, or MCP server — in ANY phrasing ("can you connect strava", "add my notion", "hook this up: https://..."). Also choose connect when the message is essentially just a link to the user's own account/profile/dashboard on a service that requires login (a fitness profile, a SaaS workspace) — pasting it means they want that service's data. Set "target" to the service name or the URL, exactly as the user referenced it.
3. "list_connectors": asking what is connected or available to connect.
4. "help": empty greetings, "what can you do".
5. Everything else is "investigate": a question or task to research. Set "relevantSources" to the subset of the user's CONNECTED sources that could plausibly contain the answer, judged by each source's data domain — include a source only if the question's subject matter matches it; return [] when none fit. A plain public article link to read counts as investigate, not connect.

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
  if (/^connectors?$/i.test(trimmed)) return { kind: "list_connectors" };
  const [head, ...rest] = trimmed.split(/\s+/);
  if (/^approve$/i.test(head ?? "") && rest.length > 0) return { kind: "approve" };
  if (/^share$/i.test(head ?? "") && rest.length > 0) return { kind: "share" };
  if (/^connect/i.test(head ?? "")) {
    // "connect github", "connect-github", "connect to my strava" — target is everything after
    // the verb (or the verb's own suffix for the hyphenated form).
    const inline = head!.replace(/^connect[-:]?/i, "");
    const target = [inline, ...rest].filter(Boolean).join(" ").trim();
    return target ? { kind: "connect", target } : { kind: "help" };
  }
  return { kind: "investigate" };
}

export async function classifyIntent(
  text: string,
  context: IntentContext,
  client: OpenAI | null,
  model: string
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
        { role: "user", content: trimmed }
      ]
    });
    const parsed = safeParse(response.choices[0]?.message?.content ?? "");
    const kind = typeof parsed?.kind === "string" && INTENT_KINDS.has(parsed.kind) ? parsed.kind : null;
    if (!kind) return heuristicIntent(trimmed);

    if (kind === "connect") {
      const target = typeof parsed!.target === "string" ? parsed!.target.trim() : "";
      // A connect with no discernible target is unactionable — treat as help so the user gets usage.
      return target ? { kind: "connect", target } : { kind: "help" };
    }
    if (kind === "investigate") {
      const relevantSources = Array.isArray(parsed!.relevantSources)
        ? parsed!.relevantSources.filter((id): id is string => typeof id === "string" && context.connected.includes(id))
        : undefined;
      return { kind: "investigate", relevantSources };
    }
    return { kind } as SlackIntent;
  } catch (error) {
    console.warn("Intent classification failed; falling back to the deterministic parse.", error);
    return heuristicIntent(trimmed);
  }
}
