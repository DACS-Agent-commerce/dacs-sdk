import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { peerCacheFixture } from "./reference-cache-fixtures.js";
import { sri } from "./npm-archive-fixtures.js";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const candidates = ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"];
const dependencies = [...candidates, "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem"];

it.each([false, true])("writes the real dependency policy after peer re-resolution, omitted git=%s", async omittedGit => {
  const project = mkdtempSync(join(tmpdir(), "policy-reference-cache-"));
  scratch.push(project);
  const { input, registry, archives } = await peerCacheFixture(project, dependencies.map(name => ({ name, version: "1.0.0" })));
  const provenance = { version: "1.0.0", packages: {} as Record<string, { integrity: string }> };
  for (const name of candidates) {
    const archive = archives.get(`/${name}-1.0.0.tgz`);
    if (!archive) throw Error("missing candidate fixture");
    writeFileSync(join(project, `${name.slice(1).replace("/", "-")}-1.0.0.tgz`), archive);
    provenance.packages[name] = { integrity: sri(archive) };
  }
  writeFileSync(join(project, "release-provenance.json"), JSON.stringify(provenance));
  if (omittedGit) {
    input.lock.packages["node_modules/g"] = { version: "1.0.0", optional: true,
      resolved: "git+ssh://git@github.com/u/g.git#" + "a".repeat(40) };
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(input.lock));
  }
  const report = join(project, "policy.json");
  const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
    project, registry, report, project, "1.0.0"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, npm_config_cache: input.metadataCache, npm_config_registry: registry } });
  expect(result.status, result.stderr).toBe(0);
  const policy = JSON.parse(readFileSync(report, "utf8"));
  expect(policy.schema).toBe("dacs-registry-dependency-policy/v1");
  expect(policy.passed).toBe(!omittedGit);
  if (omittedGit) expect(policy.violations).toContainEqual(expect.objectContaining({ location: "node_modules/g", field: "resolved" }));
}, 60_000);
