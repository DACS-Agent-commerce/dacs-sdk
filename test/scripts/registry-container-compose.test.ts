import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { liveProjectTemplates } from "../../packages/create-dacs-agent/src/liveTemplates.js";

it("supplies every required generated Compose variable with inert run-local inputs", () => {
  const compose = liveProjectTemplates({ packageName: "acceptance", deployment: "docker", role: "seller",
    rails: "both", runtimeUid: 10001, runtimeGid: 10001 })["compose.yaml"]!;
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const block = source.slice(source.indexOf("\nenv \\\n"), source.indexOf('    > "$artifact_stage/compose.rendered.yaml"'));
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z_0-9]+):?\?/g)].map(m => m[1]!))];
  const supplied = [...block.matchAll(/\b([A-Z_0-9]+)=/g)].map(m => m[1]!);
  expect(required.filter(name => !supplied.includes(name))).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "dacs-compose-inputs-"));
  try {
    const setup = source.slice(source.indexOf("# Inert Compose inputs"), source.indexOf("\nenv \\\n"));
    const render = block.replace(/docker compose[\s\S]*/, 'node -e \'process.stdout.write(JSON.stringify(process.env))\'');
    const result = spawnSync("bash", ["-eu", "-c", setup + "\n" + render], {
      encoding: "utf8", env: { acceptance_root: root },
    });
    expect(result.status, result.stderr).toBe(0);
    const values = JSON.parse(result.stdout) as Record<string, string>;
    for (const name of required) expect(values[name]).toBeTruthy();
    for (const name of required.filter(n => n.endsWith("_FILE") || n.endsWith("_DIRECTORY"))) {
      expect(values[name]!.startsWith(root + "/")).toBe(true);
      expect(statSync(values[name]!).isDirectory()).toBe(name.endsWith("_DIRECTORY"));
      if (name.endsWith("_FILE")) expect(readFileSync(values[name]!, "utf8")).toContain("acceptance-placeholder");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
