#!/usr/bin/env bash
set -euo pipefail
acceptance_main() {
project="$consumer_root/one-click-agent"
stage=dependency-policy
# Registry packages only (an allowlist over the manifest and every lock entry),
# and every candidate copy is the packed tarball release-provenance.json records.
node scripts/registry-container-disposition.mjs --dependency-policy "$project" "$consumer_registry" \
  "$artifact_stage/dependency-policy.json" "$release_set" "$version"

stage=audit-policy
# Directness comes from the audited lock, not npm's name-level flag.
node scripts/registry-container-disposition.mjs --audit-policy \
  "$consumer_root/npm-audit.json" "$project/package-lock.json" "$artifact_stage/audit-policy.json"

stage=compose
# Inert Compose inputs: these are deliberately invalid credentials and drafts,
# used only for config rendering. No live services or compose up are invoked.
compose_inputs="$acceptance_root/compose-inputs"
mkdir -p "$compose_inputs/buyer-data" "$compose_inputs/seller-data"
for name in buyer-demos seller-demos buyer-evm seller-evm wallet-token listing-x402.json listing-pay-dem.json; do
  # Created 0600 rather than narrowed afterwards.
  (umask 077 && printf '%s\n' 'acceptance-placeholder' > "$compose_inputs/$name")
  chmod 0600 "$compose_inputs/$name"
done

env \
  -i PATH="$PATH" HOME="$compose_inputs" \
  DACS_WALLET_AUTHORITY_URL=http://127.0.0.1:1 \
  DACS_WALLET_AUTHORITY_ID=acceptance-placeholder \
  DACS_WALLET_AUTHORITY_EPOCH=acceptance-placeholder \
  DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY=acceptance-placeholder \
  DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE="$compose_inputs/wallet-token" \
  DACS_RUNTIME_UID=10001 \
  DACS_RUNTIME_GID=10001 \
  DACS_BUYER_DATA_DIRECTORY="$compose_inputs/buyer-data" \
  DACS_SELLER_DATA_DIRECTORY="$compose_inputs/seller-data" \
  DACS_BUYER_DEMOS_SECRET_FILE="$compose_inputs/buyer-demos" \
  DACS_SELLER_DEMOS_SECRET_FILE="$compose_inputs/seller-demos" \
  DACS_BUYER_EVM_SECRET_FILE="$compose_inputs/buyer-evm" \
  DACS_SELLER_EVM_SECRET_FILE="$compose_inputs/seller-evm" \
  DACS_X402_LISTING_DRAFT_FILE="$compose_inputs/listing-x402.json" \
  DACS_PAY_DEM_LISTING_DRAFT_FILE="$compose_inputs/listing-pay-dem.json" \
  docker compose --env-file /dev/null --file "$project/compose.yaml" config \
    > "$artifact_stage/compose.rendered.yaml"

stage=image-build
# BuildKit reports progress and npm errors on stderr; keep both in the log.
docker build \
  "${build_network_args[@]}" \
  --tag "$runtime_image" \
  "$project" \
  2>&1 | tee "$artifact_stage/docker-build.log"
image_started=1

stage=image-policy

docker image inspect "$runtime_image" > "$artifact_stage/docker-image.json"
image_user=$(docker image inspect --format '{{.Config.User}}' "$runtime_image")
runtime_uid=$(docker run --rm --entrypoint id "$runtime_image" -u)
image_package_present() {
  local probe_status=0
  docker run --rm --entrypoint test "$runtime_image" -d "node_modules/$1" || probe_status=$?
  case "$probe_status" in
    0) echo true ;;
    1) echo false ;;
    *) return "$probe_status" ;;
  esac
}
typescript_present=$(image_package_present typescript)
rubic_present=$(image_package_present rubic-sdk)
# Every entry under the image's node_modules, read inside the image by a
# dependency-free script mounted read-only. The disposition compares it with
# the lock's production closure, so a package outside that closure blocks.
docker run --rm --entrypoint node \
  --volume "$repo_root/scripts/runtime-image-inventory.mjs:/opt/dacs-acceptance/runtime-image-inventory.mjs:ro" \
  "$runtime_image" /opt/dacs-acceptance/runtime-image-inventory.mjs . \
  > "$artifact_stage/runtime-image-inventory.json"
