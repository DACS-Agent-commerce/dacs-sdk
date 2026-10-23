import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { registryContainerDisposition } = await import(modulePath);
describe("acceptance runbook contracts", () => {
  it("documents and preserves pqcrypto's exact manifest-version exception", () => {
    const summary = JSON.parse(readFileSync("test/scripts/fixtures/registry-container-5c27c28/acceptance-summary.json", "utf8"));
    summary.complete = true;
    const result = () => registryContainerDisposition(summary, undefined, { packageVersion: "0.1.0-alpha.0" });
    expect(result().exitCode).toBe(4);
    const pqcrypto = summary.securityGate.findings.productionImageDependencies.find((item: { name: string }) => item.name === "pqcrypto");
    if (!pqcrypto) throw new Error("missing pqcrypto fixture finding");
    pqcrypto.version = "1.0.02";
    expect(result()).toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    expect(readFileSync("scripts/registry-container-audit-baseline.md", "utf8")).toContain("exact recorded manifest version `1.0.01`");
  });
  it("creates an existing parent and a new output directory on every documented run", () => {
    const readme = readFileSync("README.md", "utf8");
    const block = /```sh\n(mkdir -p registry-container-artifacts[\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "dacs-docs-run-"));
    try {
      const stub = `npm() {
  [ "$1 $2 $3 $4" = 'run acceptance:registry-container -- --output-dir' ]
  [ -d "$(dirname "$5")" ] && [ ! -e "$5" ]
  mkdir "$5"
  printf '%s\\n' "$5"
}
`;
      const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", stub + block + "\n" + block], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const paths = result.stdout.trim().split("\n"); expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(2);
      expect(readme).toContain("Failures after preflight retain partial evidence");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


it("scopes byte limits to HTTP responses and deadlines to wrapped commands", () => {
  const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
  expect(readme).toContain("npm HTTP responses have byte and time limits.");
  expect(readme).toContain("Commands wrapped with `run_bounded` have deadlines.");
  expect(readme).not.toContain("responses and command execution have byte and time limits");
});
