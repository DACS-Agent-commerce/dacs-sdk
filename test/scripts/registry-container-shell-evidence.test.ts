import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
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
const doctorFixture = () => JSON.parse(readFileSync(join(root,
  "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
function encodeDoctor(report: Record<string, unknown>) {
  if (Array.isArray(report.checks)) {
    const required = report.checks.filter(check => check.required === true);
    report.gate = { status: "blocked", required: required.length,
      passed: required.filter(check => check.status === "pass").length,
      failed: required.filter(check => check.status === "fail").length,
      blocked: required.filter(check => check.status === "blocked").length };
  }
  const { reportHash, ...body } = report;
  return JSON.stringify({ ...body, reportHash: sha256Hex(canonicalize(body)) });
}
function compose(overrides: Record<string, string> = {}, rails = "both") {
  const stage = scratch();
  const consumer = scratch();
  const project = join(consumer, "one-click-agent"); mkdirSync(project);
  const release = scratch();
  const files = {
    "docker-image.json": JSON.stringify([{ Id: "fixture", Size: 1, Config: { User: "10001:10001" } }]),
    "npm-audit.json": JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }),
    "dependency-policy.json": JSON.stringify({ schema: "dacs-registry-dependency-policy/v1", passed: true, violations: [] }),
    "audit-policy.json": JSON.stringify({ schema: "dacs-registry-audit-policy/v1", passed: true, observedAdvisories: [], unlistedAdvisories: [], assessedAdvisories: [], directAdvisories: [] }),
    "runtime-image-policy.json": JSON.stringify({ schema: "dacs-runtime-image-policy/v1", functionalPassed: true,
      typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true }),
    "policy-findings.json": JSON.stringify({ schema: "dacs-registry-policy-findings/v1", gitDependencies: [], productionImageDependencies: [], productionImageInventory: { scanComplete: true, errors: [], missing: [] },
      engine: { exitCode: 0, code: null, scanComplete: true, violations: [] }, lockSbom: { exitCode: 0, code: null, problems: [] }, physicalSbom: { exitCode: 0, code: null, problems: [] } }),
    "release-provenance.json": JSON.stringify({ version: "0.1.0-test" }),
    "engine-strict.exit-code": "0\n", "npm-audit.exit-code": "0\n", "consumer-lock-sbom.exit-code": "0\n", "consumer-physical-sbom.exit-code": "0\n",
    "generated-tests.exit-code": "0\n", "doctor.exit-code": "5\n",
    "doctor.json": readFileSync(join(root, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"), ...overrides,
  };
  const consumerFiles = ["generated-tests.exit-code", "doctor.log", "doctor.exit-code", "doctor.json", "npm-audit.json",
    "npm-audit.exit-code", "consumer-lock.cdx.json", "consumer-lock-sbom.err", "consumer-lock-sbom.exit-code",
    "consumer-physical.cdx.json", "consumer-physical-sbom.err", "consumer-physical-sbom.exit-code", "engine-strict.log",
    "engine-strict.exit-code", "engine-versions.json"];
  for (const name of consumerFiles) writeFileSync(join(consumer, name), "fixture");
  for (const [name, value] of Object.entries(files)) {
    const destination = name === "release-provenance.json" ? release : consumerFiles.includes(name) ? consumer : stage;
    writeFileSync(join(destination, name), value);
  }
  writeFileSync(join(release, "SHA256SUMS"), "fixture");
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(project, name), "{}");
  const copyBlock = source().split('cp "$release_set/release-provenance.json"')[1]?.split("stage=summary")[0];
  expect(copyBlock).toBeDefined();
  const transfer = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", 'cp "$release_set/release-provenance.json"' + copyBlock],
    { encoding: "utf8", env: { PATH: process.env.PATH, release_set: release, project, consumer_root: consumer, artifact_stage: stage } });
  expect(transfer.status, transfer.stderr).toBe(0);
  const script = heredoc('node - "$artifact_stage" "$version" "$runtime_image"');
  expect(script).not.toBe("");
  const result = spawnSync(process.execPath, ["-", stage, "0.1.0-test", "image", "live-demos", "seller", rails], { cwd: root, input: script, encoding: "utf8" });
  return { ...result, transferredDoctor: existsSync(join(stage, "doctor.json")), summary: result.status === 0 ? JSON.parse(readFileSync(join(stage, "acceptance-summary.json"), "utf8")) : undefined };
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
  it("keeps a sole baselined pqcrypto image mismatch baseline-only", async () => {
    const fixture = join(root, "test/scripts/fixtures/registry-container-5c27c28");
    const read = (name: string) => readFileSync(join(fixture, name === "engine-strict.log" ? name + ".txt" : name), "utf8");
    const recorded = extractPolicyFindings(read);
    expect(recorded.productionImageInventory.scanComplete).toBe(false);
    const originalLock = JSON.parse(read("generated-package-lock.json"));
    const unresolved = Object.keys(originalLock.packages[""].dependencies)
      .filter(name => !originalLock.packages[`node_modules/${name}`]);
    expect(recorded.productionImageInventory.errors).toEqual(expect.arrayContaining(
      unresolved.map(name => `unresolved required dependency ${name} from <root>`)));
    const rejected = compose({ "policy-findings.json": JSON.stringify(recorded),
      "runtime-image-policy.json": read("runtime-image-policy.json"), "dependency-policy.json": read("dependency-policy.json"),
      "engine-strict.exit-code": "1\n", "consumer-lock-sbom.exit-code": "1\n", "consumer-physical-sbom.exit-code": "1\n" });
    expect(registryContainerDisposition({ ...rejected.summary, complete: true }, undefined, { packageVersion: "0.1.0-test" }))
      .toMatchObject({ exitCode: 3, checks: { productionImage: "blocked" } });
    const lock = JSON.parse(read("generated-package-lock.json")); delete lock.packages["node_modules/typescript"];
    for (const entry of Object.values(lock.packages)) {
      if (typeof entry === "object" && entry !== null) for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const map = Reflect.get(entry, field); if (typeof map === "object" && map !== null) Reflect.deleteProperty(map, "typescript");
      }
    }
    const inventory = JSON.parse(read("runtime-image-inventory.json")); inventory.packages = inventory.packages.filter((item: { name: string }) => item.name !== "typescript");
    // Fill every missing dependency with a synthetic leaf and matching observation.
    // These stand-ins model closure only; they do not claim a historical install.
    const semverModule = "semver";
    const { validRange, minVersion } = await import(semverModule);
    for (const entry of Object.values(lock.packages)) {
      if (typeof entry !== "object" || entry === null) throw new Error("Invalid simulated lock entry");
      const dependencies = Reflect.get(entry, "dependencies") ?? {};
      for (const [name, range] of Object.entries(dependencies)) {
        const location = `node_modules/${name}`;
        if (lock.packages[location]) continue;
        const version = typeof range === "string" && validRange(range) ? minVersion(range).version : "0.0.0";
        lock.packages[location] = { version };
        inventory.packages.push({ name, version, location });
      }
    }
    const image = { ...JSON.parse(read("runtime-image-policy.json")), typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: true };
    const overrides: Record<string, string> = { "generated-package-lock.json": JSON.stringify(lock), "runtime-image-inventory.json": JSON.stringify(inventory), "runtime-image-policy.json": JSON.stringify(image) };
    const findings = extractPolicyFindings((name: string) => overrides[name] ?? read(name));
    expect(findings.productionImageInventory).toMatchObject({ scanComplete: true, errors: [], missing: [] });
    // Both recorded mentions identify the same first engine failure.
    expect(findings.engine).toMatchObject({ scanComplete: true, reportedPackage: "@npmcli/agent@5.0.2" });
    expect(findings.productionImageDependencies.map((item: { name: string }) => item.name)).toEqual(["pqcrypto"]);
    const result = compose({ "policy-findings.json": JSON.stringify(findings), "runtime-image-policy.json": JSON.stringify(image),
      "dependency-policy.json": read("dependency-policy.json"), "engine-strict.exit-code": "1\n", "consumer-lock-sbom.exit-code": "1\n", "consumer-physical-sbom.exit-code": "1\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(registryContainerDisposition({ ...result.summary, complete: true }, undefined, { packageVersion: "0.1.0-test" })).toMatchObject({ exitCode: 4, checks: { productionImage: "baseline", engineStrict: "baseline" } });
  });
});


describe("doctor credential-only admission", () => {
  it("accepts the expected missing-secret block with every other required check passing", () => {
    expect(compose().summary.functionalPassed).toBe(true);
  });
  it.each(["docker-runtime-timeout", "docker-runtime-unavailable"])("blocks an unrelated doctor result: %s", reasonCode => {
    const report = JSON.parse(readFileSync(join(root, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
    const deployment = report.checks.find((item: { id: string }) => item.id === "local.deployment-runtime");
    Object.assign(deployment, { status: "blocked", reasonCode });
    report.gate.passed--; report.gate.blocked++;
    expect(compose({ "doctor.json": encodeDoctor(report) }).summary).toMatchObject({
      functionalPassed: false, doctor: { disposition: "unexpected" },
    });
  });
  it("rejects an unknown required block without a reason code", () => {
    const report = JSON.parse(readFileSync(join(root, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
    report.checks.push({ id: "unknown", required: true, status: "blocked" });
    report.gate.required++; report.gate.blocked++;
    expect(compose({ "doctor.json": encodeDoctor(report) }).summary.functionalPassed).toBe(false);
  });
  it("requires a report matching the expected phase and scope", () => {
    const report = JSON.parse(readFileSync(join(root, "test/scripts/fixtures/registry-container-doctor-without-credentials.json"), "utf8"));
    report.scope = "buy";
    expect(compose({ "doctor.json": encodeDoctor(report) }).summary.functionalPassed).toBe(false);
  });
});


describe("complete doctor evidence", () => {
  it("transfers the complete doctor report from the consumer before summary composition", () => {
    const result = compose();
    expect(result.transferredDoctor).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary.functionalPassed).toBe(true);
  });
  it.each(["local.sqlite", "local.authority-separation", "local.transport-identities", "x402.testnet-policy"])(
    "rejects an omitted required check with consistent counts and hash: %s", id => {
      const report = doctorFixture();
      report.checks = report.checks.filter((check: { id: string }) => check.id !== id);
      expect(compose({ "doctor.json": encodeDoctor(report) }).summary.functionalPassed).toBe(false);
    });
  it("rejects a failed check downgraded to optional with consistent counts and hash", () => {
    const report = doctorFixture();
    const check = report.checks.find((check: { id: string }) => check.id === "x402.testnet-policy");
    if (!check) throw new Error("missing testnet-policy fixture");
    Object.assign(check, { required: false, status: "fail", reasonCode: "fixture-policy-failure" });
    expect(compose({ "doctor.json": encodeDoctor(report) }).summary.functionalPassed).toBe(false);
  });
  it.each(["readOnly", "funded", "missing"])("rejects invalid safety evidence: %s", field => {
    const report = doctorFixture();
    if (field === "missing") delete report.safety;
    else report.safety[field] = field === "funded";
    expect(compose({ "doctor.json": encodeDoctor(report) }).summary.functionalPassed).toBe(false);
  });
  it.each(["missing", "mismatch"])("rejects a %s doctor hash", kind => {
    const report = doctorFixture();
    if (kind === "missing") delete report.reportHash;
    else report.reportHash = "0".repeat(64);
    expect(compose({ "doctor.json": JSON.stringify(report) }).summary.functionalPassed).toBe(false);
  });
});

it("preserves a full report emitted by the shipped doctor producer", async () => {
  const modulePath = "../../packages/dacs-node/dist/doctor.js";
  const { runDacsLiveDoctorV1 } = await import(modulePath);
  const fixture = doctorFixture();
  const report = await runDacsLiveDoctorV1({
    phase: "pre-start", scope: "start", sdkVersion: fixture.sdkVersion,
    standardRevision: fixture.standardRevision, profile: fixture.profile, now: () => 0,
    enabledRailProfiles: ["x402", "pay-dem"],
    probes: Object.fromEntries(fixture.checks.map((check: { id: string; status: string; reasonCode?: string }) =>
      [check.id, () => check.status === "pass" ? { status: "pass" } : { status: check.status, reasonCode: check.reasonCode }])),
  });
  expect(report).toEqual(fixture);
});

it.each(["x402", "pay-dem"])("requires the shipped doctor flags for generated rail %s", async rail => {
  const modulePath = "../../packages/dacs-node/dist/doctor.js";
  const { runDacsLiveDoctorV1 } = await import(modulePath);
  const fixture = doctorFixture();
  const report = await runDacsLiveDoctorV1({
    phase: "pre-start", scope: "start", sdkVersion: fixture.sdkVersion,
    standardRevision: fixture.standardRevision, profile: fixture.profile, now: () => 0,
    enabledRailProfiles: [rail],
    probes: Object.fromEntries(fixture.checks.map((check: { id: string; status: string; reasonCode?: string }) =>
      [check.id, () => check.status === "pass" ? { status: "pass" } : { status: check.status, reasonCode: check.reasonCode }])),
  });
  expect(compose({ "doctor.json": JSON.stringify(report) }, rail).summary.functionalPassed).toBe(true);
  expect(compose({}, rail).summary.functionalPassed).toBe(false);
});