runtime_imports_passed=false
if docker run --rm --entrypoint sh "$runtime_image" -ceu '
  node --import @kynesyslabs/dacs-node/demos-loader --input-type=module -e "
    Promise.all([
      import(\"@kynesyslabs/dacs\"),
      import(\"@kynesyslabs/dacs-node\"),
      import(\"@kynesyslabs/dacs-node/sqlite\")
    ]).then(([core, host, sqlite]) => {
      if (typeof core.createAgent !== \"function\") process.exit(1);
      if (typeof host.runDacsLiveDoctorV1 !== \"function\") process.exit(1);
      if (typeof sqlite.openDacsNodeSqliteDatabase !== \"function\") process.exit(1);
    });
  "
'; then
  runtime_imports_passed=true
fi

IMAGE_USER="$image_user" \
RUNTIME_UID="$runtime_uid" \
TYPESCRIPT_PRESENT="$typescript_present" \
RUBIC_PRESENT="$rubic_present" \
RUNTIME_IMPORTS_PASSED="$runtime_imports_passed" \
  node - "$artifact_stage/runtime-image-policy.json" <<'NODE'
const fs = require("node:fs");
const policy = {
  schema: "dacs-runtime-image-policy/v1",
  expectedUser: "10001:10001",
  observedUser: process.env.IMAGE_USER,
  observedUid: process.env.RUNTIME_UID,
  runtimeImportsPassed: process.env.RUNTIME_IMPORTS_PASSED === "true",
  typescriptPresent: process.env.TYPESCRIPT_PRESENT === "true",
  rubicSdkPresent: process.env.RUBIC_PRESENT === "true",
};
policy.functionalPassed = policy.observedUser === policy.expectedUser &&
  policy.observedUid === "10001" && policy.runtimeImportsPassed;
policy.productionDependencyPolicyPassed = !policy.typescriptPresent &&
  !policy.rubicSdkPresent;
fs.writeFileSync(process.argv[2], JSON.stringify(policy, null, 2) + "\n");
NODE

cp "$release_set/release-provenance.json" "$artifact_stage/"
cp "$release_set/SHA256SUMS" "$artifact_stage/"
cp "$project/package.json" "$artifact_stage/generated-package.json"
cp "$project/package-lock.json" "$artifact_stage/generated-package-lock.json"
cp "$consumer_root/generated-tests.exit-code" "$artifact_stage/"
cp "$consumer_root/doctor.log" "$artifact_stage/"
cp "$consumer_root/doctor.json" "$artifact_stage/"
cp "$consumer_root/doctor.exit-code" "$artifact_stage/"
cp "$consumer_root/npm-audit.json" "$artifact_stage/"
cp "$consumer_root/npm-audit.exit-code" "$artifact_stage/"
cp "$consumer_root/consumer-lock.cdx.json" "$artifact_stage/"
cp "$consumer_root/consumer-lock-sbom.err" "$artifact_stage/"
cp "$consumer_root/consumer-lock-sbom.exit-code" "$artifact_stage/"
cp "$consumer_root/consumer-physical.cdx.json" "$artifact_stage/"
cp "$consumer_root/consumer-physical-sbom.err" "$artifact_stage/"
cp "$consumer_root/consumer-physical-sbom.exit-code" "$artifact_stage/"
cp "$consumer_root/engine-strict.log" "$artifact_stage/"
cp "$consumer_root/engine-strict.exit-code" "$artifact_stage/"
cp "$consumer_root/engine-versions.json" "$artifact_stage/"

stage=summary
# Exact identities of the security-gate findings, compared with the #191
# baseline by the disposition.
node scripts/registry-container-disposition.mjs --policy-findings \
  "$artifact_stage" "$artifact_stage/policy-findings.json"

node - "$artifact_stage" "$version" "$runtime_image" \
  "$generated_mode" "$generated_role" "$generated_rails" <<'NODE'
(async () => {
const { runDacsLiveDoctorV1 } = await import("./packages/dacs-node/dist/doctor.js");
const { canonicalize, sha256Hex } = await import("./dist/canonical/index.js");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const version = process.argv[3];
const image = process.argv[4];
const [generatedMode, generatedRole, generatedRails] = process.argv.slice(5);
const inspect = JSON.parse(fs.readFileSync(path.join(root, "docker-image.json"), "utf8"))[0];
const audit = JSON.parse(fs.readFileSync(path.join(root, "npm-audit.json"), "utf8"));
const dependencyPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "dependency-policy.json"), "utf8"),
);
const auditPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "audit-policy.json"), "utf8"),
);
const runtimeImagePolicy = JSON.parse(
  fs.readFileSync(path.join(root, "runtime-image-policy.json"), "utf8"),
);
const policyFindings = JSON.parse(
  fs.readFileSync(path.join(root, "policy-findings.json"), "utf8"),
);
// Compose only evidence of the shape its producer writes, for this release.
for (const [name, evidence, schema] of [
  ["dependency-policy.json", dependencyPolicy, "dacs-registry-dependency-policy/v1"],
  ["audit-policy.json", auditPolicy, "dacs-registry-audit-policy/v1"],
  ["runtime-image-policy.json", runtimeImagePolicy, "dacs-runtime-image-policy/v1"],
  ["policy-findings.json", policyFindings, "dacs-registry-policy-findings/v1"],
]) {
  if (evidence?.schema !== schema) throw new Error(`${name} is not ${schema}`);
}
const provenance = JSON.parse(
  fs.readFileSync(path.join(root, "release-provenance.json"), "utf8"),
);
if (provenance?.version !== version) {
  throw new Error(`release-provenance.json is not for version ${version}`);
}
const exitCode = name => {
  const text = fs.readFileSync(path.join(root, name), "utf8").trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) > 255) throw new Error(`${name}: invalid shell exit status`);
  return Number(text);
};
const engineStrictExitCode = exitCode("engine-strict.exit-code");
const auditExitCode = exitCode("npm-audit.exit-code");
const lockSbomExitCode = exitCode("consumer-lock-sbom.exit-code");
const physicalSbomExitCode = exitCode("consumer-physical-sbom.exit-code");
const generatedTestsExitCode = exitCode("generated-tests.exit-code");
const doctorExitCode = exitCode("doctor.exit-code");
// The image gate covers the complete inventory, including identity mismatches.
const inventory = policyFindings.productionImageInventory;
runtimeImagePolicy.productionDependencyPolicyPassed = runtimeImagePolicy.productionDependencyPolicyPassed === true &&
  inventory?.scanComplete === true && Array.isArray(inventory.errors) && inventory.errors.length === 0 &&
  Array.isArray(inventory.missing) && inventory.missing.length === 0 &&
  Array.isArray(policyFindings.productionImageDependencies) && policyFindings.productionImageDependencies.length === 0;
