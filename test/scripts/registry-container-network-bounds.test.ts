import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const source = () => readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
const config = () => readFileSync("scripts/bounded-http.sh", "utf8").match(/# Bounded registry HTTP[\s\S]*?http_json_curl=\([\s\S]*?\)\n/)?.[0];
const stub = `curl() {
  case "$*" in *--version*) echo "curl $TEST_CURL_VERSION"; return 0 ;; esac
  [ "$1" = --disable ] || return 99
  case "$*" in *"--connect-timeout 5"*) ;; *) return 99 ;; esac
  case "$*" in *"--max-time 15"*) ;; *) return 99 ;; esac
  case "$*" in *"--max-filesize 65536"*) ;; *) return 99 ;; esac
  return "$TEST_FAILURE_CODE"
}
sleep() { :; }
docker() { :; }
`;
describe("bounded registry requests", () => {
  it.each(["readiness", "authentication"])("bounds a simulated stalled or oversized %s response and never publishes", kind => {
    const root = mkdtempSync(join(tmpdir(), "dacs-request-bounds-"));
    try {
      expect(config()).toBeDefined();
      const text = source(); const start = kind === "readiness" ? text.indexOf("ready=0") : text.indexOf("auth_response=$(curl");
      const end = kind === "readiness" ? text.indexOf("stage=registry-auth", start) : text.indexOf("\nauth_token=", start);
      const body = text.slice(start, end);
      expect(body).toContain('curl "${http_json_curl[@]}"');
      for (const failure of [28, 63]) {
        const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", stub + "source scripts/bounded-http.sh\n" + body + '\necho published > "$published"'], {
          encoding: "utf8", env: { PATH: process.env.PATH, TEST_CURL_VERSION: "8.5.0", TEST_FAILURE_CODE: String(failure), host_registry: "http://127.0.0.1:1", registry_container: "fixture", registry_log: join(root, "registry.log"), published: join(root, "published") } });
        expect(result.status, result.stderr).toBe(kind === "readiness" ? 1 : failure);
        expect(existsSync(join(root, "published"))).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses curl without streaming response-size enforcement", () => {
    expect(config()).toBeDefined();
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", stub + "source scripts/bounded-http.sh\n"], {
      encoding: "utf8", env: { PATH: process.env.PATH, TEST_CURL_VERSION: "8.3.0" } });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("curl 8.4+");
  });
});
