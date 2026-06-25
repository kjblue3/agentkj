import type {
  EvidenceItem,
  InvestigationResult,
  TimelineEvent
} from "../types/schemas.js";

function sentence(body: string, pattern?: RegExp): string {
  const sentences = body.match(/[^.!?]+[.!?]+/g) ?? [body];
  return (pattern ? sentences.find((part) => pattern.test(part)) : sentences[0])?.trim() ?? body;
}

export function fallbackSynthesis(
  question: string,
  evidence: EvidenceItem[],
  timeline: TimelineEvent[]
): InvestigationResult {
  const incident = evidence.find((item) => item.source === "incident");
  const blocker = evidence.find((item) => item.tags.includes("blocked") || item.tags.includes("dependency"));
  const decision = evidence.find((item) => item.tags.includes("decision") || item.tags.includes("architecture"));
  const strongest = incident ?? blocker ?? decision ?? evidence[0];
  const rootSentence = strongest
    ? sentence(strongest.body, /root cause|blocked|chose|requires|rejected/i)
    : "The available evidence is not sufficient to name a root cause.";
  const sources = new Set(evidence.map((item) => item.source));
  const confidence =
    evidence.length >= 4 && sources.size >= 3 ? "high" : evidence.length >= 2 ? "medium" : "low";

  const lead = evidence[0];
  const corroboration = evidence.find((item) => item.source !== lead?.source);
  const shortAnswer = lead
    ? `${sentence(lead.body)}${corroboration ? ` ${sentence(corroboration.body)}` : ""}`
    : "No matching evidence was found in the demo sources.";

  const owner = evidence.find((item) => item.tags.includes("owner"));
  const openQuestions = evidence.length
    ? [
        owner ? `Has ${owner.body.match(/([A-Z][A-Za-z ]+) still owns?/)?.[1] ?? "the current owner"} scheduled the next review?` : "Who owns the remaining follow-up work?",
        "Are the prevention controls now covered by an automated test or alert?"
      ]
    : ["Which project, service, or time range should the search target?"];

  return {
    question,
    shortAnswer,
    confidence,
    likelyRootCause: rootSentence,
    timeline,
    evidence,
    openQuestions,
    recommendedActions: [
      "Confirm the causal chain with the named service or project owner.",
      "Track the prevention item to completion with a measurable acceptance test.",
      "Link this report from the relevant incident, ticket, or architecture record."
    ]
  };
}
