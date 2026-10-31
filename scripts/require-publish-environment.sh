#!/usr/bin/env bash
set -euo pipefail
source scripts/bounded-http.sh
api="https://api.github.com/repos/$GITHUB_REPOSITORY/environments/npm-prerelease-gated"
curl "${http_json_curl[@]}" --header "Authorization: Bearer $GH_TOKEN" "$api" > "$RUNNER_TEMP/publish-environment.json"
curl "${http_json_curl[@]}" --header "Authorization: Bearer $GH_TOKEN" "$api/deployment-branch-policies" > "$RUNNER_TEMP/publish-environment-policies.json"
node scripts/check-publish-environment.mjs "$RUNNER_TEMP/publish-environment.json" "$RUNNER_TEMP/publish-environment-policies.json"
