import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const config = () => readFileSync("scripts/bounded-http.sh", "utf8").match(/# Bounded registry HTTP[\s\S]*?http_json_curl=\([\s\S]*?\)\n/)?.[0];
const stub = `curl() {
  case "$*" in *--version*) echo "curl $TEST_CURL_VERSION"; return 0 ;; esac
  [ "$1" = --disable ] || return 99
  case "$*" in *"--connect-timeout 5"*) ;; *) return 99 ;; esac
  case "$*" in *"--max-time 15"*) ;; *) return 99 ;; esac
  case "$*" in *"--max-filesize 65536"*) ;; *) return 99 ;; esac
  return "$TEST_FAILURE_CODE"
}
`;
describe("bounded registry requests", () => {
  it("refuses curl without streaming response-size enforcement", () => {
    expect(config()).toBeDefined();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", stub + "source scripts/bounded-http.sh\n"], {
      encoding: "utf8", env: { PATH: process.env.PATH, TEST_CURL_VERSION: "8.3.0" } });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("curl 8.4+");
  });
});
