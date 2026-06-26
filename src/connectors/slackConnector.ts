import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import type { EvidenceConnector } from "./types.js";
import {
  buildEntities,
  buildTags,
  fetchJson,
  normalizeEvidenceItem,
  queryText,
  type FetchLike
} from "./connectorUtils.js";

interface SlackSearchResponse {
  ok: boolean;
  messages?: {
    matches?: SlackMessageMatch[];
  };
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessageMatch[];
}

interface SlackMessageMatch {
  iid?: string;
  channel?: { id?: string; name?: string } | string;
  channel_id?: string;
  user?: string;
  username?: string;
  ts?: string;
  text?: string;
  permalink?: string;
}

export class SlackConnector implements EvidenceConnector {
  readonly name = "Slack Web API";
  private readonly cache = new Map<string, EvidenceItem>();

  constructor(
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const params = new URLSearchParams({
      query: queryText(query),
      sort: "timestamp",
      sort_dir: "desc",
      count: "10"
    });
    const payload = await fetchJson<SlackSearchResponse>(
      this.fetcher,
      `https://slack.com/api/search.messages?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    if (!payload?.ok) return [];

    return (payload.messages?.matches ?? [])
      .map((message) => this.toEvidence(message, query))
      .filter((item): item is EvidenceItem => item !== null);
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const match = /^slack:([^:]+):(.+)$/.exec(id);
    if (!match) return null;
    const channel = match[1];
    const ts = match[2];
    if (!channel || !ts) return null;
    const params = new URLSearchParams({
      channel,
      latest: ts,
      inclusive: "true",
      limit: "1"
    });
    const payload = await fetchJson<SlackHistoryResponse>(
      this.fetcher,
      `https://slack.com/api/conversations.history?${params.toString()}`,
      { headers: this.headers() },
      this.name
    );
    const message = payload?.ok ? payload.messages?.[0] : undefined;
    return message ? this.toEvidence({ ...message, channel_id: channel }, undefined) : null;
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  private toEvidence(message: SlackMessageMatch, query?: InvestigationQuery): EvidenceItem | null {
    const channelId = this.channelId(message);
    const ts = message.ts;
    const text = message.text?.trim();
    if (!channelId || !ts || !text) return null;

    const item = normalizeEvidenceItem({
      id: `slack:${channelId}:${ts}`,
      source: "slack",
      title: `Slack message in ${this.channelName(message)}`,
      body: text,
      url: message.permalink ?? `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`,
      author: message.username ?? message.user,
      timestamp: ts,
      entities: query ? buildEntities(query, text, [this.channelName(message)]) : [this.channelName(message)],
      tags: query ? buildTags(query, ["slack"]) : ["slack"],
      confidence: 0.72
    });
    this.cache.set(item.id, item);
    return item;
  }

  private channelId(message: SlackMessageMatch): string | undefined {
    if (typeof message.channel === "object") return message.channel.id;
    return message.channel_id ?? (typeof message.channel === "string" ? message.channel : undefined);
  }

  private channelName(message: SlackMessageMatch): string {
    if (typeof message.channel === "object" && message.channel.name) return `#${message.channel.name}`;
    return this.channelId(message) ?? "Slack";
  }
}
