import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { StoredServiceToken } from "../state/repositories.js";
import { truncate } from "../connectors/connectorUtils.js";
import type { EvidenceItem } from "../types/schemas.js";
import { ConnectionAccessError } from "../core/context.js";
import type { DynamicServiceSpec, DynamicTool } from "./dynamicSpec.js";

const RESPONSE_CHAR_LIMIT = 12_000;
const LEAF_STRING_LIMIT = 160;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Provider payloads bury the useful fields under opaque bulk — icon hashes, permission
 * bitfields, feature flags. Blind tail-truncation used to silently eat the later items of a
 * list (ask for 12 servers, the model sees 7 and bluffs about the rest). Shrinking long leaf
 * strings first keeps every array element and every field name intact; only after that does
 * the hard cap apply, and when it fires it says so instead of cutting mid-item.
 */
export function compactResponse(text: string, limit = RESPONSE_CHAR_LIMIT): string {
  let output = text;
  if (text.length > limit) {
    try {
      const parsed = JSON.parse(text) as unknown;
      for (const leafLimit of [LEAF_STRING_LIMIT, 60, 24]) {
        output = JSON.stringify(shrinkLeaves(parsed, leafLimit));
        if (output.length <= limit) break;
      }
    } catch {
      // Not JSON — nothing structural to preserve; the plain cap below handles it.
    }
  }
  if (output.length > limit) {
    return `${output.slice(0, limit - 70).trimEnd()} …[response truncated — refine the query to retrieve the rest]`;
  }
  return output;
}

function shrinkLeaves(value: unknown, leafLimit: number): unknown {
  if (typeof value === "string") {
    return value.length > leafLimit ? `${value.slice(0, leafLimit - 1)}…` : value;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkLeaves(item, leafLimit));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, shrinkLeaves(child, leafLimit)]));
  }
  return value;
}

/**
 * Executes a synthesized integration's tools. This is the sandbox that makes LLM-drafted specs
 * safe to run: GET-only, https-only, and the final request host must be one the spec declared
 * (and the setup form disclosed) — a placeholder value can never steer a request to a new host
 * because path substitutions are URI-encoded and the host is re-checked after building the URL.
 * Results go back to the model truncated, plus one evidence item so conclusions stay citable.
 */
export class DynamicToolProvider implements AgentToolProvider {
  constructor(
    private readonly spec: DynamicServiceSpec,
    private readonly token: StoredServiceToken,
    private readonly connectionId = `${spec.id}:unknown`,
    private readonly ownerUserId = "unknown"
  ) {}

  async listAgentTools(): Promise<ChatCompletionTool[]> {
    return this.spec.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: this.qualifiedName(tool),
        description: `[${this.spec.label}] ${tool.description}`,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.params.map((param) => [param.name, { type: "string", description: param.description }])
          ),
          required: tool.params.filter((param) => param.required).map((param) => param.name)
        }
      }
    }));
  }

  has(name: string): boolean {
    return this.spec.tools.some((tool) => this.qualifiedName(tool) === name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.spec.tools.find((candidate) => this.qualifiedName(candidate) === name);
    if (!tool) return { error: `Unknown ${this.spec.label} tool: ${name}` };
    try {
      const url = this.buildUrl(tool, args);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.status === 401 || response.status === 403) {
        // Providers put the real reason in the body — paywalls ("premium subscription required"),
        // missing scopes, dev-mode allowlists. Relay it verbatim so the agent tells the user the
        // truth instead of guessing "reconnect" (a 403 is usually NOT a login problem).
        const reason = (await response.text()).slice(0, 300);
        throw new ConnectionAccessError(
          response.status === 401 ? "authorization_required" : "scope_missing",
          `${this.spec.label} refused access${reason ? `: ${reason}` : "."}`,
          this.connectionId,
          this.ownerUserId
        );
      }
      if (!response.ok) return { error: `${this.spec.label} returned HTTP ${response.status}.` };
      const body = compactResponse(await response.text());
      return { data: body, evidence: [this.toEvidence(tool, url, truncate(body, 2800))] };
    } catch (error) {
      if (error instanceof ConnectionAccessError) throw error;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Namespaced so two services' synthesized tools can never collide. */
  private qualifiedName(tool: DynamicTool): string {
    return `connection_${this.connectionId.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool.name}`.slice(0, 64);
  }

  private buildUrl(tool: DynamicTool, args: Record<string, unknown>): string {
    let template = tool.urlTemplate;
    const query = new URLSearchParams();

    const substitutions: Record<string, string> = { accountId: this.token.accountId ?? "" };
    for (const param of tool.params) {
      const value = args[param.name];
      const text = value === undefined || value === null ? "" : String(value);
      if (!text) {
        if (param.required) throw new Error(`Parameter ${param.name} is required.`);
        continue;
      }
      if (param.location === "path") substitutions[param.name] = text;
      else query.set(param.name, text);
    }
    template = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = substitutions[key];
      if (value === undefined || value === "") throw new Error(`No value available for {${key}} in the request path.`);
      return encodeURIComponent(value);
    });

    const url = new URL(template);
    for (const [key, value] of query) url.searchParams.set(key, value);
    if (url.protocol !== "https:" || !this.spec.apiHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase())) {
      throw new Error(`Refusing request to undeclared host ${url.hostname}.`);
    }
    return url.toString();
  }

  private toEvidence(tool: DynamicTool, url: string, body: string): EvidenceItem {
    return {
      id: `${this.connectionId}:${tool.name}:${Date.now().toString(36)}`,
      source: this.spec.id,
      title: `${this.spec.label}: ${tool.name.replace(/_/g, " ")}`,
      body: body || `${this.spec.label} returned an empty response.`,
      url,
      timestamp: new Date().toISOString(),
      entities: [this.spec.label, this.ownerUserId],
      tags: [this.spec.id, "live-api"],
      confidence: 0.85
    };
  }
}
