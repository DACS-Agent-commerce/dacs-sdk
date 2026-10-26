import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([0, 23])("checks the consumer reference in its install context before package execution, status=%s", status => {
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const block = source.split("stage=consumer\n")[1]?.split('\nproject="$consumer_root/one-click-agent"')[0];
  expect(block).toContain('--volume "$repo_root/scripts:/acceptance-sdk/scripts:ro"');
  expect(block).toContain('--volume "$release_set:/release-set:ro"');
  expect(block).toContain('--volume "$artifact_stage:/acceptance-artifacts"');
  expect(block).toContain("--env npm_config_omit=optional");
  expect(block).toContain("--deploy docker --no-install");
  const body = block?.split("sh -ceu '\n")[1]?.split("' 2>&1 | tee")[0];
  expect(body).toContain('node /acceptance-sdk/scripts/registry-container-disposition.mjs --dependency-policy "$PWD" "$npm_config_registry"');
  if (!body) throw new Error("missing consumer shell body");
  const end = body.indexOf('    printf "%s\\n" "$tests_status"');
  expect(end).toBeGreaterThan(0);
  const directory = mkdtempSync(join(tmpdir(), "dacs-consumer-reference-"));
  try {
    const working = join(directory, "consumer with spaces");
    mkdirSync(working);
    const trace = join(directory, "trace");
    const snippet = body.slice(0, end).replaceAll("/work/dependency-policy.exit-code", join(directory, "dependency-policy.exit-code"));
    const stubs = `
      chown() { :; }
      npm() {
        printf 'npm:%s\n' "$*" >> "$TRACE";
        if [ "$1" = create ]; then mkdir one-click-agent; fi
      }
      node() { if [ "$#" -ne 7 ]; then return 97; fi; printf 'node:%s:%s\n' "$PWD" "$*" >> "$TRACE"; return "$POLICY_STATUS"; }
    `;
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", stubs + snippet], {
      cwd: working, encoding: "utf8", env: { PATH: process.env.PATH, TRACE: trace, POLICY_STATUS: String(status),
        DACS_HOST_UID: "1000", DACS_HOST_GID: "1000", DACS_PACKAGE_VERSION: "0.1.0-test", DACS_GENERATED_MODE: "live-demos",
        DACS_GENERATED_ROLE: "seller", DACS_GENERATED_RAILS: "both", npm_config_registry: "http://127.0.0.1:4873", npm_config_omit: "optional" },
    });
    const commands = readFileSync(trace, "utf8");
    expect(commands).toContain(`node:${working}/one-click-agent:`);
    expect(commands).toContain("--dependency-policy " + working + "/one-click-agent http://127.0.0.1:4873");
    expect(readFileSync(join(directory, "dependency-policy.exit-code"), "utf8")).toBe(status + "\n");
    const transition = source.split("  set +e\n")[1]?.split("  # Preserve only")[0];
    expect(transition).toBeDefined();
    const classify = spawnSync("bash", ["--norc", "--noprofile", "-euc", transition + '\nprintf "%s" "$stage"'], {
      encoding: "utf8", env: { PATH: process.env.PATH, stage: "consumer", consumer_root: directory },
    });
    expect(classify.status, classify.stderr).toBe(0);
    expect(classify.stdout).toBe(status === 0 ? "consumer" : "dependency-policy");
    if (status === 0) {
      expect(result.status, result.stderr).toBe(0);
      expect(commands.indexOf("npm:install --ignore-scripts")).toBeLessThan(commands.indexOf("--dependency-policy"));
      expect(commands.indexOf("--dependency-policy")).toBeLessThan(commands.indexOf("npm:rebuild better-sqlite3"));
      expect(commands.indexOf("npm:rebuild better-sqlite3")).toBeLessThan(commands.indexOf("npm:run build"));
      expect(commands).toContain("npm:test");
    } else {
      expect(result.status).not.toBe(0);
      expect(commands).not.toContain("npm:rebuild better-sqlite3");
      expect(commands).not.toContain("npm:run build");
      expect(commands).not.toContain("npm:test");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it("imports the deployed checking bundle with its adjacent package metadata", () => {
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const directory = mkdtempSync(join(tmpdir(), "dacs-checker-bundle-"));
  try {
    const bundle = join(directory, "acceptance-sdk");
    mkdirSync(bundle);
    cpSync("scripts", join(bundle, "scripts"), { recursive: true });
    if (source.includes('--volume "$repo_root/package.json:/acceptance-sdk/package.json:ro"')) {
      copyFileSync("package.json", join(bundle, "package.json"));
    }
    const entry = pathToFileURL(join(bundle, "scripts/registry-container-disposition.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const { RELEASE_VERSION } = await import(${JSON.stringify(entry)}); process.stdout.write(RELEASE_VERSION);`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
