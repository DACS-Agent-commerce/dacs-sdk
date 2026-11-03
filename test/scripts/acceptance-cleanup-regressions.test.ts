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
  it("removes the run's builder before its network and preserves failure status", () => {
    const root = scratch(), log = join(root, "commands");
    const cleanup = source().split("cleanup() {\n")[1]?.split("\ntrap cleanup EXIT")[0]; expect(cleanup).toBeTruthy();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `
docker() { printf '%s\\n' "$*" >> "$log"; return 124; }
cleanup() {\n${cleanup}
trap cleanup EXIT
exit 17`], { encoding: "utf8", env: { PATH: process.env.PATH, log, acceptance_root: root,
      artifact_stage: join(root, "absent"), output_reserved: "0", consumer_phases: "", registry_started: "0", image_started: "0",
      builder_started: "1", registry_builder: "fixture-builder", network_started: "1", registry_network: "fixture-network" } });
    expect(result.status, result.stderr).toBe(17);
    expect(readFileSync(log, "utf8")).toBe("buildx rm --force fixture-builder\nnetwork rm fixture-network\n");
  });

  // A copy fails here because cp fails, or because the collected name already exists in the evidence.
  it.each(["exec-out/doctor.log", "measure-out/npm-audit.json", "release-set/SHA256SUMS"])("retains the source when copying %s fails", file => {
    const root = scratch(), artifact = join(root, "artifacts"), output = join(root, "output");
    for (const name of ["artifacts", "output", "exec-out", "measure-out", "release-set"]) mkdirSync(join(root, name), { recursive: true });
    const original = join(root, file); writeFileSync(original, "unique diagnostic"); writeFileSync(join(artifact, "acceptance-summary.json"), "{}");
    writeFileSync(join(artifact, file.split("/")[1]!), "earlier copy");
    const cleanup = source().split("cleanup() {\n")[1]?.split("\ntrap cleanup EXIT")[0]; expect(cleanup).toBeTruthy();
    const evidenceLists = source().match(/^measure_evidence=\([\s\S]*?^execute_evidence=\(.*\)$/m)?.[0]; expect(evidenceLists).toBeTruthy();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `docker() { :; }; run_bounded() { "$@"; }; cp() { return 1; }; ${evidenceLists}\ncleanup() {\n${cleanup}\ntrap cleanup EXIT\nexit 17`], {
      encoding: "utf8", env: { PATH: process.env.PATH, acceptance_root: root, artifact_stage: artifact, output_dir: output, repo_root: process.cwd(),
        measure_out: join(root, "measure-out"), execute_out: join(root, "exec-out"), measure_collected: "0", execute_collected: "0", consumer_phases: "",
        release_set: join(root, "release-set"), registry_started: "1", registry_container: "fixture", network_started: "0", image_started: "0", output_reserved: "1" },
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
