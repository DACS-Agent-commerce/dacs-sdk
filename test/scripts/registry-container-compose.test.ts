import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { liveProjectTemplates } from "../../packages/create-dacs-agent/src/liveTemplates.js";

it("supplies every required generated Compose variable with inert run-local inputs", () => {
  const compose = liveProjectTemplates({ packageName: "acceptance", deployment: "docker", role: "seller",
    rails: "both", runtimeUid: 10001, runtimeGid: 10001 })["compose.yaml"]!;
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const block = source.slice(source.indexOf("\nenv \\\n"), source.indexOf('    > "$artifact_stage/compose.rendered.yaml"'));
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z_0-9]+):?\?/g)].map(m => m[1]!))];
  const supplied = [...block.matchAll(/\b([A-Z_0-9]+)=/g)].map(m => m[1]!);
  expect(required.filter(name => !supplied.includes(name))).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "dacs-compose-inputs-"));
  try {
    const setup = source.slice(source.indexOf("# Inert Compose inputs"), source.indexOf("\nenv \\\n"));
    // Run this Node by absolute path; a `node` found through PATH would be the host's.
    const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const render = block.replace(/docker compose[\s\S]*/, `${node} -e 'process.stdout.write(JSON.stringify(process.env))'`);
    // A poisoned `node` first on PATH proves no step resolves node through PATH.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho 'host node resolved through PATH' >&2\nexit 97\n", { mode: 0o700 });
    // No rc files: Debian bash sources /etc/bash.bashrc when stdin is a socket.
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", setup + "\n" + render], {
      encoding: "utf8",
      env: { acceptance_root: root, DACS_EVM_RPC_URL: "https://rpc.invalid/private-marker",
        DACS_PRIVATE_TEST: "private-marker", PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const values = JSON.parse(result.stdout) as Record<string, string>;
    expect(values.DACS_EVM_RPC_URL).toBeUndefined();
    expect(values.DACS_PRIVATE_TEST).toBeUndefined();
    expect(result.stdout).not.toContain("private-marker");
    for (const name of required) expect(values[name]).toBeTruthy();
    for (const name of required.filter(n => n.endsWith("_FILE") || n.endsWith("_DIRECTORY"))) {
      expect(values[name]!.startsWith(root + "/")).toBe(true);
      expect(statSync(values[name]!).isDirectory()).toBe(name.endsWith("_DIRECTORY"));
      if (name.endsWith("_FILE")) {
        expect(readFileSync(values[name]!, "utf8")).toContain("acceptance-placeholder");
        expect((statSync(values[name]!).mode & 0o777).toString(8), name).toBe("600");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("serves the candidates' @kynesyslabs scope only from this run's publish", () => {
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const config = source.split('cat > "$registry_config"')[1]!.split("\nYAML")[0]!;
  const block = config.split("\npackages:\n")[1]!.split(/\n(?=\S)/)[0]!;
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
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const config = source.split('cat > "$registry_config"')[1]!.split("\nYAML")[0]!;
  const storage = config.match(/^storage: (.+)$/m)![1]!;
  const authFile = config.match(/^    file: (.+)$/m)![1]!;
  expect(authFile.startsWith(storage + "/")).toBe(true);
  expect(source).toContain('$registry_config:/verdaccio/conf/config.yaml:ro');
});

it("invokes only Compose config and writes the rendered artifact", () => {
  const source = readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
  const start = source.indexOf("\nenv \\\n");
  const output = '    > "$artifact_stage/compose.rendered.yaml"';
  const render = source.slice(start, source.indexOf(output, start) + output.length);
  const setup = source.slice(source.indexOf("# Inert Compose inputs"), start);
  const root = mkdtempSync(join(tmpdir(), "dacs-compose-command-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$#" = 4 ] && [ "$1" = compose ] && [ "$2" = --file ] && [ "$3" = "$(dirname "$(dirname "$0")")/project with spaces/compose.yaml" ] && [ "$4" = config ] || exit 91\nprintf "rendered config\\n"\n', { mode: 0o700 });
    const env = { acceptance_root: root, artifact_stage: root, project: join(root, "project with spaces"), PATH: `${bin}:/usr/bin:/bin` };
    const result = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", setup + "\n" + render], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "compose.rendered.yaml"), "utf8")).toBe("rendered config\n");
    const unsafe = spawnSync("bash", ["--norc", "--noprofile", "-eu", "-c", setup + "\n" + render.replace(" config ", " up ")], { encoding: "utf8", env });
    expect(unsafe.status).toBe(91);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

