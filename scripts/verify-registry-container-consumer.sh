#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify-registry-container-consumer.sh --output-dir <new-directory>" >&2
  exit 2
}

if [ "$#" -ne 2 ] || [ "$1" != "--output-dir" ] || [ -z "$2" ]; then
  usage
fi

repo_root=$(cd "$(dirname "$0")/.." && pwd)
output_dir=$2
case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  echo "output directory already exists: $output_dir" >&2
  exit 2
fi
if [ ! -d "$(dirname "$output_dir")" ]; then
  echo "output directory parent does not exist" >&2
  exit 2
fi

# The stage names the step a failure stopped in; the failure summary written on
# exit classifies it as network, policy or functional from that stage's evidence.
stage=preflight
for command in curl docker npm node; do
  command -v "$command" >/dev/null
done
source "$repo_root/scripts/bounded-http.sh"

source "$repo_root/scripts/bounded-transport.sh"
source "$repo_root/scripts/registry-container-registry.sh"
# Shell daemon calls, including cleanup, share the command deadline.
docker() {
  run_bounded docker "$@" 2> >(tee -a "${registry_log:-/dev/null}" >&2)
}
docker compose version >/dev/null

temp_parent=/tmp
if [ -n "${RUNNER_TEMP-}" ]; then
  temp_parent=$RUNNER_TEMP
fi
acceptance_root=$(mktemp -d "$temp_parent/dacs-registry-acceptance.XXXXXX")
release_set="$acceptance_root/release-set"
registry_config="$acceptance_root/verdaccio.yaml"
consumer_root="$acceptance_root/consumer"
artifact_stage="$acceptance_root/artifacts"
mkdir "$consumer_root" "$artifact_stage"
registry_log="$artifact_stage/registry.log"

run_id=local
run_attempt=0
if [ -n "${GITHUB_RUN_ID-}" ]; then
  run_id=$GITHUB_RUN_ID
fi
if [ -n "${GITHUB_RUN_ATTEMPT-}" ]; then
  run_attempt=$GITHUB_RUN_ATTEMPT
fi
suffix=$(printf '%s-%s-%s' "$run_id" "$run_attempt" "$$" | tr -cd 'a-zA-Z0-9_.-')
registry_container="dacs-registry-$suffix"
registry_network="dacs-registry-$suffix"
runtime_image="dacs-one-click-acceptance:$suffix"
registry_started=0
network_started=0
image_started=0
output_reserved=0

