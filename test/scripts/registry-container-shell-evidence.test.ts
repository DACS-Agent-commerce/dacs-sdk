import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../..");
const source = () => readFileSync(join(root, "scripts/verify-registry-container-consumer.sh"), "utf8");
const roots: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "dacs-shell-evidence-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const heredoc = (start: string) => source().split(start)[1]?.split("<<'NODE'\n")[1]?.split("\nNODE")[0] ?? "";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { extractPolicyFindings, registryContainerDisposition } = await import(modulePath);
function compose(overrides: Record<string, string> = {}) {
  const stage = scratch();
  const files = {
    "docker-image.json": JSON.stringify([{ Id: "fixture", Size: 1, Config: { User: "10001:10001" } }]),
    "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: {} } }),
    "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }),
    "audit-policy.json": JSON.stringify({ schema: "dacs-registry-audit-policy/v1", passed: true, observedAdvisories: [], unlistedAdvisories: [], assessedAdvisories: [], directAdvisories: [] }),
    "runtime-image-policy.json": JSON.stringify({ schema: "dacs-runtime-image-policy/v1", functionalPassed: true, productionDependencyPolicyPassed: true }),
    "policy-findings.json": JSON.stringify({ schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [], productionImageInventory: { scanComplete: true, errors: [], missing: [] },
      engine: { exitCode: 0, code: null, scanComplete: true, violations: [] }, lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } }),
    "release-provenance.json": JSON.stringify({ version: "0.1.0-test" }),
    "engine-strict.exit-code": "0\n", "npm-audit.exit-code": "0\n", "consumer-lock-sbom.exit-code": "0\n", "consumer-physical-sbom.exit-code": "0\n",
    "generated-tests.exit-code": "0\n", "doctor.exit-code": "5\n", ...overrides,
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(stage, name), value);
  const script = heredoc('node - "$artifact_stage" "$version" "$runtime_image"');
  expect(script).not.toBe("");
  const result = spawnSync(process.execPath, ["-", stage, "0.1.0-test", "image", "live-demos", "seller", "both"], { cwd: root, input: script, encoding: "utf8" });
  return { ...result, summary: result.status === 0 ? JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8")) : undefined };
}
describe("shell evidence validation", () => {
  it.each(["engine-strict.exit-code", "npm-audit.exit-code", "consumer-lock-sbom.exit-code", "consumer-physical-sbom.exit-code", "generated-tests.exit-code", "doctor.exit-code"])("rejects malformed %s", name => {
    for (const text of ["", " \n", "bad", "256", "-1", "0.5"]) {
      const result = compose({ [name]: text });
      expect(result.status, `${name}: ${JSON.stringify(text)}`).not.toBe(0);
      expect(result.stderr).toContain(name);
    }
  });
  it("writes explicit completion only after composing all required evidence", () => {
    const result = compose(); expect(result.status, result.stderr).toBe(0); expect(result.summary.complete).toBe(true);
  });
  it.each([0, 1, 125, 126, 127])("distinguishes Docker package probe status %s", code => {
    const text = source(); const start = text.includes("image_package_present()") ? text.indexOf("image_package_present()") : text.indexOf("typescript_present=false");
    const block = text.slice(start, text.indexOf("# Every entry under the image's node_modules", start));
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", `docker() { return ${code}; }\n${block}\nprintf '%s/%s' "$typescript_present" "$rubic_present"`], { encoding: "utf8", env: { runtime_image: "fixture" } });
    if (code > 1) expect(result.status).toBe(code);
    else { expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(code === 0 ? "true/true" : "false/false"); }
  });
  it.each([
    ["IMAGE_USER", "0:0", "functionalPassed"], ["RUNTIME_UID", "0", "functionalPassed"], ["RUNTIME_IMPORTS_PASSED", "false", "functionalPassed"],
    ["TYPESCRIPT_PRESENT", "true", "productionDependencyPolicyPassed"], ["RUBIC_PRESENT", "true", "productionDependencyPolicyPassed"],
  ])("blocks a failed %s observation", (name, value, field) => {
    const path = join(scratch(), "policy.json");
    const result = spawnSync(process.execPath, ["-", path], { cwd: root, input: heredoc('node - "$artifact_stage/runtime-image-policy.json"'), encoding: "utf8",
      env: { IMAGE_USER: "10001:10001", RUNTIME_UID: "10001", RUNTIME_IMPORTS_PASSED: "true", TYPESCRIPT_PRESENT: "false", RUBIC_PRESENT: "false", [name]: value } });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(readFileSync(path, "utf8"))[field]).toBe(false);
  });
  it("refuses to nest new evidence under an existing result on repeat", () => {
    const directory = scratch(); const stage = join(directory, "stage"); const output = join(directory, "output"); mkdirSync(stage); mkdirSync(output);
    writeFileSync(join(stage, "acceptance-summary.json"), "new"); writeFileSync(join(output, "acceptance-summary.json"), "old");
    const text = source(); const marker = text.indexOf("# Publish evidence without nesting");
    const block = text.slice(marker < 0 ? text.indexOf('\nmv "$artifact_stage"') : marker, text.indexOf("disposition_status=0"));
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", block], { encoding: "utf8", env: { artifact_stage: stage, output_dir: output } });
    expect(result.status).not.toBe(0); expect(readFileSync(join(output, "acceptance-summary.json"), "utf8")).toBe("old");
    expect(existsSync(join(output, "stage"))).toBe(false);
  });
  it("keeps a sole baselined pqcrypto image mismatch baseline-only", () => {
    const fixture = join(root, "test/scripts/fixtures/registry-container-5c27c28");
    const read = (name: string) => readFileSync(join(fixture, name === "engine-strict.log" ? name + ".txt" : name), "utf8");
    const lock = JSON.parse(read("generated-package-lock.json")); delete lock.packages["node_modules/typescript"];
    for (const entry of Object.values(lock.packages)) {
      if (typeof entry === "object" && entry !== null) for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const map = Reflect.get(entry, field); if (typeof map === "object" && map !== null) Reflect.deleteProperty(map, "typescript");
      }
    }
    const inventory = JSON.parse(read("runtime-image-inventory.json")); inventory.packages = inventory.packages.filter((item: { name: string }) => item.name !== "typescript");
    const image = { ...JSON.parse(read("runtime-image-policy.json")), typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true };
    const overrides: Record<string, string> = { "generated-package-lock.json": JSON.stringify(lock), "runtime-image-inventory.json": JSON.stringify(inventory), "runtime-image-policy.json": JSON.stringify(image) };
    const findings = extractPolicyFindings((name: string) => overrides[name] ?? read(name));
    expect(findings.productionImageDependencies.map((item: { name: string }) => item.name)).toEqual(["pqcrypto"]);
    const result = compose({ "policy-findings.json": JSON.stringify(findings), "runtime-image-policy.json": JSON.stringify(image),
      "dependency-policy.json": read("dependency-policy.json"), "engine-strict.exit-code": "1\n", "consumer-lock-sbom.exit-code": "1\n", "consumer-physical-sbom.exit-code": "1\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(registryContainerDisposition({ ...result.summary, complete: true }, undefined, { packageVersion: "0.1.0-test" })).toMatchObject({ exitCode: 4, checks: { productionImage: "baseline" } });
  });
});
