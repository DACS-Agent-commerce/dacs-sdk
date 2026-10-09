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
if [ -e "$output_dir" ]; then
  echo "output directory already exists: $output_dir" >&2
  exit 2
fi
if [ ! -d "$(dirname "$output_dir")" ]; then
  echo "output directory parent does not exist" >&2
  exit 2
fi

for command in curl docker npm node; do
  command -v "$command" >/dev/null
done
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
acceptance_stage=release_set

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

cleanup() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ] && [ -d "$artifact_stage" ] && [ ! -e "$output_dir" ]; then
    printf '{"stage":"%s","exitCode":%s}\n' "$acceptance_stage" "$exit_status" \
      > "$artifact_stage/acceptance-failure.json" || true
    mv -- "$artifact_stage" "$output_dir" || true
  fi
  if [ "$registry_started" -eq 1 ]; then
    docker rm --force "$registry_container" >/dev/null 2>&1 || true
  fi
  if [ "$image_started" -eq 1 ]; then
    docker image rm --force "$runtime_image" >/dev/null 2>&1 || true
  fi
  if [ "$network_started" -eq 1 ]; then
    docker network rm "$registry_network" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$acceptance_root"
}
trap cleanup EXIT INT TERM

cat > "$registry_config" <<'YAML'
storage: /verdaccio/storage
web:
  enable: false
