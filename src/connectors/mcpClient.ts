import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioMcpClient implements McpToolClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly command: string,
    private readonly requestTimeoutMs = 20_000,
    /**
     * Extra env vars merged over process.env for this server's own child process only.
     * Lets two per-user MCP clients (e.g. two users' own Sheets credentials) run as separate
     * processes with isolated env instead of colliding in the shared process.env.
     */
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    const tools = asRecord(result).tools;
    if (!Array.isArray(tools)) return [];

    return tools
      .map((tool): McpTool | null => {
        const record = asRecord(tool);
        if (typeof record.name !== "string") return null;
        const inputSchema = asRecord(record.inputSchema ?? record.input_schema);
        return {
          name: record.name,
          description: typeof record.description === "string" ? record.description : undefined,
          inputSchema: Object.keys(inputSchema).length > 0 ? inputSchema : undefined
        };
      })
      .filter((tool): tool is McpTool => tool !== null);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.startAndInitialize();
    }
    return this.initialized;
  }

  private async startAndInitialize(): Promise<void> {
    this.child = spawn(this.command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.extraEnv }
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`GitHub MCP stderr: ${text}`);
    });
    this.child.on("exit", (code) => {
      const error = new Error(`GitHub MCP server exited with code ${code ?? "unknown"}.`);
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "slack-detective", version: "1.0.0" }
    });
    this.notify("notifications/initialized", {});
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(payload);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private writeMessage(payload: unknown): void {
    if (!this.child) throw new Error("MCP server is not running.");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private readStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) return;

      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line.trim()) continue;

      try {
        this.handleMessage(JSON.parse(line) as JsonRpcResponse);
      } catch {
        // MCP servers may emit non-JSON noise on stdout; ignore lines that aren't valid messages.
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "MCP request failed."));
    } else {
      pending.resolve(message.result);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
