/**
 * Vetted catalog for self-service, per-user MCP connectors (Part 3, security model "a" from
 * the plan). Users pick an entry here and supply only credentials — never a free-form command
 * — so a user can never get this server to spawn arbitrary code on a shared host. Add new
 * products by adding a vetted entry here, not by accepting user-typed commands.
 */

export interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  /** Fixed, vetted command — never derived from user input. */
  command: string;
  /** Env var names the user must supply (e.g. an API token, a folder id). Values are theirs. */
  credentialFields: string[];
}

export const mcpCatalog: McpCatalogEntry[] = [
  {
    id: "filesystem",
    label: "Local filesystem (read-only)",
    description: "Lets the agent read files under a directory you choose. Good for validating the connect flow.",
    command: "npx -y @modelcontextprotocol/server-filesystem",
    credentialFields: ["MCP_FS_ROOT"]
  }
  // Real self-service products (Sheets, Notion, Forms, Linear, ...) get added here once vetted.
  // Each entry stays a fixed `command` — only `credentialFields` vary per user.
];

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return mcpCatalog.find((entry) => entry.id === id);
}

export function describeCatalog(): string {
  return mcpCatalog
    .map((entry) => `• \`${entry.id}\` — ${entry.label}: ${entry.description} (needs: ${entry.credentialFields.join(", ")})`)
    .join("\n");
}
