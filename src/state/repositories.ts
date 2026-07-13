import { randomBytes, randomUUID } from "node:crypto";
import type { InvestigationContext, InvestigationJob, InvestigationJobStatus } from "../core/context.js";
import type { DynamicServiceSpec } from "../services/dynamicSpec.js";
import { decryptSecret, encryptSecret, nonceHash, stateDatabase } from "./database.js";

export interface WorkspaceClientCredentials {
  clientId: string;
  clientSecret: string;
  version: number;
  source: "environment" | "workspace";
}

export interface StoredServiceToken {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  accountLabel?: string;
  scopes: string[];
  health: "ready" | "reauthorization_required" | "revoked";
  connectedAt: string;
}

export interface OAuthIntent {
  kind: "setup" | "authorize";
  workspaceId: string;
  userId: string;
  serviceId: string;
  jobId?: string;
  expectedVersion?: number;
  expiresAt: string;
}

function envKey(serviceId: string, suffix: "CLIENT_ID" | "CLIENT_SECRET"): string {
  return `${serviceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

export function saveServiceSpec(spec: DynamicServiceSpec): void {
  const now = new Date().toISOString();
  stateDatabase().prepare(`
    INSERT INTO service_specs (id, spec_json, active, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json, updated_at = excluded.updated_at
  `).run(spec.id, JSON.stringify(spec), now, now);
}

export function listServiceSpecs(): DynamicServiceSpec[] {
  return stateDatabase().prepare("SELECT spec_json FROM service_specs ORDER BY id")
    .all()
    .flatMap((row) => {
      try {
        return [JSON.parse((row as { spec_json: string }).spec_json) as DynamicServiceSpec];
      } catch {
        return [];
      }
    });
}

export function getWorkspaceClientCredentials(
  workspaceId: string,
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env
): WorkspaceClientCredentials | undefined {
  const envId = env[envKey(serviceId, "CLIENT_ID")];
  const envSecret = env[envKey(serviceId, "CLIENT_SECRET")];
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret, version: 0, source: "environment" };
  const row = stateDatabase().prepare(`
    SELECT client_id, client_secret_encrypted, version
    FROM workspace_service_configs WHERE workspace_id = ? AND service_id = ?
  `).get(workspaceId, serviceId) as { client_id: string; client_secret_encrypted: string; version: number } | undefined;
  return row ? {
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret_encrypted, env),
    version: row.version,
    source: "workspace"
  } : undefined;
}

export function setWorkspaceClientCredentials(params: {
  workspaceId: string;
  serviceId: string;
  clientId: string;
  clientSecret: string;
  configuredBy: string;
  expectedVersion?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const env = params.env ?? process.env;
  const db = stateDatabase(env);
  const apply = db.transaction(() => {
    const existing = db.prepare(`
      SELECT version FROM workspace_service_configs WHERE workspace_id = ? AND service_id = ?
    `).get(params.workspaceId, params.serviceId) as { version: number } | undefined;
    if (params.expectedVersion !== undefined && (existing?.version ?? 0) !== params.expectedVersion) {
      throw new Error("This setup changed after the page was opened. Request a fresh setup link.");
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO workspace_service_configs
        (workspace_id, service_id, client_id, client_secret_encrypted, version, configured_by, configured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, service_id) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret_encrypted = excluded.client_secret_encrypted,
        version = excluded.version,
        configured_by = excluded.configured_by,
        configured_at = excluded.configured_at
    `).run(
      params.workspaceId,
      params.serviceId,
      params.clientId.trim(),
      encryptSecret(params.clientSecret.trim(), env),
      nextVersion,
      params.configuredBy,
      now
    );
    if (existing) {
      db.prepare(`
        UPDATE service_tokens SET health = 'reauthorization_required'
        WHERE workspace_id = ? AND service_id = ?
      `).run(params.workspaceId, params.serviceId);
    }
    db.prepare(`
      INSERT INTO audit_events (workspace_id, actor_user_id, action, target_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.workspaceId,
      params.configuredBy,
      existing ? "service_credentials_replaced" : "service_credentials_configured",
      params.serviceId,
      JSON.stringify({ version: nextVersion }),
      now
    );
    return nextVersion;
  });
  return apply();
}

export function setStoredServiceToken(
  workspaceId: string,
  userId: string,
  serviceId: string,
  token: StoredServiceToken,
  env: NodeJS.ProcessEnv = process.env
): void {
  stateDatabase(env).prepare(`
    INSERT INTO service_tokens
      (workspace_id, user_id, service_id, token_encrypted, refresh_token_encrypted, expires_at,
       account_id, account_label, scopes_json, health, connected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id, service_id) DO UPDATE SET
      token_encrypted = excluded.token_encrypted,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      expires_at = excluded.expires_at,
      account_id = excluded.account_id,
      account_label = excluded.account_label,
      scopes_json = excluded.scopes_json,
      health = excluded.health,
      connected_at = excluded.connected_at
  `).run(
    workspaceId,
    userId,
    serviceId,
    encryptSecret(token.token, env),
    token.refreshToken ? encryptSecret(token.refreshToken, env) : null,
    token.expiresAt ?? null,
    token.accountId ?? null,
    token.accountLabel ?? null,
    JSON.stringify(token.scopes),
    token.health,
    token.connectedAt
  );
}

export function getStoredServiceToken(
  workspaceId: string,
  userId: string,
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env
): StoredServiceToken | undefined {
  const row = stateDatabase(env).prepare(`
    SELECT * FROM service_tokens WHERE workspace_id = ? AND user_id = ? AND service_id = ?
  `).get(workspaceId, userId, serviceId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    token: decryptSecret(String(row.token_encrypted), env),
    refreshToken: row.refresh_token_encrypted ? decryptSecret(String(row.refresh_token_encrypted), env) : undefined,
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    accountId: row.account_id ? String(row.account_id) : undefined,
    accountLabel: row.account_label ? String(row.account_label) : undefined,
    scopes: JSON.parse(String(row.scopes_json ?? "[]")) as string[],
    health: String(row.health) as StoredServiceToken["health"],
    connectedAt: String(row.connected_at)
  };
}

export function listWorkspaceTokens(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): Array<{ userId: string; serviceId: string; token: StoredServiceToken }> {
  const rows = stateDatabase(env).prepare(`
    SELECT user_id, service_id FROM service_tokens WHERE workspace_id = ?
    ORDER BY connected_at DESC
  `).all(workspaceId) as Array<{ user_id: string; service_id: string }>;
  return rows.flatMap((row) => {
    const token = getStoredServiceToken(workspaceId, row.user_id, row.service_id, env);
    return token ? [{ userId: row.user_id, serviceId: row.service_id, token }] : [];
  });
}

export function createOAuthIntent(value: Omit<OAuthIntent, "expiresAt"> & { ttlMs?: number }): string {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (value.ttlMs ?? 15 * 60_000)).toISOString();
  stateDatabase().prepare(`
    INSERT INTO oauth_intents
      (nonce_hash, kind, workspace_id, user_id, service_id, job_id, expected_version, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nonceHash(nonce), value.kind, value.workspaceId, value.userId, value.serviceId,
    value.jobId ?? null, value.expectedVersion ?? null, expiresAt
  );
  return nonce;
}

export function consumeOAuthIntent(nonce: string, kind: OAuthIntent["kind"]): OAuthIntent | undefined {
  const db = stateDatabase();
  const consume = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM oauth_intents
      WHERE nonce_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
    `).get(nonceHash(nonce), kind, new Date().toISOString()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE oauth_intents SET consumed_at = ? WHERE nonce_hash = ?")
      .run(new Date().toISOString(), nonceHash(nonce));
    return {
      kind,
      workspaceId: String(row.workspace_id),
      userId: String(row.user_id),
      serviceId: String(row.service_id),
      jobId: row.job_id ? String(row.job_id) : undefined,
      expectedVersion: row.expected_version === null ? undefined : Number(row.expected_version),
      expiresAt: String(row.expires_at)
    } satisfies OAuthIntent;
  });
  return consume();
}

export function getOAuthIntent(nonce: string, kind: OAuthIntent["kind"]): OAuthIntent | undefined {
  const row = stateDatabase().prepare(`
    SELECT * FROM oauth_intents
    WHERE nonce_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
  `).get(nonceHash(nonce), kind, new Date().toISOString()) as Record<string, unknown> | undefined;
  return row ? {
    kind,
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    serviceId: String(row.service_id),
    jobId: row.job_id ? String(row.job_id) : undefined,
    expectedVersion: row.expected_version === null ? undefined : Number(row.expected_version),
    expiresAt: String(row.expires_at)
  } : undefined;
}

export function createInvestigationJob(
  context: InvestigationContext,
  question: string,
  routing: { relevantSources?: string[]; relevantOwnerUserIds?: string[] } = {}
): InvestigationJob {
  const now = new Date().toISOString();
  const job: InvestigationJob = {
    id: randomUUID(), context, question,
    relevantSources: routing.relevantSources,
    relevantOwnerUserIds: routing.relevantOwnerUserIds,
    status: "queued", createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  };
  stateDatabase().prepare(`
    INSERT OR IGNORE INTO investigation_jobs
      (id, request_id, workspace_id, channel_id, thread_ts, user_id, question,
       relevant_sources_json, relevant_owner_user_ids_json, status, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id, context.requestId, context.workspaceId, context.channelId, context.threadTs,
    context.userId, question,
    routing.relevantSources === undefined ? null : JSON.stringify(routing.relevantSources),
    routing.relevantOwnerUserIds === undefined ? null : JSON.stringify(routing.relevantOwnerUserIds),
    job.status, now, now, job.expiresAt
  );
  return getInvestigationJobByRequestId(context.requestId) ?? job;
}

export function getInvestigationJob(id: string): InvestigationJob | undefined {
  const row = stateDatabase().prepare("SELECT * FROM investigation_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? jobFromRow(row) : undefined;
}

function getInvestigationJobByRequestId(requestId: string): InvestigationJob | undefined {
  const row = stateDatabase().prepare("SELECT * FROM investigation_jobs WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
  return row ? jobFromRow(row) : undefined;
}

export function updateInvestigationJob(
  id: string,
  status: InvestigationJobStatus,
  updates: { retryAt?: string; waitingConnectionId?: string; statusMessageTs?: string; result?: unknown } = {}
): void {
  stateDatabase().prepare(`
    UPDATE investigation_jobs SET status = ?, retry_at = ?, waiting_connection_id = ?,
      status_message_ts = COALESCE(?, status_message_ts), result_json = COALESCE(?, result_json), updated_at = ?
    WHERE id = ?
  `).run(
    status, updates.retryAt ?? null, updates.waitingConnectionId ?? null,
    updates.statusMessageTs ?? null, updates.result === undefined ? null : JSON.stringify(updates.result),
    new Date().toISOString(), id
  );
}

export function listDueCapacityJobs(now = new Date().toISOString()): InvestigationJob[] {
  return (stateDatabase().prepare(`
    SELECT * FROM investigation_jobs
    WHERE status = 'waiting_for_capacity' AND retry_at <= ? AND expires_at > ?
    ORDER BY retry_at
  `).all(now, now) as Record<string, unknown>[]).map(jobFromRow);
}

export function listExpiredCapacityJobs(now = new Date().toISOString()): InvestigationJob[] {
  return (stateDatabase().prepare(`
    SELECT * FROM investigation_jobs
    WHERE status = 'waiting_for_capacity' AND expires_at <= ?
    ORDER BY expires_at
  `).all(now) as Record<string, unknown>[]).map(jobFromRow);
}

export function markEventProcessed(eventId: string): boolean {
  const result = stateDatabase().prepare(`
    INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)
  `).run(eventId, new Date().toISOString());
  return result.changes === 1;
}

export function saveSlackInstallation(
  workspaceId: string,
  botToken: string,
  userToken?: string,
  enterpriseId?: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  stateDatabase(env).prepare(`
    INSERT INTO slack_installations (workspace_id, enterprise_id, bot_token_encrypted, user_token_encrypted, installed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET enterprise_id = excluded.enterprise_id,
      bot_token_encrypted = excluded.bot_token_encrypted, user_token_encrypted = excluded.user_token_encrypted,
      installed_at = excluded.installed_at
  `).run(workspaceId, enterpriseId ?? null, encryptSecret(botToken, env), userToken ? encryptSecret(userToken, env) : null, new Date().toISOString());
}

export function getSlackInstallationToken(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): { botToken: string; userToken?: string } | undefined {
  const row = stateDatabase(env).prepare(`
    SELECT bot_token_encrypted, user_token_encrypted FROM slack_installations WHERE workspace_id = ?
  `).get(workspaceId) as { bot_token_encrypted: string; user_token_encrypted?: string } | undefined;
  return row ? {
    botToken: decryptSecret(row.bot_token_encrypted, env),
    userToken: row.user_token_encrypted ? decryptSecret(row.user_token_encrypted, env) : undefined
  } : undefined;
}

export function saveSlackInstallationRecord(
  workspaceId: string,
  installation: unknown,
  enterpriseId?: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  stateDatabase(env).prepare(`
    INSERT INTO slack_installation_records (workspace_id, enterprise_id, installation_encrypted, installed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET enterprise_id = excluded.enterprise_id,
      installation_encrypted = excluded.installation_encrypted, installed_at = excluded.installed_at
  `).run(workspaceId, enterpriseId ?? null, encryptSecret(JSON.stringify(installation), env), new Date().toISOString());
  const value = installation as { bot?: { token?: string }; user?: { token?: string } };
  if (value.bot?.token) saveSlackInstallation(workspaceId, value.bot.token, value.user?.token, enterpriseId, env);
}

export function getSlackInstallationRecord(workspaceId: string, env: NodeJS.ProcessEnv = process.env): unknown | undefined {
  const row = stateDatabase(env).prepare(`
    SELECT installation_encrypted FROM slack_installation_records WHERE workspace_id = ?
  `).get(workspaceId) as { installation_encrypted: string } | undefined;
  return row ? JSON.parse(decryptSecret(row.installation_encrypted, env)) : undefined;
}

function jobFromRow(row: Record<string, unknown>): InvestigationJob {
  return {
    id: String(row.id),
    context: {
      requestId: String(row.request_id), workspaceId: String(row.workspace_id),
      channelId: String(row.channel_id), threadTs: String(row.thread_ts), userId: String(row.user_id)
    },
    question: String(row.question),
    relevantSources: row.relevant_sources_json ? JSON.parse(String(row.relevant_sources_json)) as string[] : undefined,
    relevantOwnerUserIds: row.relevant_owner_user_ids_json ? JSON.parse(String(row.relevant_owner_user_ids_json)) as string[] : undefined,
    status: String(row.status) as InvestigationJobStatus,
    retryAt: row.retry_at ? String(row.retry_at) : undefined,
    waitingConnectionId: row.waiting_connection_id ? String(row.waiting_connection_id) : undefined,
    statusMessageTs: row.status_message_ts ? String(row.status_message_ts) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), expiresAt: String(row.expires_at)
  };
}