fs.writeFileSync(path.join(root, "runtime-image-policy.json"), JSON.stringify(runtimeImagePolicy, null, 2) + "\n");
const generatedTestsPassed = generatedTestsExitCode === 0;
const doctorReport = JSON.parse(fs.readFileSync(path.join(root, "doctor.json"), "utf8"));
const doctorChecks = Array.isArray(doctorReport?.checks) ? doctorReport.checks : [];
const requiredDoctorChecks = doctorChecks.filter(check => check?.required === true);
const credentialBlocks = new Map([
  ["local.secrets", "role-secret-file-missing"],
  ["local.sqlite", "actor-authority-missing"],
  ["local.authority-separation", "actor-authority-missing"],
  ...["local.transport-identities", "demos.rpc-chain", "demos.storage-read", "demos.binding-resolution",
    "demos.wallet-identity", "x402.rail-authority", "x402.endpoints", "x402.token-domain", "pay-dem.rail-authority"]
    .map(id => [id, "role-demos-runtime-unavailable"]),
]);
const requiredDoctorPasses = ["local.node-version", "local.package-integrity", "local.version-bindings",
  "local.configuration", "local.data-directory", "local.disk-space", "local.deployment-runtime"];
const blockedDoctorChecks = requiredDoctorChecks.filter(check => check.status === "blocked");
// Use this checkout's shipped catalog and requirement rules, without running probes.
const expectedDoctor = await runDacsLiveDoctorV1({
  phase: "pre-start", scope: "start", sdkVersion: version,
  standardRevision: "acceptance", profile: "acceptance", now: () => 0,
  enabledRailProfiles: generatedRails === "both" ? ["x402", "pay-dem"] : [generatedRails],
});
const completeDoctorChecks = doctorChecks.length === expectedDoctor.checks.length &&
  expectedDoctor.checks.every(expected => doctorChecks.some(check => check?.id === expected.id &&
    check.required === expected.required && check.category === expected.category &&
    ["pass", "fail", "blocked"].includes(check.status) && typeof check.summary === "string" &&
    Number.isFinite(check.durationMs) && check.durationMs >= 0));
