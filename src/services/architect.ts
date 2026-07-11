import type OpenAI from "openai";
import { dynamicServiceSpecSchema, type DynamicServiceSpec } from "./dynamicSpec.js";

/**
 * The service architect: asked to connect a service nobody wrote code for, the agent drafts the
 * integration itself — OAuth endpoints, scopes, and a few read-only REST tools it knows from
 * training — as a DynamicServiceSpec. The draft is hard-validated (schema + host pinning) and
 * gets one repair round with the validator's complaints before giving up. Honesty over
 * invention: a service the model doesn't confidently know yields {error}, never guessed URLs.
 */

const ARCHITECT_PROMPT = `You design a read-only API integration for a well-known public service, as strict JSON matching:

{
  "id": "kebab-case-slug",
  "label": "Display Name",
  "aliases": ["names people call it", "its main hostname"],
  "domain": "what user data lives here, one sentence fragment (drives question routing)",
  "homepage": "https://...",
  "apiHosts": ["every hostname the integration touches: OAuth endpoints AND tool endpoints"],
  "oauth": {
    "authorizeUrl": "https://... (the service's real OAuth2 authorization endpoint)",
    "tokenUrl": "https://... (the real token endpoint)",
    "scope": "minimal READ-ONLY scopes, space or comma separated per the provider's convention",
    "extraAuthParams": { "provider-required authorize params, e.g. access_type/prompt/approval_prompt": "..." },
    "accountIdPath": "dot.path into the token response for the account id, only if tools need it in URLs",
    "accountLabelPath": "dot.path to a human account name in the token response, if present"
  },
  "setupInstructions": "Where the operator creates the OAuth app (exact settings-page URL), which fields to copy, and that the redirect/callback URL to register is {CALLBACK_URL}. 2-4 sentences.",
  "accessNotes": "ONLY if parts of this API require a paid plan, subscription, or approval process: one sentence saying what's gated. Omit when the free tier covers these tools.",
  "tools": [
    {
      "name": "snake_case_tool",
      "description": "what it returns and when the agent should call it",
      "method": "GET",
      "urlTemplate": "https://host/path?fixed=params — may embed {paramName} or {accountId} in the PATH",
      "params": [{ "name": "...", "description": "...", "required": false, "location": "query" }]
    }
  ]
}

Hard rules:
- Users typo service names. Read the request as the most likely intended well-known product — a popular product one edit away beats an obscure or tangential product that shares letters — and use the intended product's proper name throughout.
- Real endpoints only, from your knowledge of the service's public API documentation. If you are not confident the service exists with a public OAuth2 + REST API, or it uses a non-OAuth2 scheme, reply {"error": "<one sentence why, and what would work instead>"} .
- Paywalls: if there is NO free way to access this API at all (paid developer program, subscription-only API), reply {"error": "<say plainly that the API is paywalled and what it costs/requires>"} instead of a spec. If only SOME relevant data is behind a paid plan, still build the free-tier tools and state what's gated in "accessNotes".
- READ-ONLY: request no write scopes; tools are GET only.
- 2 to 5 tools, chosen for answering a user's questions about THEIR OWN data in the service.
- Ensure refresh tokens where the provider supports it (e.g. offline access params).
- Every URL's hostname must appear in apiHosts. JSON only, no prose.`;

export type ArchitectResult = { spec: DynamicServiceSpec } | { error: string };

function parseCandidate(content: string | null | undefined): Record<string, unknown> | null {
  try {
    return JSON.parse(content ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function synthesizeService(
  serviceName: string,
  client: OpenAI,
  model: string
): Promise<ArchitectResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: ARCHITECT_PROMPT },
    { role: "user", content: `Design the integration for: ${serviceName}` }
  ];

  for (let round = 0; round < 2; round++) {
    let content: string | null | undefined;
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages
      });
      content = response.choices[0]?.message?.content;
    } catch (error) {
      return { error: "I couldn't reach my model backend to draft this integration. Try again in a minute." };
    }

    const candidate = parseCandidate(content);
    if (!candidate) return { error: "The drafted integration wasn't valid JSON. Try asking again." };
    if (typeof candidate.error === "string" && candidate.error.trim()) return { error: candidate.error };

    const parsed = dynamicServiceSpecSchema.safeParse(candidate);
    if (parsed.success) return { spec: parsed.data };

    // One repair round: feed the validator's complaints back verbatim.
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    messages.push({ role: "assistant", content: content ?? "" });
    messages.push({
      role: "user",
      content: `That draft failed validation (${issues}). Emit the corrected full JSON object, nothing else.`
    });
  }
  return { error: "I drafted an integration but couldn't get it past safety validation, so I won't run it." };
}
