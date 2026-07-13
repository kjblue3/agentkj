import type { EvidenceConnector } from "../src/connectors/types.js";
import type { EvidenceItem, EvidenceSource, InvestigationQuery } from "../src/types/schemas.js";
import { tokenize } from "../src/utils/text.js";

/**
 * Test-only evidence corpus and connector. The product ships no bundled evidence; investigations
 * only ever see records returned by real authorized connectors. These fixtures exist so the
 * pipeline, ranking, and rendering tests have deterministic multi-source data to chew on.
 */
export class FixtureConnector implements EvidenceConnector {
  constructor(
    public readonly name: string,
    private readonly source: EvidenceSource,
    private readonly items: EvidenceItem[]
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const needles = new Set([...query.keywords, ...query.entities, ...query.tags].flatMap(tokenize));
    return this.items.filter((item) => {
      if (item.source !== this.source) return false;
      const haystack = new Set(
        tokenize(`${item.title} ${item.body} ${item.entities.join(" ")} ${item.tags.join(" ")}`)
      );
      return [...needles].some((token) => haystack.has(token));
    });
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    return this.items.find((item) => item.source === this.source && item.id === id) ?? null;
  }
}

export function createFixtureConnectors(items: EvidenceItem[] = fixtureEvidence): EvidenceConnector[] {
  const sources = [...new Set(items.map((item) => item.source))];
  return sources.map((source) => new FixtureConnector(`Fixture ${source}`, source, items));
}

const url = (source: string, id: string) => `https://fixtures.example.test/${source}/${id}`;

