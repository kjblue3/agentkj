import { readFileSync } from "node:fs";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import { StdioMcpClient, type McpToolClient } from "../connectors/mcpClient.js";
import { redactSecrets } from "../security/redaction.js";

/**
 * Generic, pluggable MCP connector registry. This is what makes "our users can tack on
 * products we've never heard of" cheap: any MCP server that follows the spec self-describes
 * its own tools (name, description, JSON-Schema input) via `tools/list`. We spawn it, read
 * that description, namespace the tool names so two servers can't collide, and hand the whole
 * union to the agent (src/agent/investigator.ts) as ordinary tool schemas. Adding a new product
 * is then a config entry, not new TypeScript.
 *
 * SECURITY: a stdio MCP "server" is an arbitrary local command (`spawn(..., {shell:true})` in
 * mcpClient.ts). Letting end users register arbitrary commands on a shared host is remote code
 * execution. This registry itself is transport-agnostic re: *where* specs come from — the admin
 * config loader below (loadGlobalServerSpecs) is safe because only an admin edits mcp.json/env.
 * Per-user self-service (src/mcp/catalog.ts) must NEVER accept a free-form command from a user —
 * it only lets them pick a vetted catalog entry and submit setup values through a backend form.
 * Free-form local specs
 * are fine for a single-user self-hosted install, never for a shared multi-tenant deployment.
 */

export interface McpServerSpec {
  /** Namespace prefix for this server's tools, e.g. "sheets" -> "sheets__read_range". */
  name: string;
  command: string;
  /** Per-user credentials, passed only to this server's own child process env — never process-wide. */
  env?: Record<string, string>;
}

interface NamespacedTool {
  serverName: string;
  originalName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpToolRegistry implements AgentToolProvider {
  private readonly clients = new Map<string, McpToolClient>();
  private readonly secretsByServer = new Map<string, string[]>();
  private readonly tools = new Map<string, NamespacedTool>();
  private discovered = false;

  constructor(private readonly specs: McpServerSpec[]) {
    for (const spec of specs) {
      this.clients.set(spec.name, new StdioMcpClient(spec.command, undefined, spec.env ?? {}));
      this.secretsByServer.set(spec.name, Object.values(spec.env ?? {}));
    }
  }

  /** Discovers tools from every configured server in parallel. Safe to call more than once. */
  async discover(): Promise<void> {
    if (this.discovered) return;
    await Promise.all(
      this.specs.map(async (spec) => {
        const client = this.clients.get(spec.name);
        if (!client) return;
        try {
          const tools = await client.listTools();
          for (const tool of tools) {
            const namespaced = `${spec.name}__${tool.name}`;
            this.tools.set(namespaced, {
              serverName: spec.name,
              originalName: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            });
          }
        } catch (error) {
          console.warn(`MCP registry: failed to discover tools from "${spec.name}".`, error);
        }
      })
    );
    this.discovered = true;
  }

  /** Flat tool list, in the shape the agent's tool-calling loop expects. */
  async listAgentTools(): Promise<ChatCompletionTool[]> {
    await this.discover();
    return [...this.tools.entries()].map(([namespacedName, tool]) => ({
      type: "function" as const,
      function: {
        name: namespacedName,
        description: tool.description ?? `Tool "${tool.originalName}" from the "${tool.serverName}" connector.`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} }
      }
    }));
  }

  /** True if this registry recognizes a (namespaced) tool name, so callers can route dispatch. */
  has(namespacedName: string): boolean {
    return this.tools.has(namespacedName);
  }

  async call(namespacedName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(namespacedName);
    if (!tool) return { error: `Unknown connector tool: ${namespacedName}` };
    const client = this.clients.get(tool.serverName);
    if (!client) return { error: `Connector "${tool.serverName}" is not running.` };
    const result = await client.callTool(tool.originalName, args);
    return {
      connectorResult: redactSecrets(result, this.secretsByServer.get(tool.serverName)),
      security: "Connector output is treated as untrusted data; configured secrets are redacted before model use."
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
  }
}

/**
 * Admin/global tier: servers available to every user, configured once by whoever runs the
 * deployment. Source is either MCP_SERVERS (JSON env var) or an mcp.json file at repo root.
 * Never derived from user input.
 */
export function loadGlobalServerSpecs(env: NodeJS.ProcessEnv = process.env): McpServerSpec[] {
  if (env.MCP_SERVERS) {
    try {
      const parsed = JSON.parse(env.MCP_SERVERS) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isServerSpec);
    } catch (error) {
      console.warn("MCP_SERVERS is not valid JSON; ignoring.", error);
    }
  }

  try {
    const raw = readFileSync(new URL("../../mcp.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { servers?: unknown };
    if (Array.isArray(parsed.servers)) return parsed.servers.filter(isServerSpec);
  } catch {
    // mcp.json is optional; absence is normal, not an error.
  }

  return [];
}

function isServerSpec(value: unknown): value is McpServerSpec {
  const record = value as Record<string, unknown>;
  return Boolean(record) && typeof record.name === "string" && typeof record.command === "string";
}
