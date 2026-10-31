#!/usr/bin/env bash
# Inert until sourced by the manual rehearsal; bounded commands and their npm
# descendants inherit admission.
bounded_support=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
read -r COMMAND_TIMEOUT_SECONDS DOCKER_PULL_TIMEOUT_SECONDS COMMAND_MAX_ATTEMPTS < <(
  node --input-type=module -e 'import(process.argv[2]).then(m => console.log(m.COMMAND_TIMEOUT_SECONDS, m.DOCKER_PULL_TIMEOUT_SECONDS, m.COMMAND_MAX_ATTEMPTS))' bounded-transport "$bounded_support/bounded-command.mjs"
)
# Scope npm admission to the wrappers rather than exporting it shell-wide, so an
# unrelated Node process the rehearsal runs later keeps its own transport.
export npm_config_fetch_timeout=15000 npm_config_fetch_retries=2
export npm_config_fetch_retry_mintimeout=1000 npm_config_fetch_retry_maxtimeout=2000
run_bounded() {
  DACS_BOUNDED_NPM_HTTP=1 NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$bounded_support/bounded-npm-http.cjs\"" \
    node "$bounded_support/bounded-command.mjs" "$COMMAND_TIMEOUT_SECONDS" 1 "$@"
}
pull_bounded() {
  DACS_BOUNDED_NPM_HTTP=1 NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$bounded_support/bounded-npm-http.cjs\"" \
    node "$bounded_support/bounded-command.mjs" "$DOCKER_PULL_TIMEOUT_SECONDS" "$COMMAND_MAX_ATTEMPTS" docker pull "$@"
}
