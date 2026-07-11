import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "json", "html"] },
    env: {
      NODE_ENV: "test",
      EPHEMERAL_STATE: "true",
      STATE_DB_PATH: ":memory:"
    }
  }
});
