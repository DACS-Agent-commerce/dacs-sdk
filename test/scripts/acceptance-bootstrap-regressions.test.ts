import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const workflow = () => readFileSync(".github/workflows/registry-container-acceptance.yml", "utf8");
function runBlock(name: string) {
  const step = workflow().split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
  if (!step) throw new Error("missing workflow step " + name);
  const inline = /^        run: (.+)$/m.exec(step)?.[1];
  return inline === "|" ? step.split("        run: |\n")[1]?.split("\n").map(line => line.slice(10)).join("\n") ?? "" : inline ?? "";
}
describe("acceptance workflow bootstrap admission", () => {
  it.each(["Pin acceptance npm client", "Install exact source lock"])("admits and bounds every npm request in %s", name => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bootstrap-")), bin = join(root, "bin"); mkdirSync(bin);
    try {
      writeFileSync(join(bin, "npm"), `#!/bin/sh
[ "\${DACS_BOUNDED_NPM_HTTP-}" = 1 ] || exit 91
case "\${NODE_OPTIONS-}" in *bounded-npm-http.cjs*) ;; *) exit 92 ;; esac
[ "\${npm_config_fetch_timeout-}" = 15000 ] || exit 93
[ "\${npm_config_fetch_retries-}" = 2 ] || exit 94
case "$*" in *--no-audit*) ;; *) exit 95 ;; esac
printf 'admitted\\n'
exit 17
`, { mode: 0o700 });
      const script = runBlock(name);
      const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", script], {
        encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stderr).toBe(17); expect(script).toContain("run_bounded npm"); expect(result.stdout).toBe("admitted\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("describes the caller policy without claiming an unconnected publication gate", () => {
    const classifier = readFileSync("scripts/registry-container-disposition.mjs", "utf8");
    expect(classifier).not.toContain("manual runs, prerelease publication and release paths fail");
    expect(workflow()).not.toContain("caller that enforces drift (prerelease publication)");
  });
});