auth:
  htpasswd:
    file: /verdaccio/conf/htpasswd
    max_users: 2
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@kynesyslabs/*':
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
  'create-dacs-agent':
    access: $all
    publish: $all
    unpublish: $all
  '**':
    access: $all
    publish: $all
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
listen: 0.0.0.0:4873
YAML
# The bind-mounted file is intentionally secret-free and must be readable by
# Verdaccio's non-root container user on Linux runners.
chmod 0644 "$registry_config"

cd "$repo_root"
npm run conformance:sync
npm run release:set:verify -- --output-dir "$release_set"

version=$(node -p "require('./package.json').version")
node - "$release_set/release-provenance.json" "$version" <<'NODE'
const fs = require("node:fs");
const provenance = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (provenance.version !== process.argv[3] || provenance.source.clean !== true) {
  throw new Error("release-set provenance is not clean or version-aligned");
}
NODE

docker network create "$registry_network" >/dev/null
network_started=1
acceptance_stage=registry_start
docker run --detach \
  --name "$registry_container" \
  --network "$registry_network" \
  --publish 127.0.0.1::4873 \
  --volume "$registry_config:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio@sha256:fcb86134563534e2f634752e6c6c3edcdb78242ec16578c73ce39d1dadbaa801 \
  >/dev/null
registry_started=1

host_port=$(docker inspect --format \
  '{{(index (index .NetworkSettings.Ports "4873/tcp") 0).HostPort}}' \
  "$registry_container")
case "$host_port" in
  ''|*[!0-9]*) echo "Verdaccio host port is invalid" >&2; exit 1 ;;
esac
host_registry="http://127.0.0.1:$host_port"
consumer_registry="http://host.docker.internal:$host_port"
consumer_network_args=(--add-host host.docker.internal:host-gateway)
build_network_args=(--add-host host.docker.internal:host-gateway)
host_uid=$(id -u)
host_gid=$(id -g)
case "$host_uid:$host_gid" in
  *[!0-9:]*) echo "host uid/gid is invalid" >&2; exit 1 ;;
esac
if [ "$(uname -s)" = "Linux" ]; then
  consumer_registry=$host_registry
  consumer_network_args=(--network host)
  build_network_args=(--network host)
fi

ready=0
for attempt in $(seq 1 30); do
  if curl --silent --fail "$host_registry/-/ping" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs "$registry_container" >&2
  exit 1
fi

auth_response=$(curl --silent --show-error --fail \
  --request PUT "$host_registry/-/user/org.couchdb.user:dacs-ci" \
  --header 'content-type: application/json' \
  --data '{"name":"dacs-ci","password":"local-acceptance-only","email":"ci@example.invalid","type":"user","roles":[]}')
auth_token=$(AUTH_RESPONSE="$auth_response" node -e '
const value = JSON.parse(process.env.AUTH_RESPONSE);
if (typeof value.token !== "string" || value.token.length < 8) process.exit(1);
process.stdout.write(value.token);
')

for package in \
  "$release_set/kynesyslabs-dacs-$version.tgz" \
  "$release_set/kynesyslabs-dacs-node-$version.tgz" \
  "$release_set/create-dacs-agent-$version.tgz"
do
  acceptance_stage=local_publish
  test -f "$package"
  DACS_LOCAL_REGISTRY_TOKEN="$auth_token" \
    node scripts/publish-exact-local-registry.mjs "$package" "$host_registry"
done

for package_name in @kynesyslabs/dacs @kynesyslabs/dacs-node create-dacs-agent; do
  observed=$(npm view "$package_name@$version" version --registry "$host_registry")
  test "$observed" = "$version"
done

acceptance_stage=generated_consumer
docker run --rm \
  "${consumer_network_args[@]}" \
  --volume "$consumer_root:/work" \
  --workdir /work \
  --env DACS_PACKAGE_VERSION="$version" \
  --env DACS_HOST_UID="$host_uid" \
  --env DACS_HOST_GID="$host_gid" \
  --env npm_config_registry="$consumer_registry" \
  --env npm_config_audit=false \
  --env npm_config_fund=false \
  node:20.19.1-bookworm-slim@sha256:83e53269616ca1b22cf7533e5db4e2f1a0c24a8e818b21691d6d4a69ec9e2c6d \
  sh -ceu '
    restore_host_ownership() {
      chown -R "$DACS_HOST_UID:$DACS_HOST_GID" /work || true
    }
    trap restore_host_ownership EXIT
    npm install --global --ignore-scripts npm@11.19.0
    npm create "dacs-agent@$DACS_PACKAGE_VERSION" one-click-agent -- \
      --yes \
      --mode live-demos \
      --profile dacs-sdk:fixed-price-x402:v1 \
      --rails both \
      --role seller \
      --deploy docker
    cd one-click-agent
    npm run build
    npm test
    doctor_status=0
    npm run dacs:doctor > /work/doctor.log 2>&1 || doctor_status=$?
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
  ' | tee "$artifact_stage/generation.log"

project="$consumer_root/one-click-agent"
acceptance_stage=dependency_policy
node "$repo_root/scripts/check-registry-dependency-policy.mjs" \
  "$project" "$consumer_registry" "$artifact_stage/dependency-policy.json"

acceptance_stage=audit_policy
node - "$consumer_root/npm-audit.json" "$artifact_stage/audit-policy.json" <<'NODE'
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const counts = audit.metadata?.vulnerabilities;
if (!counts || !Number.isInteger(counts.total) || !Number.isInteger(counts.critical)) {
  throw new Error("npm audit did not produce vulnerability metadata");
}
const baselineExceeded = counts.total > 66 || counts.critical > 3;
fs.writeFileSync(process.argv[3], JSON.stringify({
  schema: "dacs-registry-audit-policy/v1",
  baseline: { total: 66, critical: 3 },
  observed: counts,
  baselineExceeded,
}, null, 2) + "\n");
process.stdout.write(JSON.stringify(counts) + "\n");
NODE

acceptance_stage=compose_render
env \
  DACS_RUNTIME_UID=10001 \
  DACS_RUNTIME_GID=10001 \
  DACS_BUYER_DATA_DIRECTORY=/var/lib/dacs-acceptance/buyer \
  DACS_SELLER_DATA_DIRECTORY=/var/lib/dacs-acceptance/seller \
  DACS_BUYER_DEMOS_SECRET_FILE=/run/dacs-acceptance/buyer-demos \
  DACS_SELLER_DEMOS_SECRET_FILE=/run/dacs-acceptance/seller-demos \
  DACS_BUYER_EVM_SECRET_FILE=/run/dacs-acceptance/buyer-evm \
  DACS_WALLET_AUTHORITY_URL=http://127.0.0.1:48080 \
  DACS_WALLET_AUTHORITY_ID=dacs-acceptance-wallet-authority \
  DACS_WALLET_AUTHORITY_EPOCH=acceptance-epoch-1 \
  DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
  DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK=1 \
  DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE=/run/dacs-acceptance/buyer-wallet-authority-token \
  DACS_SELLER_EVM_SECRET_FILE=/run/dacs-acceptance/seller-evm \
  DACS_X402_LISTING_DRAFT_FILE=/run/dacs-acceptance/listing-x402.json \
  DACS_PAY_DEM_LISTING_DRAFT_FILE=/run/dacs-acceptance/listing-pay-dem.json \
  docker compose --file "$project/compose.yaml" config \
    > "$artifact_stage/compose.rendered.yaml"

acceptance_stage=docker_build
docker build \
  "${build_network_args[@]}" \
  --tag "$runtime_image" \
  "$project" \
  | tee "$artifact_stage/docker-build.log"
image_started=1

acceptance_stage=runtime_checks
image_id=$(docker image inspect --format '{{.Id}}' "$runtime_image")
case "$image_id" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "built image did not resolve to an immutable ID" >&2; exit 1 ;;
esac
docker image inspect "$image_id" > "$artifact_stage/docker-image.json"
image_user=$(docker image inspect --format '{{.Config.User}}' "$image_id")
runtime_uid=$(docker run --rm --network none --read-only --entrypoint id "$image_id" -u)
smoke_status=0
(cd "$project" && npm run --silent dacs:image:smoke -- "$image_id") \
  > "$artifact_stage/generated-image-smoke.json" \
  2> "$artifact_stage/generated-image-smoke.err" || smoke_status=$?
package_scan_status=0
docker run --rm --network none --read-only \
  --volume "$repo_root/scripts/inspect-installed-package-tree.mjs:/inspect-installed-package-tree.mjs:ro" \
  --entrypoint node "$image_id" \
  /inspect-installed-package-tree.mjs /app/node_modules \
  > "$artifact_stage/runtime-package-tree.json" \
  2> "$artifact_stage/runtime-package-tree.err" || package_scan_status=$?
runtime_imports_passed=false
if docker run --rm --network none --read-only --entrypoint sh "$image_id" -ceu '
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
RUNTIME_IMPORTS_PASSED="$runtime_imports_passed" \
SMOKE_STATUS="$smoke_status" \
PACKAGE_SCAN_STATUS="$package_scan_status" \
  node - "$artifact_stage/runtime-image-policy.json" "$artifact_stage/generated-image-smoke.json" "$artifact_stage/runtime-package-tree.json" "$image_id" <<'NODE'
const fs = require("node:fs");
function readJson(file, status) {
  if (status !== 0) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}
const smoke = readJson(process.argv[3], Number(process.env.SMOKE_STATUS));
const packageTree = readJson(process.argv[4], Number(process.env.PACKAGE_SCAN_STATUS));
const policy = {
  schema: "dacs-runtime-image-policy/v1",
  imageId: process.argv[5],
  expectedUser: "10001:10001",
  observedUser: process.env.IMAGE_USER,
  observedUid: process.env.RUNTIME_UID,
  runtimeImportsPassed: process.env.RUNTIME_IMPORTS_PASSED === "true",
  generatedSmokeExitCode: Number(process.env.SMOKE_STATUS),
  generatedSmokePassed: smoke?.status === "pass" && smoke.imageId === process.argv[5] &&
    smoke.runtime?.status === "pass",
  packageScanExitCode: Number(process.env.PACKAGE_SCAN_STATUS),
  packageTree,
};
policy.functionalPassed = policy.observedUser === policy.expectedUser &&
  policy.observedUid === "10001" && policy.runtimeImportsPassed &&
  policy.generatedSmokePassed;
policy.productionDependencyPolicyPassed = packageTree?.schema === "dacs-installed-package-tree/v1" &&
  packageTree.root === "/app/node_modules" && packageTree.passed === true &&
  Array.isArray(packageTree.packages?.typescript) &&
  packageTree.packages.typescript.length === 0 &&
  Array.isArray(packageTree.packages?.["rubic-sdk"]) &&
  packageTree.packages["rubic-sdk"].length === 0;
fs.writeFileSync(process.argv[2], JSON.stringify(policy, null, 2) + "\n");
NODE

cp "$release_set/release-provenance.json" "$artifact_stage/"
cp "$release_set/SHA256SUMS" "$artifact_stage/"
cp "$project/package.json" "$artifact_stage/generated-package.json"
cp "$project/package-lock.json" "$artifact_stage/generated-package-lock.json"
cp "$consumer_root/doctor.log" "$artifact_stage/"
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

acceptance_stage=summary
node - "$artifact_stage" "$version" "$runtime_image" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const version = process.argv[3];
const image = process.argv[4];
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
const engineStrictExitCode = Number(
  fs.readFileSync(path.join(root, "engine-strict.exit-code"), "utf8").trim(),
);
const auditExitCode = Number(
  fs.readFileSync(path.join(root, "npm-audit.exit-code"), "utf8").trim(),
);
const lockSbomExitCode = Number(
  fs.readFileSync(path.join(root, "consumer-lock-sbom.exit-code"), "utf8").trim(),
);
const physicalSbomExitCode = Number(
  fs.readFileSync(path.join(root, "consumer-physical-sbom.exit-code"), "utf8").trim(),
);
const summary = {
  schema: "dacs-registry-container-acceptance/v1",
  packageVersion: version,
  generatedMode: "live-demos",
  generatedRole: "seller",
  generatedRails: ["x402", "pay-dem"],
  registryDependencyOnly: dependencyPolicy.passed,
  generatedTestsPassed: true,
  functionalPassed: runtimeImagePolicy.functionalPassed,
  doctor: {
    expectedExitCode: 5,
    disposition: "blocked-without-credentials",
  },
  docker: {
    image,
    id: inspect.Id,
    size: inspect.Size,
    user: inspect.Config.User,
    policy: runtimeImagePolicy,
  },
  audit: audit.metadata.vulnerabilities,
  securityGate: {
    productionPublicationBlockedBy: "DACS-Agent-commerce/dacs-sdk#191",
    passed: dependencyPolicy.passed &&
      runtimeImagePolicy.productionDependencyPolicyPassed &&
      engineStrictExitCode === 0 &&
    auditExitCode === 0 && audit.metadata.vulnerabilities.total === 0 &&
      auditPolicy.baselineExceeded === false &&
      lockSbomExitCode === 0 && physicalSbomExitCode === 0,
    registryDependencyPolicyPassed: dependencyPolicy.passed,
    productionImageDependencyPolicyPassed:
      runtimeImagePolicy.productionDependencyPolicyPassed,
    engineStrictExitCode,
    auditExitCode,
    auditBaselineExceeded: auditPolicy.baselineExceeded,
    lockSbomExitCode,
    physicalSbomExitCode,
  },
};
fs.writeFileSync(
  path.join(root, "acceptance-summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
NODE

mv "$artifact_stage" "$output_dir"
read -r functional_passed security_passed < <(node - "$output_dir/acceptance-summary.json" <<'NODE'
const fs = require("node:fs");
const summary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  `${summary.functionalPassed === true} ${summary.securityGate?.passed === true}\n`,
);
NODE
)
if [ "$functional_passed" != "true" ]; then
  echo "functional registry/container rehearsal failed: $output_dir" >&2
  exit 1
fi
if [ "$security_passed" != "true" ]; then
  echo "functional registry/container rehearsal passed, but the #191 security gate remains blocked: $output_dir" >&2
  exit 3
fi
echo "registry/container acceptance passed: $output_dir"
