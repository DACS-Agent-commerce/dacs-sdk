import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-registry-bring-up-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Sources the stage functions, as the rehearsal does, and runs `body`.
const runStages = (body: string, env: Record<string, string>) => spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c",
  `source scripts/registry-container-registry.sh\n${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

describe("registry network isolation", () => {
  it.each(["Linux", "Darwin"])("keeps consumers and the image builder off the %s host network", platform => {
    const log = join(scratch(), "commands");
    const result = runStages(`
uname() { echo "$platform"; }
pull_bounded() { :; }
docker() {
  printf '%s\\n' "$*" >> "$log"
  if [ "$1" = inspect ]; then echo 49152; fi
}
start_registry
printf '%s\\n' "$consumer_registry" "\${consumer_network_args[*]}" "\${build_network_args[*]}"`, {
      platform, log, registry_log: join(scratch(), "registry.log"), registry_config: "/fixture/config.yaml",
      registry_network: "fixture-network", registry_container: "fixture-registry",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("http://fixture-registry:4873\n--network fixture-network\n");
    expect(result.stdout).toContain("--builder fixture-network --load --network host");
    const commands = readFileSync(log, "utf8");
    expect(commands).toContain("buildx create --name fixture-network --driver docker-container --driver-opt network=fixture-network");
    expect(commands).toContain("--publish 127.0.0.1::4873");
    // Build-step host mode refers to the dedicated builder container, whose
    // network is fixture-network. Consumer and registry never use host mode.
    expect(commands).not.toMatch(/--network host|host-gateway|host\.docker\.internal/);
    expect(result.stdout.split("\n")[1]).toBe("--network fixture-network");
  });

  it("requires Buildx before creating resources", () => {
    const result = runStages(`
pull_bounded() { echo unexpected-pull; }
docker() { [ "$1 $2" != "buildx version" ] || return 42; echo unexpected-resource; }
start_registry`, { registry_network: "fixture", registry_container: "fixture", registry_log: "/dev/null", registry_config: "/fixture/config" });
    expect(result.status).toBe(42);
    expect(result.stdout).not.toMatch(/unexpected/);
  });
});

function verdaccioConfig() {
  const path = join(scratch(), "verdaccio.yaml");
  const result = runStages("write_registry_config", { registry_config: path });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(path, "utf8");
}

describe("run-local Verdaccio configuration", () => {
  it.each(["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "create-dacs-agent"]
    .flatMap(name => ["publish", "unpublish"].map(operation => [name, operation])))(
    "permits only the run's publisher to write %s via %s", (name, operation) => {
      const rules = verdaccioConfig().split("\npackages:\n")[1]!.split(/\n(?=\S)/)[0]!;
      const body = rules.split(`  '${name}':\n`)[1]!.split(/\n {2}'/)[0]!;
      // $all includes anonymous users; $authenticated also includes other users.
      expect(body).toMatch(/^ {4}access: \$all$/m);
      expect(body).toMatch(new RegExp(`^ {4}${operation}: dacs-ci$`, "m"));
    });

  it.each(["@kynesyslabs/demosdk", "@kynesyslabs/*", "**"])(
    "allows reads but no local writes through the %s rule", (pattern) => {
      const rules = verdaccioConfig().split("\npackages:\n")[1]!.split(/\n(?=\S)/)[0]!;
      const body = rules.split(`  '${pattern}':\n`)[1]!.split(/\n {2}'/)[0]!;
      expect(body).toMatch(/^ {4}access: \$all$/m);
      // Missing publish denies all users; missing unpublish falls back to publish.
      expect(body).not.toMatch(/^ {4}(?:publish|unpublish):/m);
    });

  it("serves the candidates' @kynesyslabs scope only from this run's publish", () => {
    const block = verdaccioConfig().split("\npackages:\n")[1]!.split(/\n(?=\S)/)[0]!;
    // Verdaccio applies the first rule whose pattern matches the package name.
    const rules = [...block.matchAll(/^ {2}'([^']+)':\n((?: {4}.+\n?)+)/gm)].map(([, pattern, body]) => ({ pattern: pattern!,
      proxy: /^ {4}proxy: (\S+)$/m.exec(body!)?.[1] ?? null, publish: /^ {4}publish: /m.test(body!) }));
    const firstRule = (name: string) => rules.find(({ pattern }) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$").test(name))!;
    for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "create-dacs-agent"]) {
      expect(firstRule(name), name).toMatchObject({ pattern: name, proxy: null, publish: true });
    }
    // A future candidate in the scope is never proxied either.
    expect(firstRule("@kynesyslabs/dacs-substrate")).toMatchObject({ pattern: "@kynesyslabs/*", proxy: null });
    expect(firstRule("@kynesyslabs/demosdk")).toMatchObject({ proxy: "npmjs", publish: false });
    expect(firstRule("viem")).toMatchObject({ pattern: "**", proxy: "npmjs" });
  });

  it("keeps Verdaccio's writable authentication state under its configured storage", () => {
    const config = verdaccioConfig();
    const storage = config.match(/^storage: (.+)$/m)![1]!;
    const authFile = config.match(/^    file: (.+)$/m)![1]!;
    expect(authFile.startsWith(storage + "/")).toBe(true);
    expect(readFileSync("scripts/registry-container-registry.sh", "utf8")).toContain('$registry_config:/verdaccio/conf/config.yaml:ro');
  });
});

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
  it("keeps the named publishing account private with fresh credentials on each run", () => {
    const root = scratch();
    const request = join(root, "auth-request.json");
    const passwords: string[] = [];
    for (let run = 0; run < 2; run++) {
      const result = runStages(`http_json_curl=()
curl() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --data ]; then printf '%s' "$2" > "$request"; break; fi
    shift
  done
  printf '{"token":"fixture-auth-token"}'
}
authenticate_registry
printf '%s' "$auth_token"`, {
        request, host_registry: "http://127.0.0.1:1", registry_log: join(root, "registry.log"),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("fixture-auth-token");
      const body = JSON.parse(readFileSync(request, "utf8")) as { name: string; password: string };
      expect(body.name).toBe("dacs-ci");
      expect(body.password).toMatch(/^[a-f0-9]{64}$/);
      passwords.push(body.password);
    }
    expect(passwords[0]).not.toBe(passwords[1]);
  });

  it.each([["readiness", "wait_for_registry"], ["authentication", "authenticate_registry"]])(
    "bounds a simulated stalled or oversized %s response and never publishes", (kind, stage) => {
      const root = scratch();
      for (const failure of [28, 63]) {
        const result = runStages(`${stub}source scripts/bounded-http.sh\n${stage}\necho published > "$published"`, {
          TEST_CURL_VERSION: "8.5.0", TEST_FAILURE_CODE: String(failure), host_registry: "http://127.0.0.1:1",
          registry_container: "fixture", registry_log: join(root, "registry.log"), published: join(root, "published") });
        expect(result.status, result.stderr).toBe(kind === "readiness" ? 1 : failure);
        expect(existsSync(join(root, "published"))).toBe(false);
      }
    });
});
