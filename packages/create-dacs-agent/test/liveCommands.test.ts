import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, expect, test } from "vitest";

import { projectTemplates } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const cliOperations = {
  "dacs:doctor": "doctor",
  "dacs:doctor:funded": "doctor-funded",
  "dacs:up": "up",
  "dacs:setup": "setup",
  "dacs:buy": "buy",
  "dacs:status": "status",
  "dacs:metrics": "metrics",
  "dacs:down": "down",
  "dacs:backup": "backup",
  "dacs:restore": "restore",
  "dacs:uninstall": "uninstall",
  "dacs:upgrade": "upgrade",
};

test("every live manifest dispatches its commands through the loader and pins development tools", () => {
  for (const role of ["buyer", "seller"] as const) {
    for (const rails of ["both", "x402", "pay-dem"] as const) {
      const files = projectTemplates({ packageName: "agent", mode: "live-demos", role,
        deployment: "docker", rails });
      const manifest = JSON.parse(files["package.json"]!);
      const node = "node --import @kynesyslabs/dacs-node/demos-loader";
      const build = "npm run build --silent && ";
      for (const [script, operation] of Object.entries(cliOperations)) {
        expect(manifest.scripts[script], `${role}/${rails}/${script}`)
          .toBe(`${build}${node} dist/src/cli.js ${operation}`);
      }
      expect(manifest.scripts["dacs:service"]).toBe(`${build}${node} dist/src/service.js`);
      expect(manifest.scripts["dacs:smoke:offline"]).toBe(`${build}${node} dist/src/offline-smoke.js`);
      expect(manifest.scripts["dacs:image:smoke"]).toBe("node scripts/docker-runtime-smoke.mjs");
      expect(manifest.scripts.build).toBe("tsc -p tsconfig.json");
      expect(manifest.scripts.typecheck).toBe("tsc --noEmit -p tsconfig.json");
      expect(manifest.scripts.test)
        .toBe(`npm run build && ${node} --test dist/test/live-bootstrap.test.js`);
      expect(manifest.devDependencies).toEqual({ "@types/node": "20.19.1", typescript: "5.9.2" });
    }
  }
});

// Run the unmodified generated entrypoints, transpiled to JS, with their external
// dependencies replaced by explicit read-only doubles. Any unexpected call fails.
// The real npm runner still executes the generated script body and forwards args.
async function commandProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-command-contract-"));
  directories.push(root);
  const files = projectTemplates({ packageName: "agent", mode: "live-demos", role: "buyer",
    deployment: "local", rails: "both" });
  await mkdir(join(root, "dist/src"), { recursive: true });
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  const loader = join(root, "node_modules/@kynesyslabs/dacs-node");
  await mkdir(loader, { recursive: true });
  await writeFile(join(root, "package.json"), files["package.json"]!);

  const imports = new Set<string>();
  for (const entry of ["cli", "service"]) {
    const js = ts.transpileModule(files[`src/${entry}.ts`]!, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    await writeFile(join(root, `dist/src/${entry}.js`), js);
    const parsed = ts.createSourceFile(`${entry}.js`, js, ts.ScriptTarget.ES2022, true);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text.startsWith("node:")) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) throw new Error("unhandled generated import");
      for (const element of bindings.elements) imports.add((element.propertyName ?? element.name).text);
    }
  }
  const stubs: Record<string, string> = {
    VERSION: '"test-version"',
    FIXED_PRICE_X402_STANDARD_REVISION: '"test-revision"',
    DACS_NODE_LIVE_PROFILE: '"test-profile"',
    dacsLiveRailProfiles: '() => ["x402", "pay-dem"]',
    loadRoleConfig: '() => ({ limits: { maxServiceAmount: { amount: "1" }, maxEvmNetworkFeeEth: "0.001", maxDemosNetworkFeeDem: "2" } })',
    canonicalizeDecimal: '(value) => value',
    generateCanonicalJobId: '() => "11111111-1111-4111-8111-111111111111"',
    isCanonicalJobId: '() => true',
    runGeneratedDoctor: '(...args) => { seen("doctor", args); return { exitCode: 0, checks: [] }; }',
    formatDacsLiveDoctorTextV1: '() => "doctor passed\\n"',
    prepareGeneratedListingSetupV1: '(...args) => { seen("setup-plan", args); return { plan: { planHash: "setup-plan" } }; }',
    readGeneratedPurchaseRequestV1: '(path) => { seen("request", [path]); return { query: "fixture" }; }',
    prepareGeneratedPurchaseV1: '(args) => { seen("buy-plan", [args]); return { plan: { planHash: "buy-plan" } }; }',
    prepareGeneratedFundedDoctorV1: '(args) => { seen("funded-plan", [args]); return { plan: { planHash: "funded-plan" } }; }',
    startDacsLocalRoleServices: '() => { seen("start", []); return 0; }',
    stopDacsLocalRoleServices: '() => { seen("stop", []); return 0; }',
    createGeneratedBackupV1: '(args) => { seen("backup", [args]); return { backupId: "fixture-backup" }; }',
    inspectGeneratedBackupV1: '(args) => { seen("inspect-backup", [args]); return { backupId: "fixture-backup" }; }',
    assertGeneratedBackupRestorableV1: '(manifest) => { seen("restorable", [manifest]); }',
  };
  await writeFile(join(root, "stubs.mjs"),
    'const seen = (operation, args) => console.log(JSON.stringify({ stub: operation, args }));\n' +
    [...imports].map((name) => `export const ${name} = ${stubs[name] ??
      `() => { throw new Error("unexpected call: ${name}"); }`};`).join("\n"));
  await writeFile(join(loader, "package.json"), JSON.stringify({
    name: "@kynesyslabs/dacs-node", type: "module", exports: { "./demos-loader": "./loader.mjs" },
  }));
  await writeFile(join(loader, "loader.mjs"), `import { register } from "node:module";
console.log("test-loader-loaded");
register("./hooks.mjs", import.meta.url);
`);
  await writeFile(join(loader, "hooks.mjs"), `export function resolve(specifier, context, next) {
  if (/\\/dist\\/src\\/(cli|service)\\.js$/.test(context.parentURL ?? "") && !specifier.startsWith("node:")) {
    return { url: new URL("../../../stubs.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`);
  // Compilation is separately typechecked. This double makes the build step
  // observable without replacing npm or the Node process executing the entrypoint.
  const tsc = join(root, "node_modules/.bin/tsc");
  await writeFile(tsc, '#!/bin/sh\nprintf "test-build-ran\\n"\n');
  await chmod(tsc, 0o755);
  return root;
}

