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
chmod 0600 "$registry_config"

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
docker run --detach \
  --name "$registry_container" \
  --network "$registry_network" \
  --publish 127.0.0.1::4873 \
  --volume "$registry_config:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio@sha256:fcb86134563534e2f634752e6c6c3edcdb78242ec16578c73ce39d1dadbaa801 \
  >/dev/null
registry_started=1

host_port=$(docker port "$registry_container" 4873/tcp | sed -E 's/.*:([0-9]+)$/\1/')
case "$host_port" in
  ''|*[!0-9]*) echo "Verdaccio host port is invalid" >&2; exit 1 ;;
esac
host_registry="http://127.0.0.1:$host_port"
consumer_registry="http://host.docker.internal:$host_port"

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
auth_host=$(printf '%s' "$host_registry" | sed 's#^http:##')
auth_option="--$auth_host/:_authToken=$auth_token"

for package in \
  "$release_set/kynesyslabs-dacs-$version.tgz" \
  "$release_set/kynesyslabs-dacs-node-$version.tgz" \
  "$release_set/create-dacs-agent-$version.tgz"
do
  test -f "$package"
  npm publish "$package" \
    --registry "$host_registry" \
    --tag acceptance \
    --access public \
    --ignore-scripts \
    --provenance=false \
    --loglevel=error \
    "$auth_option"
done

for package_name in @kynesyslabs/dacs @kynesyslabs/dacs-node create-dacs-agent; do
  observed=$(npm view "$package_name@$version" version --registry "$host_registry")
  test "$observed" = "$version"
done

docker_cache_args=()
if [ -n "${DACS_ACCEPTANCE_NPM_CACHE_DIRECTORY-}" ]; then
  case "$DACS_ACCEPTANCE_NPM_CACHE_DIRECTORY" in
    /*) ;;
    *) echo "DACS_ACCEPTANCE_NPM_CACHE_DIRECTORY must be absolute" >&2; exit 2 ;;
  esac
  test -d "$DACS_ACCEPTANCE_NPM_CACHE_DIRECTORY"
  docker_cache_args=(--volume "$DACS_ACCEPTANCE_NPM_CACHE_DIRECTORY:/root/.npm")
fi

docker run --rm \
  "${docker_cache_args[@]}" \
  --add-host host.docker.internal:host-gateway \
  --volume "$consumer_root:/work" \
  --workdir /work \
  --env DACS_PACKAGE_VERSION="$version" \
  --env npm_config_registry="$consumer_registry" \
  --env npm_config_audit=false \
  --env npm_config_fund=false \
  node:20.19.1-bookworm-slim@sha256:83e53269616ca1b22cf7533e5db4e2f1a0c24a8e818b21691d6d4a69ec9e2c6d \
  sh -ceu '
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
node - "$project" "$consumer_registry" "$artifact_stage/dependency-policy.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const registry = process.argv[3];
const reportPath = process.argv[4];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockSource = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockSource);
const dependencies = manifest.dependencies ?? {};
const violations = [];
for (const name of [
  "@kynesyslabs/dacs",
  "@kynesyslabs/dacs-node",
  "@kynesyslabs/demosdk",
  "@x402/core",
  "@x402/evm",
  "@x402/fetch",
  "better-sqlite3",
  "viem",
]) {
  if (typeof dependencies[name] !== "string") {
    throw new Error("dual-rail consumer is missing " + name);
  }
}
for (const value of Object.values(dependencies)) {
  if (/^(?:file:|git\+|https?:\/\/github\.com\/)/.test(value)) {
    violations.push({ location: "package.json", value });
  }
}
for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  for (const [field, value] of Object.entries(entry ?? {})) {
    if (typeof value === "string" &&
        /^(?:file:|git\+|git:|git@|https?:\/\/github\.com\/.*#)/.test(value)) {
      violations.push({ location, field, value });
    }
  }
  for (const [name, value] of Object.entries(entry?.dependencies ?? {})) {
    if (typeof value === "string" &&
        /^(?:file:|git\+|git:|git@|https?:\/\/github\.com\/.*#)/.test(value)) {
      violations.push({ location, field: `dependencies.${name}`, value });
    }
  }
}
for (const name of [
  "node_modules/@kynesyslabs/dacs",
  "node_modules/@kynesyslabs/dacs-node",
]) {
  const resolved = lock.packages?.[name]?.resolved;
  if (typeof resolved !== "string" || !resolved.startsWith(registry + "/")) {
    throw new Error("candidate package did not resolve through the isolated registry: " + name);
  }
}
fs.writeFileSync(reportPath, JSON.stringify({
  schema: "dacs-registry-dependency-policy/v1",
  passed: violations.length === 0,
  violations,
}, null, 2) + "\n");
NODE

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

docker compose --file "$project/compose.yaml" config --no-interpolate \
  > "$artifact_stage/compose.rendered.yaml"

docker build \
  --add-host host.docker.internal:host-gateway \
  --tag "$runtime_image" \
  "$project" \
  | tee "$artifact_stage/docker-build.log"
image_started=1

docker image inspect "$runtime_image" > "$artifact_stage/docker-image.json"
image_user=$(docker image inspect --format '{{.Config.User}}' "$runtime_image")
test "$image_user" = "10001:10001"
runtime_uid=$(docker run --rm --entrypoint id "$runtime_image" -u)
test "$runtime_uid" = "10001"
docker run --rm --entrypoint sh "$runtime_image" -ceu '
  test ! -d node_modules/typescript
  test ! -d node_modules/rubic-sdk
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
'

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
  registryDependencyOnly: true,
  generatedTestsPassed: true,
  doctor: {
    expectedExitCode: 5,
    disposition: "blocked-without-credentials",
  },
  docker: {
    image,
    id: inspect.Id,
    size: inspect.Size,
    user: inspect.Config.User,
  },
  audit: audit.metadata.vulnerabilities,
  securityGate: {
    productionPublicationBlockedBy: "DACS-Agent-commerce/dacs-sdk#191",
    passed: dependencyPolicy.passed && engineStrictExitCode === 0 &&
    auditExitCode === 0 && audit.metadata.vulnerabilities.total === 0 &&
      auditPolicy.baselineExceeded === false &&
      lockSbomExitCode === 0 && physicalSbomExitCode === 0,
    registryDependencyPolicyPassed: dependencyPolicy.passed,
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
security_passed=$(node - "$output_dir/acceptance-summary.json" <<'NODE'
const fs = require("node:fs");
const summary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(String(summary.securityGate?.passed === true));
NODE
)
if [ "$security_passed" != "true" ]; then
  echo "functional registry/container rehearsal passed, but the #191 security gate remains blocked: $output_dir" >&2
  exit 3
fi
echo "registry/container acceptance passed: $output_dir"