export const fixtureEvidence: EvidenceItem[] = [
  {
    id: "slack-checkout-1", source: "slack", title: "#checkout-alerts: p95 jumps after deploy",
    body: "Maya reports checkout p95 rose from 420ms to 2.8s within ten minutes of checkout-service v2.14.0. Traces show repeated tax_rule reads per cart item.",
    url: url("slack", "checkout-1"), author: "Maya Chen", timestamp: "2026-05-14T16:12:00.000Z",
    entities: ["checkout-service", "tax_rule", "p95"], tags: ["checkout", "latency", "database", "n+1"], confidence: 0.96
  },
  {
    id: "code-checkout-1", source: "code", title: "Change #1842: regional tax calculation",
    body: "The PR moved tax rule lookup inside the cart item loop. Review noted the query count concern, but load-test coverage for carts over 20 items was deferred.",
    url: url("code", "1842"), author: "Leo Park", timestamp: "2026-05-14T15:42:00.000Z",
    entities: ["checkout-service", "tax_rule", "PR #1842"], tags: ["checkout", "n+1", "database", "deploy"], confidence: 0.99
  },
  {
    id: "tickets-checkout-1", source: "tickets", title: "CX-771: checkout timeouts for wholesale carts",
    body: "Support linked 43 complaints to carts with many line items. Customers saw payment spinner timeouts beginning after the May 14 release.",
    url: url("tickets", "CX-771"), author: "Nina Shah", timestamp: "2026-05-14T16:35:00.000Z",
    entities: ["checkout", "wholesale carts", "CX-771"], tags: ["customer", "latency", "timeout"], confidence: 0.9
  },
  {
    id: "incident-checkout-1", source: "incident", title: "INC-204: checkout latency regression",
    body: "Incident command rolled back v2.14.0 at 17:06 UTC. p95 recovered in six minutes. Root cause was an N+1 tax_rule query introduced by PR #1842.",
    url: url("incident", "INC-204"), author: "SRE", timestamp: "2026-05-14T18:20:00.000Z",
    entities: ["checkout-service", "INC-204", "PR #1842"], tags: ["checkout", "rollback", "root-cause", "n+1"], confidence: 1
  },
  {
    id: "docs-checkout-1", source: "docs", title: "Checkout tax lookup remediation",
    body: "The permanent fix batches tax rules before iterating through cart items, adds a 50-item load test, and introduces a query-count regression gate.",
    url: url("docs", "checkout-remediation"), author: "Leo Park", timestamp: "2026-05-16T19:00:00.000Z",
    entities: ["checkout-service", "tax_rule"], tags: ["checkout", "fix", "load-test", "database"], confidence: 0.95
  },
  {
    id: "slack-recs-1", source: "slack", title: "#recs-launch: relevance versus privacy readiness",
    body: "Product wants the launch on June 2, but Data Platform says consent-filtered events are not available in the training export. Security will not approve a bypass.",
    url: url("slack", "recs-1"), author: "Avery Brooks", timestamp: "2026-05-22T17:10:00.000Z",
    entities: ["recommendations", "Data Platform", "consent events"], tags: ["recommendations", "launch", "privacy", "dependency"], confidence: 0.94
  },
  {
    id: "tickets-recs-1", source: "tickets", title: "REC-310: production launch readiness",
    body: "Launch is blocked until DP-882 supplies consent-filtered training events and the offline relevance threshold is revalidated.",
    url: url("tickets", "REC-310"), author: "Avery Brooks", timestamp: "2026-05-23T14:00:00.000Z",
    entities: ["recommendations", "REC-310", "DP-882"], tags: ["recommendations", "launch", "blocked", "dependency"], confidence: 0.98
  },
  {
    id: "code-recs-1", source: "code", title: "Change #1907: recommendations serving integration",
    body: "Review is technically complete, but approval is held because the fallback path logs raw user event IDs and the consent-aware dataset contract is unresolved.",
    url: url("code", "1907"), author: "Priya Raman", timestamp: "2026-05-24T20:30:00.000Z",
    entities: ["recommendations", "PR #1907", "DP-882"], tags: ["recommendations", "privacy", "review", "blocked"], confidence: 0.95
  },
  {
    id: "docs-recs-1", source: "docs", title: "Recommendations v1 launch plan",
    body: "The design requires consent status to be applied before training export. It explicitly rejects filtering only at serving time because deletion guarantees would be incomplete.",
    url: url("docs", "recs-v1"), author: "Priya Raman", timestamp: "2026-04-18T18:00:00.000Z",
    entities: ["recommendations", "consent status"], tags: ["recommendations", "design", "privacy", "launch"], confidence: 0.97
  },
  {
    id: "tickets-recs-2", source: "tickets", title: "DP-882: consent-aware event export",
    body: "Data Platform rescheduled delivery from May 20 to June 12 after discovering deletion events were missing from the incremental pipeline.",
    url: url("tickets", "DP-882"), author: "Morgan Lee", timestamp: "2026-05-26T16:00:00.000Z",
    entities: ["Data Platform", "DP-882", "recommendations"], tags: ["dependency", "privacy", "delay", "data"], confidence: 1
  },
  {
    id: "incident-recs-1", source: "incident", title: "Risk review: recommendations launch hold",
    body: "This was a proactive launch hold, not an outage. Release management moved launch to June 16 pending DP-882 and privacy sign-off.",
    url: url("incident", "recs-hold"), author: "Release Management", timestamp: "2026-05-27T21:00:00.000Z",
    entities: ["recommendations", "DP-882"], tags: ["launch", "delay", "privacy", "decision"], confidence: 0.96
  },
  {
    id: "docs-redis-1", source: "docs", title: "ADR-017: server-side sessions in Redis",
    body: "In 2021 the platform chose Redis over signed cookies and database sessions for immediate revocation, predictable latency, and compatibility with the existing auth gateway.",
    url: url("docs", "ADR-017"), author: "Architecture Council", timestamp: "2021-08-12T17:00:00.000Z",
    entities: ["Redis", "auth gateway", "sessions"], tags: ["sessions", "redis", "architecture", "decision"], confidence: 1
  },
  {
    id: "incident-redis-1", source: "incident", title: "INC-119: Redis failover logged out users",
    body: "A failed cluster promotion caused a 14-minute session loss. The follow-up added multi-zone replication and graceful re-authentication, but did not replace Redis.",
    url: url("incident", "INC-119"), author: "SRE", timestamp: "2024-02-03T23:00:00.000Z",
    entities: ["Redis", "sessions", "INC-119"], tags: ["sessions", "redis", "incident", "failover"], confidence: 0.99
  },
  {
    id: "slack-noise-1", source: "slack", title: "#random: office coffee machine",
    body: "The fourth-floor coffee machine is slow again. Facilities has ordered a replacement pump.",
    url: url("slack", "coffee"), author: "Taylor", timestamp: "2026-05-20T17:00:00.000Z",
    entities: ["office"], tags: ["facilities"], confidence: 0.8
  }
];

export const fixtureQuestions = [
  "Why did checkout latency spike?",
  "Why was the recommendations launch delayed?"
];
