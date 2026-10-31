#!/usr/bin/env bash
# Bounded registry HTTP requires curl's streaming size enforcement (8.4+).
curl_version=$(curl --disable --version) || return 1
CURL_VERSION="$curl_version" node -e '
const version = /^curl (\d+)\.(\d+)\./.exec(process.env.CURL_VERSION);
if (!version || +version[1] < 8 || (+version[1] === 8 && +version[2] < 4)) throw new Error("curl 8.4+ is required for bounded registry responses");
' || return 1
HTTP_JSON_CONNECT_TIMEOUT_SECONDS=5
HTTP_JSON_REQUEST_TIMEOUT_SECONDS=15
http_limits_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/http-json-limits.mjs"
HTTP_JSON_MAX_RESPONSE_BYTES=$(node --input-type=module -e 'import(process.argv[1]).then(({ HTTP_JSON_MAX_BYTES }) => console.log(HTTP_JSON_MAX_BYTES))' "$http_limits_path") || return 1
http_json_curl=(--disable --silent --show-error --fail --connect-timeout "$HTTP_JSON_CONNECT_TIMEOUT_SECONDS"
  --max-time "$HTTP_JSON_REQUEST_TIMEOUT_SECONDS" --max-filesize "$HTTP_JSON_MAX_RESPONSE_BYTES")
