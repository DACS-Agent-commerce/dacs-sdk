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
  it.each([
    ["Pin acceptance npm client", false, 0], ["Pin acceptance npm client", false, 17],
    ["Install exact source lock", true, 0], ["Install exact source lock", true, 17],
  ] as const)("runs %s with bounded transport=%s and preserves exit %i", (name, bounded, exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bootstrap-")), bin = join(root, "bin"); mkdirSync(bin);
    try {
      writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "${bounded}" = true ]; then
  [ "\${DACS_BOUNDED_NPM_HTTP-}" = 1 ] || exit 91
  case "\${NODE_OPTIONS-}" in *bounded-npm-http.cjs*) ;; *) exit 92 ;; esac
  [ "\${npm_config_fetch_timeout-}" = 15000 ] || exit 93
  [ "\${npm_config_fetch_retries-}" = 2 ] || exit 94
  [ "$*" = 'ci --no-audit' ] || exit 95
else
  # The runner's older npm requests full self-install metadata before pinning.
  [ -z "\${DACS_BOUNDED_NPM_HTTP-}" ] || exit 91
  case "\${NODE_OPTIONS-}" in *bounded-npm-http.cjs*) exit 92 ;; esac
  [ "$*" = 'install --global --ignore-scripts --no-audit npm@11.19.0' ] || exit 95
fi
printf 'admitted\\n'
exit ${exitCode}
`, { mode: 0o700 });
      const script = runBlock(name);
      const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", script], {
        encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(script).toContain(bounded ? "run_bounded npm" : "timeout 900 npm");
      expect(result.stdout).toBe("admitted\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("describes the caller policy without claiming an unconnected publication gate", () => {
    const classifier = readFileSync("scripts/registry-container-disposition.mjs", "utf8");
    expect(classifier).not.toContain("manual runs, prerelease publication and release paths fail");
    expect(workflow()).not.toContain("caller that enforces drift (prerelease publication)");
  });
});
