import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function workflowSource(name: string): string {
  return readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
}

describe("workflow concurrency policy", () => {
  for (const name of ["ci", "package-artifact"]) {
    it(`${name} groups only first-attempt PR runs by ref without requiring a PR payload`, () => {
      const source = workflowSource(name);
      // Pin the GitHub expression itself: local tests cannot exercise the hosted scheduler.
      expect(source.match(/^  group: (.+)$/m)?.[1]).toBe(
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.run_attempt == 1 && github.ref || github.run_id }}",
      );
    });

    it(`${name} enables cancellation only for first-attempt PR runs`, () => {
      expect(workflowSource(name).match(/^  cancel-in-progress: (.+)$/m)?.[1]).toBe(
        "${{ github.event_name == 'pull_request' && github.run_attempt == 1 }}",
      );
    });
  }

  it("keeps every Secret scan eligible even when a later push rewrites the PR history", () => {
    // A shared pending group drops scans even with cancel-in-progress: false.
    // Check job-level concurrency too, so moving the block cannot reintroduce it.
    expect(workflowSource("secret-scan")).not.toMatch(/^\s*concurrency\s*:/m);
  });
});
