import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([0, 23])("checks the consumer reference on the read-only install before any other measurement, status=%s", status => {
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const block = source.split('--name "$consumer_container-measure"')[1]?.split("' 2>&1 | tee")[0];
  for (const mount of ['"$generated_root:/work:ro"', '"$measure_out:/out"', '"$repo_root/scripts:/acceptance-sdk/scripts:ro"', '"$release_set:/release-set:ro"']) {
    expect(block).toContain("--volume " + mount);
  }
  expect(block).not.toMatch(/\$artifact_stage|\$execute_out|\$sealed_root/);
  expect(source).toContain("--env npm_config_omit=optional");
  expect(source).toContain("--deploy docker --no-install");
  const body = block?.split("sh -ceu '\n")[1];
  expect(body).toContain('node /acceptance-sdk/scripts/registry-container-disposition.mjs --dependency-policy "$PWD" "$npm_config_registry"');
  if (!body) throw new Error("missing measure shell body");
  const directory = mkdtempSync(join(tmpdir(), "dacs-consumer-reference-"));
  try {
    const working = join(directory, "consumer with spaces", "one-click-agent"), out = join(directory, "out");
    mkdirSync(working, { recursive: true }); mkdirSync(out);
    for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(working, name), "{}\n");
    const trace = join(directory, "trace");
    const snippet = body.replaceAll("/out/", out + "/").replaceAll("/tmp/lock-only", join(directory, "lock-only"));
    const stubs = `
      npm() { printf 'npm:%s\n' "$*" >> "$TRACE"; if [ "$1" = --version ]; then echo 11.19.0; fi; }
      node() {
        if [ "$1" = -p ]; then echo '{}'; return 0; fi
        printf 'checker-npm:%s cache:%s omit:%s\n' "\${npm_execpath-}" "$npm_config_cache" "$npm_config_omit" >> "$TRACE"
        if [ "$#" -ne 7 ]; then return 97; fi; printf 'node:%s:%s\n' "$PWD" "$*" >> "$TRACE"; return "$POLICY_STATUS";
      }
    `;
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", stubs + snippet], {
      cwd: working, encoding: "utf8", env: { PATH: process.env.PATH, TRACE: trace, POLICY_STATUS: String(status),
        DACS_PACKAGE_VERSION: "0.1.0-test", npm_config_registry: "http://127.0.0.1:4873", npm_config_omit: "optional",
        npm_config_cache: "/work/.npm-cache" },
    });
    const commands = readFileSync(trace, "utf8");
    // Module loading and reference replay must use the just-installed client,
    // while archive reads still use the read-only original installation cache.
    expect(commands).toContain("checker-npm:/tmp/npm/lib/node_modules/npm/bin/npm-cli.js cache:/work/.npm-cache omit:optional");
    expect(commands).toContain(`node:${working}:`);
    expect(commands).toContain(`--dependency-policy ${working} http://127.0.0.1:4873 ${out}/dependency-policy.json`);
    expect(readFileSync(join(out, "dependency-policy.exit-code"), "utf8")).toBe(status + "\n");
    // Cleanup reads the collected exit code to report a policy stop.
    const transitionEnd = "      stage=dependency-policy\n    fi\n";
    const transition = source.slice(source.indexOf('    if [ "${stage-}" = consumer ]'), source.indexOf(transitionEnd) + transitionEnd.length);
    expect(transition).toContain('"$artifact_stage/dependency-policy.exit-code"');
    const classify = spawnSync("bash", ["--norc", "--noprofile", "-euc", transition + '\nprintf "%s" "$stage"'], {
      encoding: "utf8", env: { PATH: process.env.PATH, stage: "consumer", artifact_stage: out },
    });
    expect(classify.status, classify.stderr).toBe(0);
    expect(classify.stdout).toBe(status === 0 ? "consumer" : "dependency-policy");
    const order = ["npm:install --global --prefix /tmp/npm --ignore-scripts npm@11.19.0", "--dependency-policy", "npm:audit ",
      "npm:sbom --sbom-format", "npm:sbom --package-lock-only", "npm:ci --package-lock-only"].map(step => commands.indexOf(step));
    if (status === 0) {
      expect(result.status, result.stderr).toBe(0);
      expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!)), commands).toBe(true);
      expect(readFileSync(join(out, "engine-versions.json"), "utf8")).toBe("{}\n");
    } else {
      expect(result.status).not.toBe(0);
      expect(commands).not.toContain("npm:audit");
      expect(commands).not.toContain("npm:sbom");
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
