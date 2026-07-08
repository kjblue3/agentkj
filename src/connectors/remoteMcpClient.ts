import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTool, McpToolClient } from "./mcpClient.js";
import { safeFetch, validatePublicUrl } from "../security/publicUrl.js";

export class RemoteMcpClient implements McpToolClient {
  private client: Client | undefined;
  private connected: Promise<Client> | undefined;

  constructor(
    private readonly url: string,
    private readonly bearerToken?: string
  ) {}

  async listTools(): Promise<McpTool[]> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations as McpTool["annotations"],
      requiredScopes: requiredScopes(tool._meta)
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    return client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = undefined;
    if (client) await client.close();
  }

  private ensureConnected(): Promise<Client> {
    if (!this.connected) this.connected = this.connect();
    return this.connected;
  }

  private async connect(): Promise<Client> {
    const url = await validatePublicUrl(this.url);
    const client = new Client({ name: "agentkj", version: "1.0.0" });
    const headers = new Headers();
    if (this.bearerToken) headers.set("Authorization", `Bearer ${this.bearerToken}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: safeTransportFetch
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

function safeTransportFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (input instanceof Request) {
    return safeFetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      ...init
    });
  }
  return safeFetch(input, init);
}

function requiredScopes(meta: Record<string, unknown> | undefined): string[] {
  const value = meta?.requiredScopes ?? meta?.required_scopes;
  return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === "string") : [];
}
