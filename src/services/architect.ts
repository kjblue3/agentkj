import type OpenAI from "openai";
import { safeFetch } from "../security/publicUrl.js";
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
    "accountLabelPath": "dot.path to a human account name in the token response, if present",
    "clientIdPattern": "regex every valid client id for this provider fully matches (e.g. \\\\d{17,20} for numeric snowflake ids) — include ONLY when the documented shape is unmistakable; a wrong pattern locks admins out, so omit when unsure",
    "clientIdHint": "one short phrase: what the client id looks like and which settings field to copy it from"
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
- NEVER derive endpoint URLs from the product's name ("dashboard.<product>.com", "api.<product>.ai") — if you cannot recall the provider's actual documented OAuth endpoints, that means the integration cannot be built: reply {"error": ...}. Many well-known products (AI assistants, API-key-only platforms, consumer apps without developer programs) have NO user OAuth2 API — refuse those explicitly.
- Paywalls: if there is NO free way to access this API at all (paid developer program, subscription-only API), reply {"error": "<say plainly that the API is paywalled and what it costs/requires>"} instead of a spec. If only SOME relevant data is behind a paid plan, still build the free-tier tools and state what's gated in "accessNotes".
- READ-ONLY: request no write scopes; tools are GET only.
- 2 to 5 tools, chosen for answering a user's questions about THEIR OWN data in the service.
- Ensure refresh tokens where the provider supports it (e.g. offline access params).
- Every URL's hostname must appear in apiHosts. JSON only, no prose.`;

export type ArchitectResult = { spec: DynamicServiceSpec } | { error: string };

/**
 * Reality check for a drafted spec: the model can hallucinate plausible-sounding hosts for
 * products that have no OAuth API at all (a "dashboard.<product>.ai" that doesn't exist). A
 * fabricated authorize endpoint either fails DNS or 404s; a real one answers something (200,
 * 302, or a 4xx complaining about missing params). Returns an error string, or null when the
 * endpoints appear real. Uses safeFetch so probes carry the same SSRF protections as all other
 * outbound traffic.
 */
export async function verifySpecEndpoints(spec: DynamicServiceSpec): Promise<string | null> {
  for (const [label, url] of [
    ["authorization endpoint", spec.oauth.authorizeUrl],
    ["token endpoint", spec.oauth.tokenUrl]
  ] as const) {
    try {
      const response = await safeFetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
      if (response.status === 404) {
        return `its drafted ${label} (${url}) doesn't exist — this product likely has no public OAuth2 API`;
      }
    } catch {
      return `its drafted ${label} (${url}) is unreachable — this product likely has no public OAuth2 API`;
    }
  }
  return null;
}

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
