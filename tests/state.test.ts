import path from "node:path";
import { describe, expect, it } from "vitest";
import { stateFilePath } from "../src/config/state.js";

describe("stateFilePath", () => {
  it("uses the project data directory by default", () => {
    expect(stateFilePath("tokens.json", {}, "/srv/app")).toBe(
      path.resolve("/srv/app", "data", "tokens.json")
    );
  });

  it("uses an absolute configured state directory", () => {
    expect(stateFilePath("tokens.json", { STATE_DIR: "/var/lib/slack-detective" }, "/srv/app")).toBe(
      path.resolve("/var/lib/slack-detective", "tokens.json")
    );
  });

  it("resolves a relative configured state directory from the working directory", () => {
    expect(stateFilePath("tokens.json", { STATE_DIR: "runtime" }, "/srv/app")).toBe(
      path.resolve("/srv/app", "runtime", "tokens.json")
    );
  });
});
