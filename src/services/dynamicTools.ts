import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { ServiceToken } from "../auth/tokenStore.js";
import { truncate } from "../connectors/connectorUtils.js";
import type { EvidenceItem } from "../types/schemas.js";
import type { DynamicServiceSpec, DynamicTool } from "./dynamicSpec.js";

const RESPONSE_CHAR_LIMIT = 3500;
const REQUEST_TIMEOUT_MS = 15_000;

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
    private readonly token: ServiceToken
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
        return { error: `${this.spec.label} rejected the stored token (HTTP ${response.status}). The user should reconnect ${this.spec.label}.` };
      }
      if (!response.ok) return { error: `${this.spec.label} returned HTTP ${response.status}.` };
      const body = truncate(await response.text(), RESPONSE_CHAR_LIMIT);
      return { data: body, evidence: [this.toEvidence(tool, url, body)] };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Namespaced so two services' synthesized tools can never collide. */
  private qualifiedName(tool: DynamicTool): string {
    return `${this.spec.id.replace(/-/g, "_")}__${tool.name}`;
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
      id: `${this.spec.id}:${tool.name}:${Date.now().toString(36)}`,
      source: this.spec.id,
      title: `${this.spec.label}: ${tool.name.replace(/_/g, " ")}`,
      body: body || `${this.spec.label} returned an empty response.`,
      url,
      timestamp: new Date().toISOString(),
      entities: [this.spec.label],
      tags: [this.spec.id, "live-api"],
      confidence: 0.85
    };
  }
}
