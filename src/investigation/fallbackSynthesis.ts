import type {
  EvidenceItem,
  InvestigationResult,
  TimelineEvent
} from "../types/schemas.js";
import { splitSentences } from "../utils/text.js";

function sentence(body: string, pattern?: RegExp): string {
  const sentences = splitSentences(body);
  return (pattern ? sentences.find((part) => pattern.test(part)) : sentences[0]) ?? body;
}

function hasTag(evidence: EvidenceItem[], tag: string): boolean {
  return evidence.some((item) => item.tags.includes(tag));
}

function hasEntity(evidence: EvidenceItem[], entity: string): boolean {
  return evidence.some((item) =>
    item.entities.some((candidate) => candidate.toLowerCase() === entity.toLowerCase())
  );
}

function topicLabel(evidence: EvidenceItem[]): string {
  if (hasEntity(evidence, "Redis") && hasEntity(evidence, "sessions")) {
    return "Redis session";
  }
  if (hasEntity(evidence, "checkout") || hasEntity(evidence, "checkout-service")) {
    return "checkout";
  }
  if (hasEntity(evidence, "recommendations")) {
    return "recommendations launch";
  }

  const entity = evidence
    .flatMap((item) => item.entities)
    .find((candidate) => !/^(p95|inc-|pr #|issue #|[A-Z]+-\d+)/i.test(candidate));
  return entity ?? "system";
}

function buildOpenQuestions(evidence: EvidenceItem[]): string[] {
  if (evidence.length === 0) {
    return ["Which project, service, or time range should the search target?"];
  }

  const topic = topicLabel(evidence);
  const questions = [`Who owns the next ${topic} architecture review?`];

  if (hasTag(evidence, "revocation")) {
    questions.push(
      `What design would preserve 60-second revocation without requiring ${hasEntity(evidence, "Redis") ? "Redis" : "the current system"}?`
    );
  } else if (hasTag(evidence, "dependency") || hasTag(evidence, "blocked")) {
    questions.push(`What would remove the remaining dependency blocking the ${topic}?`);
  } else if (hasTag(evidence, "latency") || hasTag(evidence, "n+1")) {
    questions.push(`What automated guard would prevent another ${topic} performance regression?`);
  } else {
    questions.push(`Which constraint is preventing a simpler ${topic} design?`);
  }

  if (hasTag(evidence, "failover")) {
    questions.push(
      `${hasEntity(evidence, "Redis") ? "Are Redis" : `Are ${topic}`} failover protections now covered by automated tests or alerts?`
    );
  } else {
    questions.push(
      `Are ${topic} prevention controls now covered by automated tests or alerts?`
    );
  }

  return questions;
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

  const openQuestions = buildOpenQuestions(evidence);

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