cleanup() {
  local status=$?
  local evidence_exported=$output_reserved
  # A failed evidence write must not skip the Docker cleanup below or replace
  # the original exit status.
  set +e
  if [ "${stage-}" = consumer ] && [ -f "$consumer_root/dependency-policy.exit-code" ] &&
      [ "$(cat "$consumer_root/dependency-policy.exit-code")" != 0 ]; then
    stage=dependency-policy
  fi
  # Preserve only collected, secret-free evidence, including on early failure.
  if [ -d "$artifact_stage" ]; then
    # These are the same secret-free diagnostics exported on a complete run.
    for name in generated-tests.exit-code doctor.log doctor.json doctor.exit-code npm-audit.json \
      npm-audit.exit-code consumer-lock.cdx.json \
      consumer-lock-sbom.err consumer-lock-sbom.exit-code consumer-physical.cdx.json \
      consumer-physical-sbom.err consumer-physical-sbom.exit-code engine-strict.log \
      engine-strict.exit-code engine-versions.json; do
      if [ -f "$consumer_root/$name" ]; then
        cp "$consumer_root/$name" "$artifact_stage/" || evidence_exported=0
      fi
    done
    for name in package.json package-lock.json; do
      if [ -f "$consumer_root/one-click-agent/$name" ]; then
        cp "$consumer_root/one-click-agent/$name" "$artifact_stage/generated-$name" || evidence_exported=0
      fi
    done
    for name in release-provenance.json SHA256SUMS; do
      if [ -f "$release_set/$name" ]; then
        cp "$release_set/$name" "$artifact_stage/" || evidence_exported=0
      fi
    done
    printf '%s\n' "$status" > "$artifact_stage/acceptance.exit-code" || evidence_exported=0
    # A run that stopped before its summary records why: network, policy or
    # functional, with the same classification as a log annotation.
    if [ "$status" -ne 0 ] && [ ! -f "$artifact_stage/acceptance-summary.json" ]; then
      node "$repo_root/scripts/registry-container-disposition.mjs" --failure-summary \
        "$artifact_stage" "$stage" "$status" || evidence_exported=0
    fi
    if [ "$output_reserved" -eq 1 ] && mv -T -- "$artifact_stage" "$output_dir"; then
      registry_log="$output_dir/registry.log"
      echo "partial acceptance evidence: $output_dir" >&2
    else
      evidence_exported=0
    fi
  fi
  if [ "$evidence_exported" -eq 0 ]; then echo "could not completely export evidence; retained at $acceptance_root" >&2; fi
  if [ "$registry_started" -eq 1 ]; then
    docker rm --force "$registry_container" >/dev/null 2>&1 || true
  fi
  if [ "$image_started" -eq 1 ]; then
    docker image rm --force "$runtime_image" >/dev/null 2>&1 || true
  fi
  if [ "$network_started" -eq 1 ]; then
    docker network rm "$registry_network" >/dev/null 2>&1 || true
  fi
  if [ "$evidence_exported" -eq 1 ]; then
    rm -rf -- "$acceptance_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# mkdir reserves the destination atomically before any run can export to it.
mkdir -- "$output_dir"
output_reserved=1

# The runner supplies bash, curl, Docker and Compose; record their versions
# with the evidence. A query that fails records its error and does not stop
# the run.
{
  printf 'bash %s\n' "$BASH_VERSION"
  curl --version
  docker version --format 'docker client {{.Client.Version}}, server {{.Server.Version}}'
  docker compose version
} > "$artifact_stage/runner-tools.txt" 2>&1 || true

# The release set and the run's own registry, with exactly its candidates published.
write_registry_config
cd "$repo_root"
build_release_set
start_registry
wait_for_registry
authenticate_registry
publish_release_set

stage=consumer
# The generator arguments are recorded in the summary from these values.
generated_mode=live-demos
generated_role=seller
generated_rails=both
run_bounded docker run --rm \
  "${consumer_network_args[@]}" \
  --volume "$consumer_root:/work" \
  --volume "$bounded_support:/acceptance-support:ro" \
  --volume "$repo_root/scripts:/acceptance-sdk/scripts:ro" \
  --volume "$repo_root/package.json:/acceptance-sdk/package.json:ro" \
  --volume "$release_set:/release-set:ro" \
  --volume "$artifact_stage:/acceptance-artifacts" \
  --workdir /work \
  --env DACS_PACKAGE_VERSION="$version" \
  --env DACS_GENERATED_MODE="$generated_mode" \
  --env DACS_GENERATED_ROLE="$generated_role" \
  --env DACS_GENERATED_RAILS="$generated_rails" \
  --env DACS_HOST_UID="$host_uid" \
  --env DACS_HOST_GID="$host_gid" \
  --env npm_config_registry="$consumer_registry" \
  --env npm_config_audit=false \
  --env npm_config_fund=false \
  --env npm_config_omit=optional \
  --env DACS_BOUNDED_NPM_HTTP=1 \
  --env NODE_OPTIONS=--require=/acceptance-support/bounded-npm-http.cjs \
  --env npm_config_fetch_timeout="$npm_config_fetch_timeout" \
  --env npm_config_fetch_retries="$npm_config_fetch_retries" \
  --env npm_config_fetch_retry_mintimeout="$npm_config_fetch_retry_mintimeout" \
  --env npm_config_fetch_retry_maxtimeout="$npm_config_fetch_retry_maxtimeout" \
  "$consumer_image" \
  sh -ceu '
    restore_host_ownership() {
      chown -R "$DACS_HOST_UID:$DACS_HOST_GID" /work /acceptance-artifacts || true
    }
    trap restore_host_ownership EXIT
    npm install --global --ignore-scripts npm@11.19.0
    npm create "dacs-agent@$DACS_PACKAGE_VERSION" one-click-agent -- \
      --yes \
      --mode "$DACS_GENERATED_MODE" \
      --profile dacs-sdk:fixed-price-x402:v1 \
      --rails "$DACS_GENERATED_RAILS" \
      --role "$DACS_GENERATED_ROLE" \
      --deploy docker --no-install
    cd one-click-agent
    npm install --ignore-scripts
    dependency_status=0
    node /acceptance-sdk/scripts/registry-container-disposition.mjs --dependency-policy "$PWD" "$npm_config_registry" \
      /acceptance-artifacts/dependency-policy.json /release-set "$DACS_PACKAGE_VERSION" || dependency_status=$?
    printf "%s\n" "$dependency_status" > /work/dependency-policy.exit-code
    test "$dependency_status" -eq 0
    npm rebuild better-sqlite3
    tests_status=0
    { npm run build && npm test; } || tests_status=$?
    printf "%s\n" "$tests_status" > /work/generated-tests.exit-code
    test "$tests_status" -eq 0
    doctor_status=0
    DACS_DEPLOYMENT=local DACS_SELLER_PUBLIC_BASE_URL=https://seller.example/engage \
      npm run --silent dacs:doctor -- --json > /work/doctor.json 2> /work/doctor.log || doctor_status=$?
    printf "%s\n" "$doctor_status" > /work/doctor.exit-code
    test "$doctor_status" -eq 5
    audit_status=0
    npm audit --registry https://registry.npmjs.org --omit=dev --json > /work/npm-audit.json || audit_status=$?
    printf "%s\n" "$audit_status" > /work/npm-audit.exit-code
    physical_status=0
    npm sbom --sbom-format cyclonedx --omit=dev > /work/consumer-physical.cdx.json 2> /work/consumer-physical-sbom.err || physical_status=$?
    printf "%s\n" "$physical_status" > /work/consumer-physical-sbom.exit-code
    mkdir /work/lock-only
    cp package.json package-lock.json /work/lock-only/
    cd /work/lock-only
    lock_status=0
    npm sbom --package-lock-only --sbom-format cyclonedx --omit=dev > /work/consumer-lock.cdx.json 2> /work/consumer-lock-sbom.err || lock_status=$?
    printf "%s\n" "$lock_status" > /work/consumer-lock-sbom.exit-code
    engine_status=0
    npm ci --package-lock-only --ignore-scripts --omit=optional --engine-strict > /work/engine-strict.log 2>&1 || engine_status=$?
    printf "%s\n" "$engine_status" > /work/engine-strict.exit-code
    # --engine-strict stops at the first violation. The disposition lists them
    # all from the lock against these versions; npm ci without it fails its
    # lock sync check on the nested Git dependency instead.
    node -p "JSON.stringify({ node: process.version, npm: process.argv[1] })" "$(npm --version)" > /work/engine-versions.json
  ' 2>&1 | tee "$artifact_stage/generation.log"

project="$consumer_root/one-click-agent"
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
  node "$bounded_support/bounded-command.mjs" "$COMMAND_TIMEOUT_SECONDS" 1 docker compose --env-file /dev/null --file "$project/compose.yaml" config \
    > "$artifact_stage/compose.rendered.yaml"

stage=image-build
# BuildKit reports progress and npm errors on stderr; keep both in the log.
node scripts/bounded-build.mjs "$project"
image_started=1
run_bounded docker build \
  --file "$project/Dockerfile.acceptance" \
  "${build_network_args[@]}" \
  --tag "$runtime_image" \
  "$project" \
  2>&1 | tee "$artifact_stage/docker-build.log"
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

# Publish evidence only into the directory this run reserved.
if [ "$output_reserved" -ne 1 ] || [ ! -d "$output_dir" ] || [ -L "$output_dir" ]; then
  echo "output directory already exists: $output_dir" >&2
  exit 2
fi
mv -T -- "$artifact_stage" "$output_dir"
registry_log="$output_dir/registry.log"
disposition_status=0
# --record adds the disposition and failure class to the summary.
node scripts/registry-container-disposition.mjs --record "$output_dir/acceptance-summary.json" \
  || disposition_status=$?
echo "acceptance evidence: $output_dir"
exit "$disposition_status"
