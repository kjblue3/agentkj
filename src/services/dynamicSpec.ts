import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateFilePath } from "../config/state.js";

/**
 * A service integration synthesized by the agent at runtime (src/services/architect.ts) —
 * pure data, validated hard, persisted under STATE_DIR. This is how the codebase stays free of
 * product names: nothing here knows which product a spec describes; the LLM drafts the spec
 * when a user first asks to connect the service, and the generic machinery (serviceOAuth,
 * DynamicToolProvider) executes it.
 *
 * Security posture: a spec can only be executed inside the box it declares up front —
 * https-only, GET-only tools, every request host pinned to `apiHosts` (which the setup form
 * discloses to the human who approves the integration by entering its credentials).
 */

const hostSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "must be a bare hostname");

const httpsUrl = z.string().url().startsWith("https://");

export const dynamicToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  description: z.string().min(12).max(400),
  method: z.literal("GET"),
  /** May contain `{paramName}` and `{accountId}` placeholders in the path. */
  urlTemplate: httpsUrl,
  params: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z_][\w.-]*$/),
        description: z.string().min(3).max(300),
        required: z.boolean().default(false),
        location: z.enum(["query", "path"]).default("query")
      })
    )
    .default([])
});

export const dynamicServiceSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    label: z.string().min(2).max(60),
    aliases: z.array(z.string().min(2).max(60)).min(1).max(10),
    /** What kind of data lives here — used for intent relevance and connect resolution. */
    domain: z.string().min(10).max(300),
    homepage: httpsUrl,
    /** Every host this integration may contact: OAuth endpoints and all tool endpoints. */
    apiHosts: z.array(hostSchema).min(1).max(8),
    oauth: z.object({
      authorizeUrl: httpsUrl,
      tokenUrl: httpsUrl,
      scope: z.string().max(300).optional(),
      extraAuthParams: z.record(z.string(), z.string()).default({}),
      /** Dot-path into the token response for the provider-side account id (e.g. "athlete.id"). */
      accountIdPath: z.string().max(80).optional(),
      accountLabelPath: z.string().max(80).optional()
    }),
    /** Shown on the setup form: where to create the provider's OAuth app. May reference {CALLBACK_URL}. */
    setupInstructions: z.string().min(20).max(1500),
    tools: z.array(dynamicToolSchema).min(1).max(6)
  })
  .superRefine((spec, ctx) => {
    const hosts = new Set(spec.apiHosts.map((host) => host.toLowerCase()));
    const requireListedHost = (url: string, where: string) => {
      const hostname = new URL(url).hostname.toLowerCase();
      if (!hosts.has(hostname)) {
        ctx.addIssue({ code: "custom", message: `${where} host ${hostname} is not declared in apiHosts` });
      }
    };
    requireListedHost(spec.oauth.authorizeUrl, "authorizeUrl");
    requireListedHost(spec.oauth.tokenUrl, "tokenUrl");
    for (const tool of spec.tools) {
      // The template must parse as a URL with placeholders intact, and its host must be literal
      // (no placeholder may sit in the authority section) and declared.
      const authorityEnd = spec ? tool.urlTemplate.indexOf("/", "https://".length) : -1;
      const authority = authorityEnd === -1 ? tool.urlTemplate.slice("https://".length) : tool.urlTemplate.slice("https://".length, authorityEnd);
      if (authority.includes("{")) {
        ctx.addIssue({ code: "custom", message: `tool ${tool.name} has a placeholder in its hostname` });
        continue;
      }
      requireListedHost(tool.urlTemplate.replace(/\{[^}]+\}/g, "placeholder"), `tool ${tool.name}`);
    }
  });

export type DynamicServiceSpec = z.infer<typeof dynamicServiceSpecSchema>;
export type DynamicTool = z.infer<typeof dynamicToolSchema>;

const STORE_PATH = stateFilePath("dynamicServices.local.json");

function loadRaw(): Record<string, unknown> {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    console.warn("Dynamic service store unreadable; starting empty.", error);
  }
  return {};
}

/** Re-validated on every load so a hand-edited or corrupted store entry can never execute. */
export function loadDynamicSpecs(): DynamicServiceSpec[] {
  const specs: DynamicServiceSpec[] = [];
  for (const raw of Object.values(loadRaw())) {
    const parsed = dynamicServiceSpecSchema.safeParse(raw);
    if (parsed.success) specs.push(parsed.data);
    else console.warn("Dropping invalid dynamic service spec from store.", parsed.error.issues[0]?.message);
  }
  return specs;
}

export function saveDynamicSpec(spec: DynamicServiceSpec): void {
  const all = loadRaw();
  all[spec.id] = spec;
  try {
    mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(all, null, 2));
  } catch (error) {
    console.warn("Dynamic service store write failed; the integration won't survive a restart.", error);
  }
}

/** Reads a dot-path ("athlete.id") out of a JSON payload; returns a string or undefined. */
export function dotPath(payload: unknown, pathExpr: string | undefined): string | undefined {
  if (!pathExpr) return undefined;
  let cursor: unknown = payload;
  for (const key of pathExpr.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor === "string" && cursor.trim()) return cursor;
  if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  return undefined;
}
