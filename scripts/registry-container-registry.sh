#!/usr/bin/env bash
# Inert until sourced by the manual rehearsal: builds the release set and
# brings up the run's own Verdaccio with exactly those candidates published.
# Each function is one rehearsal stage and sets `stage` for its failure
# summary. They read the rehearsal's paths and run-local names (repo_root,
# acceptance_root, artifact_stage, release_set, registry_config, registry_log,
# registry_network, registry_container) and its run_bounded, pull_bounded and
# docker helpers, and set the globals later stages use.

# Writes the secret-free Verdaccio configuration to $registry_config.
write_registry_config() {
  cat > "$registry_config" <<'YAML'
storage: /verdaccio/storage
web:
  enable: false
auth:
  htpasswd:
    file: /verdaccio/storage/htpasswd
    max_users: 2
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@kynesyslabs/dacs':
    access: $all
    publish: dacs-ci
    unpublish: dacs-ci
  '@kynesyslabs/dacs-node':
    access: $all
    publish: dacs-ci
    unpublish: dacs-ci
  'create-dacs-agent':
    access: $all
    publish: dacs-ci
    unpublish: dacs-ci
  '@kynesyslabs/demosdk':
    access: $all
    proxy: npmjs
  '@kynesyslabs/*':
    access: $all
  '**':
    access: $all
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
listen: 0.0.0.0:4873
YAML
  # The bind-mounted file is intentionally secret-free and must be readable by
  # Verdaccio's non-root container user on Linux runners. Verdaccio uses the
  # first matching rule. The candidate packages, and every other package in their
  # @kynesyslabs scope, have no uplink: they are served only from what this run
  # publishes, even once a version exists on npmjs. The one exception is the
  # released @kynesyslabs/demosdk the consumer depends on.
  chmod 0644 "$registry_config"
}

# Packs the clean, version-aligned release set with pinned npm; sets `version`
# and puts that npm first on PATH.
build_release_set() {
  stage=release-set
  publish_npm="$acceptance_root/publish-npm"
  run_bounded npm install --global --prefix "$publish_npm" --ignore-scripts --no-audit --no-fund npm@11.19.0 \
    2>&1 | tee "$artifact_stage/release-set.log"
  export npm_config_prefix="$publish_npm"
  export PATH="$publish_npm/bin:$PATH"
  run_bounded npm run conformance:sync 2>&1 | tee -a "$artifact_stage/release-set.log"
  run_bounded npm run release:set:verify -- --output-dir "$release_set" 2>&1 | tee -a "$artifact_stage/release-set.log"

  version=$(node -p "require('./package.json').version")
  node - "$release_set/release-provenance.json" "$version" <<'NODE'
const fs = require("node:fs");
const provenance = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (provenance.version !== process.argv[3] || provenance.source.clean !== true) {
  throw new Error("release-set provenance is not clean or version-aligned");
}
NODE
}

# Pulls the pinned images and starts Verdaccio on the run's network; sets the
# registry URLs, the consumer and build network arguments and the host user.
start_registry() {
  stage=registry-start
  docker buildx version >/dev/null
  registry_image=verdaccio/verdaccio@sha256:fcb86134563534e2f634752e6c6c3edcdb78242ec16578c73ce39d1dadbaa801
  consumer_image=node:20.19.1-bookworm-slim@sha256:83e53269616ca1b22cf7533e5db4e2f1a0c24a8e818b21691d6d4a69ec9e2c6d
  pull_bounded --quiet "$registry_image" 2>&1 | tee -a "$registry_log"
  pull_bounded --quiet "$consumer_image" 2>&1 | tee -a "$registry_log"
  network_started=1
  docker network create "$registry_network" >/dev/null
  registry_builder="$registry_network"
  builder_started=1
  docker buildx create --name "$registry_builder" --driver docker-container \
    --driver-opt "network=$registry_network" >/dev/null
  registry_started=1
  docker run --detach \
    --name "$registry_container" \
    --network "$registry_network" \
    --publish 127.0.0.1::4873 \
    --volume "$registry_config:/verdaccio/conf/config.yaml:ro" \
    "$registry_image" \
    2>&1 >/dev/null | tee -a "$registry_log" >&2
  host_port=$(docker inspect --format \
    '{{(index (index .NetworkSettings.Ports "4873/tcp") 0).HostPort}}' \
    "$registry_container")
  case "$host_port" in
    ''|*[!0-9]*) echo "Verdaccio host port is invalid" >&2; exit 1 ;;
  esac
  host_registry="http://127.0.0.1:$host_port"
  consumer_registry="http://$registry_container:4873"
  consumer_network_args=(--network "$registry_network")
  build_network_args=(--builder "$registry_builder" --load --network default)
  host_uid=$(id -u)
  host_gid=$(id -g)
  case "$host_uid:$host_gid" in
    *[!0-9:]*) echo "host uid/gid is invalid" >&2; exit 1 ;;
  esac
}

# Waits up to 30 bounded pings for Verdaccio; exits 1 with its log otherwise.
wait_for_registry() {
  stage=registry-ready
  ready=0
  for attempt in $(seq 1 30); do
    if curl "${http_json_curl[@]}" "$host_registry/-/ping" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    docker logs "$registry_container" 2>&1 | tee -a "$registry_log" >&2
    exit 1
  fi
}

# Creates the run-local publishing user; sets `auth_token` from a bounded reply.
authenticate_registry() {
  stage=registry-auth
  local auth_password
  auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  auth_response=$(curl "${http_json_curl[@]}" \
    --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 45 \
    --request PUT "$host_registry/-/user/org.couchdb.user:dacs-ci" \
    --header 'content-type: application/json' \
    --data "{\"name\":\"dacs-ci\",\"password\":\"$auth_password\",\"email\":\"ci@example.invalid\",\"type\":\"user\",\"roles\":[]}" \
    2> >(tee -a "$registry_log" >&2))
  auth_token=$(AUTH_RESPONSE="$auth_response" node -e '
const value = JSON.parse(process.env.AUTH_RESPONSE);
const MAX_AUTH_FIELDS = 32, MIN_TOKEN_CHARS = 8, MAX_TOKEN_CHARS = 4096;
if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > MAX_AUTH_FIELDS ||
    Object.values(value).some(entry => entry !== null && typeof entry === "object") ||
    typeof value.token !== "string" || value.token.length < MIN_TOKEN_CHARS || value.token.length > MAX_TOKEN_CHARS) process.exit(1);
process.stdout.write(value.token);
')
}

# Publishes the three candidates of `version` to the run's registry.
publish_release_set() {
  stage=publish
  for package in \
    "$release_set/kynesyslabs-dacs-$version.tgz" \
    "$release_set/kynesyslabs-dacs-node-$version.tgz" \
    "$release_set/create-dacs-agent-$version.tgz"
  do
    test -f "$package"
    # The publisher also proves the registry serves only this candidate version.
    DACS_LOCAL_REGISTRY_TOKEN="$auth_token" \
      node scripts/publish-exact-local-registry.mjs "$package" "$host_registry" \
      2>&1 | tee -a "$registry_log"
  done
}
