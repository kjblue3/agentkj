import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFilePath } from "../config/state.js";

/**
 * Deployment-level OAuth app credentials (a provider's client id/secret), one pair per service,
 * collected through the secure setup form (src/auth/serviceSetup.ts) so nobody has to SSH into
 * the host or edit env files to make a service connectable. Env vars named
 * `<SERVICE_ID>_CLIENT_ID` / `<SERVICE_ID>_CLIENT_SECRET` override the stored values, so an
 * operator can still pre-provision through the environment when they prefer.
 */

export interface DeploymentClientCreds {
  clientId: string;
  clientSecret: string;
  savedAt: string;
}

const STORE_PATH = stateFilePath("serviceSetup.local.json");

function loadStore(): Record<string, DeploymentClientCreds> {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Record<string, DeploymentClientCreds>;
  } catch (error) {
    console.warn("Service setup store unreadable; starting empty.", error);
  }
  return {};
}

const store = new Map<string, DeploymentClientCreds>(Object.entries(loadStore()));

function saveStore(): void {
  try {
    mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(Object.fromEntries(store), null, 2));
  } catch (error) {
    console.warn("Service setup store write failed; setup values won't survive a restart.", error);
  }
}

export function envKeyForService(serviceId: string, suffix: "CLIENT_ID" | "CLIENT_SECRET"): string {
  return `${serviceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

export function getClientCreds(
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env
): { clientId: string; clientSecret: string } | undefined {
  const envId = env[envKeyForService(serviceId, "CLIENT_ID")];
  const envSecret = env[envKeyForService(serviceId, "CLIENT_SECRET")];
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };
  const stored = store.get(serviceId);
  return stored ? { clientId: stored.clientId, clientSecret: stored.clientSecret } : undefined;
}

export function setClientCreds(serviceId: string, clientId: string, clientSecret: string): void {
  store.set(serviceId, { clientId: clientId.trim(), clientSecret: clientSecret.trim(), savedAt: new Date().toISOString() });
  saveStore();
}
