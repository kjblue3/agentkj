import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeStateDatabase, stateDatabase } from "../src/state/database.js";

describe("legacy state migration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkj-migration-"));
  const env = {
    NODE_ENV: "test",
    STATE_DIR: directory,
    STATE_DB_PATH: path.join(directory, "state.sqlite"),
    STATE_ENCRYPTION_KEY: "migration-key",
    SLACK_WORKSPACE_ID: "T1"
  } as NodeJS.ProcessEnv;

  afterAll(() => closeStateDatabase());

  it("imports generic specifications and workspace credentials once, then archives JSON", () => {
    writeFileSync(path.join(directory, "dynamicServices.local.json"), JSON.stringify({
      "acme-records": { id: "acme-records", label: "Acme Records" }
    }));
    writeFileSync(path.join(directory, "serviceSetup.local.json"), JSON.stringify({
      "acme-records": { clientId: "client", clientSecret: "secret", savedAt: "2026-01-01T00:00:00.000Z" }
    }));
    closeStateDatabase();
    const db = stateDatabase(env);
    expect((db.prepare("SELECT COUNT(*) AS count FROM service_specs").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM workspace_service_configs").get() as { count: number }).count).toBe(1);
    expect(existsSync(path.join(directory, "dynamicServices.local.json.migrated.bak"))).toBe(true);
    expect(existsSync(path.join(directory, "serviceSetup.local.json.migrated.bak"))).toBe(true);
  });
});
