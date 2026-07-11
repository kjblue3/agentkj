import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { stateDirectory } from "../config/state.js";

let memo: Database.Database | undefined;

export function stateDatabase(env: NodeJS.ProcessEnv = process.env): Database.Database {
  if (memo) return memo;
  const filename = env.STATE_DB_PATH?.trim() || path.join(stateDirectory(env), "agentkj.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true });
  memo = new Database(filename);
  memo.pragma("journal_mode = WAL");
  memo.pragma("foreign_keys = ON");
  memo.pragma("busy_timeout = 5000");
  migrate(memo);
  migrateLegacyState(memo, path.dirname(filename), env);
  return memo;
}

export function closeStateDatabase(): void {
  memo?.close();
  memo = undefined;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_specs (
      id TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_service_configs (
      workspace_id TEXT NOT NULL,
      service_id TEXT NOT NULL REFERENCES service_specs(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      client_secret_encrypted TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      configured_by TEXT NOT NULL,
      configured_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, service_id)
    );
    CREATE TABLE IF NOT EXISTS service_tokens (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      service_id TEXT NOT NULL REFERENCES service_specs(id) ON DELETE CASCADE,
      token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at TEXT,
      account_id TEXT,
      account_label TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      health TEXT NOT NULL DEFAULT 'ready',
      connected_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id, service_id)
    );
    CREATE INDEX IF NOT EXISTS service_tokens_workspace_service
      ON service_tokens(workspace_id, service_id, health);
    CREATE TABLE IF NOT EXISTS oauth_intents (
      nonce_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      job_id TEXT,
      expected_version INTEGER,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS investigation_jobs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_at TEXT,
      waiting_connection_id TEXT,
      status_message_ts TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_thread_status
      ON investigation_jobs(workspace_id, channel_id, thread_ts, status);
    CREATE TABLE IF NOT EXISTS action_intents (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES investigation_jobs(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      message_ts TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_installations (
      workspace_id TEXT PRIMARY KEY,
      enterprise_id TEXT,
      bot_token_encrypted TEXT NOT NULL,
      user_token_encrypted TEXT,
      installed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_installation_records (
      workspace_id TEXT PRIMARY KEY,
      enterprise_id TEXT,
      installation_encrypted TEXT NOT NULL,
      installed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      bearer_encrypted TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS remote_connections_workspace
      ON remote_connections(workspace_id, owner_user_id);
    CREATE TABLE IF NOT EXISTS remote_oauth_tokens (
      connection_id TEXT NOT NULL REFERENCES remote_connections(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_json_encrypted TEXT NOT NULL,
      PRIMARY KEY (connection_id, workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS remote_oauth_sessions (
      state_hash TEXT PRIMARY KEY,
      session_encrypted TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
  `);
}

function migrateLegacyState(db: Database.Database, directory: string, env: NodeJS.ProcessEnv): void {
  const migrated = db.prepare("SELECT 1 FROM audit_events WHERE action = 'legacy_state_migrated' LIMIT 1").get();
  if (migrated) return;
  const now = new Date().toISOString();
  const workspaceId = env.SLACK_WORKSPACE_ID?.trim();
  const importAll = db.transaction(() => {
    const specs = readJson(path.join(directory, "dynamicServices.local.json"));
    if (specs && !Array.isArray(specs)) {
      for (const [id, spec] of Object.entries(specs)) {
        db.prepare(`INSERT OR IGNORE INTO service_specs (id, spec_json, active, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`)
          .run(id, JSON.stringify(spec), now, now);
      }
    }
    const setup = readJson(path.join(directory, "serviceSetup.local.json"));
    if (workspaceId && setup && !Array.isArray(setup)) {
      for (const [serviceId, raw] of Object.entries(setup)) {
        const value = raw as { clientId?: string; clientSecret?: string; savedAt?: string };
        if (!value.clientId || !value.clientSecret) continue;
        db.prepare(`
          INSERT OR IGNORE INTO workspace_service_configs
            (workspace_id, service_id, client_id, client_secret_encrypted, version, configured_by, configured_at)
          VALUES (?, ?, ?, ?, 1, 'legacy-import', ?)
        `).run(workspaceId, serviceId, value.clientId, encryptSecret(value.clientSecret, env), value.savedAt ?? now);
      }
    }
    const tokens = readJson(path.join(directory, "userTokens.local.json")) as { serviceTokens?: Record<string, Record<string, Record<string, unknown>>> } | undefined;
    if (workspaceId && tokens?.serviceTokens) {
      for (const [serviceId, byUser] of Object.entries(tokens.serviceTokens)) {
        for (const [userId, raw] of Object.entries(byUser)) {
          if (typeof raw.token !== "string") continue;
          db.prepare(`
            INSERT OR IGNORE INTO service_tokens
              (workspace_id, user_id, service_id, token_encrypted, refresh_token_encrypted, expires_at,
               account_id, account_label, scopes_json, health, connected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'ready', ?)
          `).run(
            workspaceId, userId, serviceId, encryptSecret(raw.token, env),
            typeof raw.refreshToken === "string" ? encryptSecret(raw.refreshToken, env) : null,
            raw.expiresAt ?? null, raw.accountId ?? null, raw.accountLabel ?? null, raw.connectedAt ?? now
          );
        }
      }
    }
    const remote = readJson(path.join(directory, "remoteConnections.local.json")) as { connections?: Array<Record<string, unknown>> } | undefined;
    for (const connection of remote?.connections ?? []) {
      if (!connection.id || !connection.workspaceId || !connection.ownerSlackUserId) continue;
      db.prepare(`
        INSERT OR IGNORE INTO remote_connections (id, workspace_id, owner_user_id, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(connection.id, connection.workspaceId, connection.ownerSlackUserId, JSON.stringify(connection), now);
    }
  });
  try {
    importAll();
    for (const name of ["dynamicServices.local.json", "serviceSetup.local.json", "userTokens.local.json", "remoteConnections.local.json"]) {
      const source = path.join(directory, name);
      if (existsSync(source)) renameSync(source, `${source}.migrated.bak`);
    }
    mkdirSync(directory, { recursive: true });
    const markerDb = db.prepare("INSERT OR IGNORE INTO audit_events (workspace_id, actor_user_id, action, target_id, created_at) VALUES (?, ?, ?, ?, ?)");
    markerDb.run(workspaceId ?? "unknown", "system", "legacy_state_migrated", "sqlite", now);
    // The audit record is the durable marker; the file marker is intentionally not required.
  } catch (error) {
    console.warn("Legacy state migration was skipped; ambiguous records will require reconnection.", error);
  }
}

function readJson(filename: string): Record<string, unknown> | undefined {
  try { return existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown> : undefined; }
  catch { return undefined; }
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.STATE_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (env.NODE_ENV === "test" || env.EPHEMERAL_STATE === "true") {
      return createHash("sha256").update("agentkj-ephemeral-test-key").digest();
    }
    throw new Error("STATE_ENCRYPTION_KEY is required for durable credential storage.");
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Encrypted secret is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}