const cases = [
  { script: "dacs:setup", args: ["--rail", "x402", "--max-spend-dem", "7"],
    events: [{ stub: "setup-plan", args: ["x402", "7"] }], output: { execute: false, planHash: "setup-plan" } },
  { script: "dacs:buy", args: ["--rail", "x402", "--listing-ref", "stor-fixture", "--request-file", "request.json",
    "--max-service-amount", "0.5", "--max-network-fee-eth", "0.0005"],
    events: [{ stub: "request", args: ["request.json"] },
    { stub: "doctor", args: ["post-start", "buy", { listingRef: "stor-fixture", rail: "x402",
      maximumServiceAmount: "0.5", maximumNetworkFeeEth: "0.0005" }] },
    { stub: "buy-plan", args: [expect.objectContaining({ rail: "x402", listingRef: "stor-fixture",
      maximumServiceAmount: "0.5", maximumNetworkFeeEth: "0.0005" })] }],
    output: { execute: false, planHash: "buy-plan" } },
  { script: "dacs:doctor:funded", args: ["--wallet", "disposable", "--max-cost-dem", "1"],
    events: [{ stub: "funded-plan", args: [expect.objectContaining({ disposableWallet: "disposable",
      maximumTotalDebitDem: "1" })] }], output: { execute: false, planHash: "funded-plan" } },
  { script: "dacs:up", args: [], events: [{ stub: "doctor", args: ["pre-start", "start"] }, { stub: "start", args: [] }] },
  { script: "dacs:backup", args: ["--output", "../backup-fixture"],
    events: [{ stub: "stop", args: [] }, { stub: "backup", args: [{ outputDirectory: "../backup-fixture" }] }],
    output: { operation: "backup", status: "completed", backupId: "fixture-backup", services: "stopped" } },
  { script: "dacs:restore", args: ["--from", "../backup-fixture", "--backup-id", "fixture-backup",
    "--safety-backup", "../safety-fixture"], events: [
    { stub: "inspect-backup", args: [{ backupDirectory: "../backup-fixture" }] },
    { stub: "restorable", args: [{ backupId: "fixture-backup" }] }],
    output: { operation: "restore", execute: false, backupId: "fixture-backup", safetyBackupDirectory: "../safety-fixture" } },
  { script: "dacs:uninstall", args: ["--backup", "../backup-fixture"], events: [],
    output: { operation: "uninstall", execute: false, backupDirectory: "../backup-fixture", removesData: false } },
  { script: "dacs:service", args: [], events: [], status: 1,
    error: { event: "dacs.live-service.failed", reasonCode: "service-role-unconfigured" } },
];

test.each(cases)("$script executes the generated entrypoint with forwarded arguments", async (scenario) => {
  const root = await commandProject();
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("DACS_") && name !== "NODE_OPTIONS"));
  const child = spawnSync("npm", ["run", "--silent", scenario.script, "--", ...scenario.args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...env, DACS_DEPLOYMENT: "local", npm_config_ignore_scripts: "false" },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr + child.stdout).toBe(scenario.status ?? 0);
  expect(child.stdout).toContain("test-build-ran\n");
  expect(child.stdout).toContain("test-loader-loaded\n");
  const records = child.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  expect(records.filter((record) => record.stub)).toEqual(scenario.events);
  if (scenario.output) expect(records).toContainEqual(expect.objectContaining(scenario.output));
  if (scenario.error) {
    expect(child.stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining(scenario.error));
  }
}, 30_000);
