import type OpenAI from "openai";
import { LlmCapacityExhausted, llmReasoningOverride } from "../llm/client.js";

/**
 * Decides what an incoming Slack message wants — with the LLM, not keyword prefixes. Users say
 * "hey can you hook up my <service>?" or paste a link to their account page; none of that survives
 * string matching. The classifier sees the user's connected/connectable sources so it can also
 * mark which connected sources are plausibly relevant to a question (the investigation then
 * never rummages through an unrelated source).
 *
 * The deterministic parse below is strictly a degraded fallback for when no LLM is configured
 * (tests or a temporarily unavailable classifier) or the classification call itself fails.
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
      /** Exact connection owners for a personal/named-person question; undefined means workspace-wide. */
      relevantOwnerUserIds?: string[];
    }
  | { kind: "connect"; targets: string[] }
  | { kind: "list_connectors" }
  | { kind: "approve" }
  | { kind: "unsupported_action" }
  | { kind: "help" }
);

export interface IntentContext {
  requestingUserId: string;
  connections: Array<{ serviceId: string; ownerUserId: string; domain: string }>;
  /** One-line-per-service description of what is connectable, for the prompt. */
  connectableSummary: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You route one Slack message sent to an investigation agent. Reply with JSON only:
{"kind": "investigate" | "connect" | "list_connectors" | "approve" | "unsupported_action" | "help", "targets"?: string[], "relevantSources"?: string[], "relevantOwnerUserIds"?: string[]}

Rules, in priority order:
1. "approve <id> ..." is a literal bot-issued connection command — return that kind only for messages that start with the word followed by an id.
2. "connect": the user wants to link/hook up/add one or MORE services, accounts, data sources, or MCP servers — in ANY phrasing ("can you connect <name>", "add my <name> and <other> accounts", "hook this up: https://..."). Also choose connect when the message is essentially just a link to the user's own account/profile/dashboard on a service that requires login (a fitness profile, a SaaS workspace) — pasting it means they want that service's data. Set "targets" to the list of service names or URLs, one entry per service, exactly as the user referenced each. Short follow-ups count: when the message is an affirmative or elliptical reply ("then let's connect!", "yes hook it up", "ok do it") and the thread context shows a specific service was just discussed or reported as not connected, classify it connect and take that service name from the thread context as the target. Judge by meaning, not spelling — a misspelled or mangled request to link a service is still connect. But verify before choosing connect, because false positives launch real setup flows: the user must actually be asking to LINK a source; a question about a service, a mention of one, or a request to look something up IN one is investigate.
3. "list_connectors": asking what the requesting user has connected, whether their named account/service is connected, or what is available to connect. NOT follow-ups about records in an earlier answer.
4. "unsupported_action": asking the agent to create, edit, delete, send, stop, run, merge, deploy, or otherwise mutate external data, code, or processes. This agent can only read connected sources and report evidence. Questions asking what changed or why something happened are investigations, not unsupported actions.
5. "help": empty greetings, capability questions, or questions about autonomous actions.
6. Everything else is "investigate". Set "relevantSources" to the subset of connected service ids whose domains could plausibly contain the answer; return [] when none fit. For a question about "my", "mine", or the requesting user's own data, set "relevantOwnerUserIds" to only the requesting Slack user id. For a specifically named or mentioned person, select only that owner's id. Include multiple owner ids only for an explicit comparison. Omit "relevantOwnerUserIds" for workspace/team-wide questions so all authorized owners remain eligible. A public article link is investigate, not connect.

Resolve pronouns and elliptical follow-ups against the recent thread context before choosing a kind.
Never invent service ids or owner ids outside the supplied connection catalog. Never draft progress or completion copy. JSON only, no prose.`;

function safeParse(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const INTENT_KINDS = new Set(["investigate", "connect", "list_connectors", "approve", "unsupported_action", "help"]);

export function ownerScopeForText(
  text: string,
  requestingUserId: string,
  ownerUserIds: Iterable<string>
): string[] | undefined {
  const knownOwners = new Set(ownerUserIds);
  const mentioned = [...text.matchAll(/<@([A-Z0-9]+)>/gi)]
    .map((match) => match[1]!)
    .filter((id) => knownOwners.has(id));
  const selfReference = /\b(?:i|me|my|mine|myself)\b/i.test(text);
  const workspaceReference = /\b(?:our|ours|we|team|workspace|everyone|anyone|all members|organization|company)\b/i.test(text);
  if (mentioned.length > 0) {
    return [...new Set([...(selfReference && knownOwners.has(requestingUserId) ? [requestingUserId] : []), ...mentioned])];
  }
  if (selfReference && !workspaceReference) return [requestingUserId];
  return undefined;
}

/**
 * Degraded deterministic parse, used ONLY when there is no LLM to ask. Recognizes the legacy
 * command shapes so a keyless deployment still functions; free-form phrasings need the LLM.
 */
export function heuristicIntent(text: string): SlackIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "help" };
  if (/^(?:help|hi|hello|hey)$/i.test(trimmed)) return { kind: "help" };
  if (/\b(?:what can you do|autonomous actions?|your capabilities)\b/i.test(trimmed)) return { kind: "help" };
  if (/^connectors?$/i.test(trimmed)) return { kind: "list_connectors" };
  if (/^(?:is|are)\s+(?:my|mine)\b.*\bconnected\b/i.test(trimmed) || /\b(?:what|which)\b.*\b(?:do i have|have i)\b.*\bconnected\b/i.test(trimmed)) {
    return { kind: "list_connectors" };
  }
  const [head, ...rest] = trimmed.split(/\s+/);
  if (/^approve$/i.test(head ?? "") && rest.length > 0) return { kind: "approve" };
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
  if (/^(?:please\s+)?(?:implement|edit|update|delete|remove|create|commit|push|merge|send|post|stop|cancel|deploy|execute)\b/i.test(trimmed)) {
    return { kind: "unsupported_action" };
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
  const deterministic = heuristicIntent(trimmed);
  if (deterministic.kind === "unsupported_action") return deterministic;
  if (deterministic.kind === "help" && /\b(?:what can you do|autonomous actions?|your capabilities)\b/i.test(trimmed)) {
    return deterministic;
  }
  if (!client) return deterministic;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 500,
      // Routing errors are the most visible failures; give this one cheap call real thought.
      ...llmReasoningOverride("low"),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        {
          role: "system",
          content:
            `Requesting Slack user id: ${context.requestingUserId}\n` +
            `Connection catalog (service id | owner Slack user id | data domain):\n${context.connections.length > 0
              ? context.connections.map((connection) => `${connection.serviceId} | ${connection.ownerUserId} | ${connection.domain}`).join("\n")
              : "(none)"}\n` +
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
      return targets.length > 0 ? { kind: "connect", targets } : { kind: "help" };
    }
    if (kind === "investigate") {
      const knownServices = new Set(context.connections.map((connection) => connection.serviceId));
      const knownOwners = new Set(context.connections.map((connection) => connection.ownerUserId));
      const relevantSources = Array.isArray(parsed!.relevantSources)
        ? parsed!.relevantSources.filter((id): id is string => typeof id === "string" && knownServices.has(id))
        : undefined;
      const explicitOwners = ownerScopeForText(trimmed, context.requestingUserId, knownOwners);
      const classifiedOwners = Array.isArray(parsed!.relevantOwnerUserIds)
        ? parsed!.relevantOwnerUserIds.filter((id): id is string => typeof id === "string" && knownOwners.has(id))
        : undefined;
      const relevantOwnerUserIds = explicitOwners ?? (classifiedOwners && classifiedOwners.length > 0 ? [...new Set(classifiedOwners)] : undefined);
      return { kind: "investigate", relevantSources, relevantOwnerUserIds };
    }
    return { kind } as SlackIntent;
  } catch (error) {
    if (error instanceof LlmCapacityExhausted) throw error;
    console.warn("Intent classification failed; falling back to the deterministic parse.", error);
    return heuristicIntent(trimmed);
  }
}
