import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-cleanup-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = () => readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
describe("failure evidence preservation", () => {
  it.each(["consumer/doctor.log", "consumer/one-click-agent/package.json", "release-set/SHA256SUMS"])("retains the source when copying %s fails", file => {
    const root = scratch(), artifact = join(root, "artifacts"), output = join(root, "output");
    for (const name of ["artifacts", "output", "consumer/one-click-agent", "release-set"]) mkdirSync(join(root, name), { recursive: true });
    const original = join(root, file); writeFileSync(original, "unique diagnostic"); writeFileSync(join(artifact, "acceptance-summary.json"), "{}");
    const cleanup = source().split("cleanup() {\n")[1]?.split("\ntrap cleanup EXIT")[0]; expect(cleanup).toBeTruthy();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `docker() { :; }; run_bounded() { "$@"; }; cp() { return 1; }; cleanup() {\n${cleanup}\ntrap cleanup EXIT\nexit 17`], {
      encoding: "utf8", env: { PATH: process.env.PATH, acceptance_root: root, artifact_stage: artifact, output_dir: output,
        consumer_root: join(root, "consumer"), release_set: join(root, "release-set"), registry_started: "1", registry_container: "fixture", network_started: "0", image_started: "0", output_reserved: "1" },
    });
    expect(result.status, result.stderr).toBe(17); expect(existsSync(original)).toBe(true);
    expect(readFileSync(original, "utf8")).toBe("unique diagnostic"); expect(result.stderr).toContain("retained at " + root);
  });
  it("routes shell Docker calls through the existing deadline helper", () => {
    const wrapper = source().match(/^docker\(\) \{[\s\S]*?^\}/m)?.[0]; expect(wrapper).toBeDefined();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `run_bounded() { printf '%s\\n' "$*"; return 124; }; ${wrapper}\ndocker network create fixture`], { encoding: "utf8" });
    expect(result.status).toBe(124); expect(result.stdout).toContain("docker network create fixture");
  });
});