const { reportHash, ...doctorBody } = doctorReport;
const doctorIntegrityPassed = doctorReport.safety?.readOnly === true && doctorReport.safety?.funded === false &&
  doctorReport.sdkVersion === version && reportHash === sha256Hex(canonicalize(doctorBody));
const doctorBlockedWithoutCredentials = completeDoctorChecks && doctorIntegrityPassed && doctorExitCode === 5 && doctorReport?.exitCode === 5 &&
  doctorReport.schema === "dacs-live-doctor-report/v1" && doctorReport.phase === "pre-start" && doctorReport.scope === "start" &&
  doctorReport.gate?.status === "blocked" && doctorReport.gate.required === requiredDoctorChecks.length &&
  doctorReport.gate.failed === 0 && doctorReport.gate.blocked === blockedDoctorChecks.length &&
  doctorReport.gate.passed === requiredDoctorChecks.length - blockedDoctorChecks.length &&
  doctorChecks.every(check => typeof check?.required === "boolean" && typeof check.id === "string") &&
  new Set(doctorChecks.map(check => check.id)).size === doctorChecks.length &&
  requiredDoctorPasses.every(id => requiredDoctorChecks.some(check => check.id === id && check.status === "pass")) &&
  blockedDoctorChecks.some(check => check.id === "local.secrets" && check.reasonCode === "role-secret-file-missing") &&
  requiredDoctorChecks.every(check => check.status === "pass" ||
    (check.status === "blocked" && credentialBlocks.has(check.id) && credentialBlocks.get(check.id) === check.reasonCode));
const summary = {
  schema: "dacs-registry-container-acceptance/v1",
  complete: true,
  packageVersion: version,
  generatedMode,
  generatedRole,
  generatedRails: generatedRails === "both" ? ["x402", "pay-dem"] : [generatedRails],
  registryDependencyOnly: dependencyPolicy.passed === true &&
    Array.isArray(dependencyPolicy.violations) && dependencyPolicy.violations.length === 0,
  generatedTestsPassed,
  functionalPassed: runtimeImagePolicy.functionalPassed === true && generatedTestsPassed &&
    doctorBlockedWithoutCredentials,
  doctor: {
    expectedExitCode: 5,
    observedExitCode: doctorExitCode,
    disposition: doctorBlockedWithoutCredentials ? "blocked-without-credentials" : "unexpected",
  },
  docker: {
    image,
    id: inspect.Id,
    size: inspect.Size,
    user: inspect.Config.User,
    policy: runtimeImagePolicy,
  },
  audit: { ...audit.metadata.vulnerabilities,
    observedAdvisories: auditPolicy.observedAdvisories,
    unlistedAdvisories: auditPolicy.unlistedAdvisories,
    assessedAdvisories: auditPolicy.assessedAdvisories,
    directAdvisories: auditPolicy.directAdvisories,
  },
  securityGate: {
    productionPublicationBlockedBy: "DACS-Agent-commerce/dacs-sdk#191",
    passed: dependencyPolicy.passed &&
      runtimeImagePolicy.productionDependencyPolicyPassed &&
      engineStrictExitCode === 0 &&
      auditPolicy.passed === true && (auditExitCode === 0 ||
        (auditExitCode === 1 && auditPolicy.observedAdvisories.length > 0)) &&
      lockSbomExitCode === 0 && physicalSbomExitCode === 0,
    registryDependencyPolicyPassed: dependencyPolicy.passed,
    productionImageDependencyPolicyPassed:
      runtimeImagePolicy.productionDependencyPolicyPassed,
    engineStrictExitCode,
    auditExitCode,
    lockSbomExitCode,
    physicalSbomExitCode,
    findings: policyFindings,
  },
};
fs.writeFileSync(
  path.join(root, "acceptance-summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE

# Publish evidence without nesting under an earlier completed result.
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  echo "output directory already exists: $output_dir" >&2
  exit 2
fi
mv -T -- "$artifact_stage" "$output_dir"
disposition_status=0
# --record adds the disposition and failure class to the summary.
node scripts/registry-container-disposition.mjs --record "$output_dir/acceptance-summary.json" \
  || disposition_status=$?
echo "acceptance evidence: $output_dir"
exit "$disposition_status"
}
