import { describe, expect, it } from "vitest";
import { buildGitHubDemoSeedData } from "../src/data/githubDemoSeed.js";

describe("GitHub demo seed data", () => {
  it("maps the checkout incident into reusable GitHub sandbox artifacts", () => {
    const seed = buildGitHubDemoSeedData("acme", "slack-detective-demo");

    expect(seed.owner).toBe("acme");
    expect(seed.repo).toBe("slack-detective-demo");
    expect(seed.labels.map((label) => label.name)).toEqual([
      "checkout",
      "latency",
      "incident",
      "root-cause",
      "n+1"
    ]);
    expect(seed.issue.title).toBe("Checkout latency spike report");
    expect(seed.issue.labels).toContain("checkout");
    expect(seed.issueComments.join("\n")).toContain("p95 above 2s");
    expect(seed.files.map((file) => file.path)).toContain("docs/checkout-remediation-plan.md");
    expect(seed.pullRequest.body).toContain("Fictional demo pull request");
    expect(seed.reviewComment.body).toContain("batch by region");
  });
});
