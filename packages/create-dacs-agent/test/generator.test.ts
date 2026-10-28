import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";

import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";

import { createDacsAgentProject, projectTemplates } from "../src/index.js";
import { parseCreateDacsAgentArguments } from "../src/cli.js";
import { publishCompleteStagingDirectory } from "../src/publication.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-dacs-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function filesBelow(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, path)));
    else files.push(path.slice(root.length + 1));
  }
  return files.sort();
}

const TEST_ONLY_FAKE_IMAGE_ID = "sha256:" + "1".repeat(64);
const TEST_ONLY_REPLACEMENT_IMAGE_ID = "sha256:" + "2".repeat(64);
const TEST_ONLY_RUNTIME_UID = 4242;
const TEST_ONLY_RUNTIME_GID = 4343;
// Each generated-smoke case spawns Node twice; keep slow CI hosts off the 5s default.
const SPAWNING_TEST_TIMEOUT_MS = 30_000;
const GENERATED_SERVICE_COMMAND = [
  "node",
  "--import",
  "@kynesyslabs/dacs-node/demos-loader",
  "dist/src/service.js",
];
const GENERATED_ROLE_CHECK_REPORT = JSON.stringify({
  event: "dacs.live-service.failed",
  reasonCode: "service-role-unconfigured",
});
// What the generated service reports for any other failure without a reason code.
const GENERATED_GENERIC_FAILURE_REPORT = JSON.stringify({
  event: "dacs.live-service.failed",
  reasonCode: "role-runtime-unavailable",
});

interface FakeContainer {
  Id: string;
  Image: string;
  project: string;
  service: string;
  running: boolean;
  // The project directory compose created it for; absent, it has no such label.
  workingDir?: string;
  // Created by `compose run` rather than as the service.
  oneoff?: boolean;
  inspection?: Record<string, unknown>;
}

// The image's Node release, which the Dockerfile's base image pins.
const GENERATED_IMAGE_NODE_VERSION = "20.19.1";

interface FakeDockerScenario {
  // Successive resolutions of an image tag, by `docker image inspect --format
  // {{.Id}}` or by compose creating a container from a tag; the last repeats.
  imageIds: string[];
  daemonDown?: boolean;
  config: Readonly<Record<string, unknown>>;
  // The probe runs for real against a production tree (see
  // writeProductionTree) unless this replaces its output.
  probe?: Readonly<Record<string, unknown>>;
  // Changes to that tree: installed versions, paths removed or added, and
  // symbolic links (path to target).
  app?: Readonly<{
    versions?: Record<string, string>;
    remove?: string[];
    add?: string[];
    links?: Record<string, string>;
  }>;
  // What the probe's process sees in place of the --user identity and the
  // image's Node release.
  container?: Readonly<{ uid?: number; gid?: number; node?: string }>;
  service: Readonly<{ status: number; stderr: string }>;
  // That container never exits by itself.
  hang?: "probe" | "service";
  // `docker compose version --short` prints this.
  composeVersion?: string;
  // compose up exits with this status after creating only composeUpCreates.
  composeUpStatus?: number;
  composeUpCreates?: string[];
  // These docker commands ("ps", "container", "rm" or "compose <subcommand>")
  // fail every time, or only on these calls, counting from 1.
  fails?: string[];
  failsCalls?: Record<string, number[]>;
  // Compose is killed by a signal.
  composeKilled?: boolean;
  // compose stop succeeds but leaves the containers running.
  stopLeavesRunning?: boolean;
  // The first docker container inspect prints this instead of the containers.
  inspectOutput?: string;
  // A compose that creates every container from this image instead.
  composeCreatesImage?: string;
  // A compose that does not create these services.
  composeSkips?: string[];
  // Another compose creates these while the first compose up runs.
  composeUpAdds?: FakeContainer[];
  containers?: FakeContainer[];
  inspectChanges?: Record<string, Record<string, unknown>>;
}

function passingDockerScenario(
  overrides: Partial<FakeDockerScenario> = {},
): FakeDockerScenario {
  return {
    imageIds: [TEST_ONLY_FAKE_IMAGE_ID],
    // Docker CLI 28.2 and later print no Entrypoint key for an unset entrypoint.
    config: {
      User: "10001:10001",
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=20.19.1",
        "NODE_ENV=production",
      ],
      Cmd: GENERATED_SERVICE_COMMAND,
      WorkingDir: "/app",
    },
    service: { status: 1, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" },
    ...overrides,
  };
}

// Compose is modelled only as far as dacs:up depends on it: which files it
// reads (--file, else COMPOSE_FILE, else compose.yaml plus compose.override.yaml),
// the project name (--project-name, else COMPOSE_PROJECT_NAME, else the
// directory name), each service's image (an override's per-service image:,
// else DACS_IMAGE from the environment, else .env) and the services started
// (those named, else every service in the files). Each container it creates
// carries the project directory it was created for.
//
// The smoke's probe container runs the probe program it is given with the
// node arguments it is given, against a production tree standing in for /app,
// as a process that sees the --user identity and the image's Node release.
const TEST_ONLY_FAKE_DOCKER_SOURCE = `const {
  appendFileSync, existsSync, readFileSync, writeFileSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const args = process.argv.slice(2);
const log = process.env.CREATE_DACS_AGENT_TEST_DOCKER_LOG;
const containersPath = log + ".containers.json";
const scenario = JSON.parse(readFileSync(
  process.env.CREATE_DACS_AGENT_TEST_DOCKER_SCENARIO, "utf8"));
appendFileSync(log, JSON.stringify(args) + "\\n");
if (scenario.daemonDown) {
  process.stderr.write("Cannot connect to the test-only Docker daemon\\n");
  process.exit(1);
}
function once(name) {
  const marker = log + ".once-" + name.replace(/ /g, "-");
  if (existsSync(marker)) return false;
  writeFileSync(marker, "");
  return true;
}
function failIf(name) {
  const counter = log + ".calls-" + name.replace(/ /g, "-");
  const call = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(call));
  if ((scenario.fails ?? []).includes(name) ||
      (scenario.failsCalls?.[name] ?? []).includes(call)) {
    process.stderr.write("test-only " + name + " failure\\n");
    process.exit(1);
  }
}
function runProbe() {
  const user = args[args.indexOf("--user") + 1].split(":").map(Number);
  const nodeArguments = args.slice(args.indexOf("--entrypoint") + 3);
  const program = nodeArguments.indexOf("--eval") + 1;
  // The probe's one reference to the image's /app.
  const app = 'const app = "/app";';
  if (program === 0 || nodeArguments[program].split("\\n").filter((line) => line === app)
    .length !== 1) {
    process.stderr.write("test-only fake cannot map the probe's /app\\n");
    process.exit(64);
  }
  nodeArguments[program] = nodeArguments[program]
    .replace(app, "const app = " + JSON.stringify(scenario.appRoot) + ";");
  const seen = { uid: user[0], gid: user[1], node: ${JSON.stringify(GENERATED_IMAGE_NODE_VERSION)},
    ...scenario.container };
  const child = spawnSync(process.execPath, [
    "--import", pathToFileURL(scenario.containerShim).href, ...nodeArguments,
  ], {
    cwd: scenario.appRoot,
    encoding: "utf8",
    env: { CREATE_DACS_AGENT_TEST_CONTAINER: JSON.stringify(seen) },
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
}
function resolveTag() {
  const counter = log + ".resolutions";
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  const ids = scenario.imageIds;
  return ids[Math.min(count, ids.length - 1)];
}
function containers() {
  return existsSync(containersPath)
    ? JSON.parse(readFileSync(containersPath, "utf8")) : scenario.containers ?? [];
}
function saveContainers(value) {
  writeFileSync(containersPath, JSON.stringify(value));
}
function hang() {
  setTimeout(() => {}, 60_000);
}
function composeServices(files, defaultImage) {
  const services = new Map();
  for (const file of files) {
    let inServices = false;
    let current;
    for (const line of readFileSync(file, "utf8").split("\\n")) {
      if (/^\\S/.test(line)) inServices = line.trim() === "services:";
      const service = inServices && /^  ([A-Za-z0-9_-]+):\\s*$/.exec(line);
      const image = inServices && /^    image:\\s*(\\S+)\\s*$/.exec(line);
      if (service) {
        current = service[1];
        if (!services.has(current)) services.set(current, defaultImage);
      } else if (image && current !== undefined) {
        services.set(current, image[1]);
      }
    }
  }
  return services;
}
function compose(rest) {
  let files = [];
  let directory;
  let project;
  let index = 0;
  for (; index < rest.length; index += 1) {
    if (rest[index] === "--file") files.push(rest[++index]);
    else if (rest[index] === "--project-directory") directory = rest[++index];
    else if (rest[index] === "--project-name") project = rest[++index];
    else break;
  }
  const [subcommand, ...options] = rest.slice(index);
  appendFileSync(log + ".compose-env", JSON.stringify({
    subcommand,
    DACS_IMAGE: process.env.DACS_IMAGE,
    DACS_RUNTIME_UID: process.env.DACS_RUNTIME_UID,
    DACS_RUNTIME_GID: process.env.DACS_RUNTIME_GID,
    COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME,
    composeVariables: Object.keys(process.env).filter((name) => name.startsWith("COMPOSE_")),
  }) + "\\n");
  if (scenario.composeKilled) process.kill(process.pid, "SIGKILL");
  failIf("compose " + subcommand);
  directory ??= process.cwd();
  project ??= process.env.COMPOSE_PROJECT_NAME ?? basename(directory);
  if (files.length === 0 && process.env.COMPOSE_FILE !== undefined) {
    files = process.env.COMPOSE_FILE.split(":").map((file) => resolve(file));
  } else if (files.length === 0) {
    files = [join(directory, "compose.yaml")];
    if (existsSync(join(directory, "compose.override.yaml"))) {
      files.push(join(directory, "compose.override.yaml"));
    }
  }
  const persisted = existsSync(join(directory, ".env"))
    ? /^DACS_IMAGE=(.*)$/m.exec(readFileSync(join(directory, ".env"), "utf8"))?.[1]
    : undefined;
  const models = composeServices(files, process.env.DACS_IMAGE ?? persisted);
  const named = [];
  for (let position = 0; position < options.length; position += 1) {
    if (options[position] === "--pull") position += 1;
    else if (!options[position].startsWith("-")) named.push(options[position]);
  }
  const selected = named.length === 0 ? [...models.keys()] : named;
  const state = containers();
  if (subcommand === "up") {
    for (const service of selected) {
      if (scenario.composeUpStatus !== undefined &&
          !(scenario.composeUpCreates ?? []).includes(service)) continue;
      if (!models.has(service)) process.exit(15);
      if ((scenario.composeSkips ?? []).includes(service)) continue;
      const reference = models.get(service);
      const Image = scenario.composeCreatesImage ??
        (reference.startsWith("sha256:") ? reference : resolveTag());
      const Id = "container-" + project + "-" + service;
      const kept = state.filter((container) => container.Id !== Id);
      state.length = 0;
      state.push(...kept, { Id, Image, project, service, running: true, workingDir: directory,
        inspection: scenario.inspection[service] });
    }
    if (once("up-adds")) state.push(...(scenario.composeUpAdds ?? []));
    saveContainers(state);
    if (scenario.composeUpStatus !== undefined) process.exit(scenario.composeUpStatus);
  } else if (subcommand === "stop" && !scenario.stopLeavesRunning) {
    for (const container of state) {
      if (container.project === project && selected.includes(container.service) && !container.oneoff) {
        container.running = false;
      }
    }
    saveContainers(state);
  } else if (subcommand === "down") {
    saveContainers(state.filter((container) => container.project !== project));
  }
}
if (args[0] === "image" && args[1] === "inspect" && args[3] === "{{.Id}}") {
  process.stdout.write(resolveTag() + "\\n");
} else if (args[0] === "image" && args[1] === "inspect" &&
    args[3] === "{{json .Config}}") {
  process.stdout.write(JSON.stringify(scenario.config) + "\\n");
} else if (args[0] === "run" && args.includes("--entrypoint")) {
  if (scenario.hang === "probe") hang();
  else if (scenario.probe !== undefined) {
    process.stdout.write(JSON.stringify(scenario.probe) + "\\n");
  } else runProbe();
} else if (args[0] === "run") {
  if (scenario.hang === "service") hang();
  else {
    process.stderr.write(scenario.service.stderr);
    process.exitCode = scenario.service.status;
  }
} else if (args[0] === "rm" && args[1] === "--force") {
  // Removing the named smoke container succeeds unless it fails.
  failIf("rm");
} else if (args[0] === "compose" && args[1] === "version" && args[2] === "--short") {
  failIf("compose version");
  process.stdout.write((scenario.composeVersion ?? "2.29.7") + "\\n");
} else if (args[0] === "compose") {
  compose(args.slice(1));
} else if (args[0] === "ps" && args.includes("--all") && args.includes("--quiet")) {
  failIf("ps");
  const label = args[args.indexOf("--filter") + 1];
  for (const container of containers()) {
    if (label === "label=com.docker.compose.project=" + container.project) {
      process.stdout.write(container.Id + "\\n");
    }
  }
} else if (args[0] === "container" && args[1] === "inspect") {
  if (args.length === 2) {
    process.stderr.write("test-only: docker container inspect requires at least 1 argument\\n");
    process.exit(1);
  }
  failIf("container");
  if (scenario.inspectOutput !== undefined && once("inspect-output")) {
    process.stdout.write(scenario.inspectOutput + "\\n");
    process.exit(0);
  }
  const state = containers();
  process.stdout.write(JSON.stringify(args.slice(2).map((id) => {
    const container = state.find((candidate) => candidate.Id === id);
    const original = container.inspection ?? {};
    const changed = scenario.inspectChanges?.[container.service] ?? {};
    const inspection = { ...original, ...changed,
      Config: { ...original.Config, ...changed.Config },
      HostConfig: { ...original.HostConfig, ...changed.HostConfig } };
    return {
      ...inspection,
      Id: id,
      Image: container.Image,
      Config: { ...inspection.Config, Labels: {
        "com.docker.compose.project": container.project,
        "com.docker.compose.service": container.service,
        "com.docker.compose.oneoff": container.oneoff ? "True" : "False",
        ...(container.workingDir === undefined ? {}
          : { "com.docker.compose.project.working_dir": container.workingDir }),
      } },
      State: { Running: container.running },
    };
  })) + "\\n");
} else {
  process.stderr.write("unexpected test-only fake docker invocation\\n");
  process.exitCode = 64;
}
`;

// Executables run through an absolute /bin/sh wrapper and the current Node
// binary, so the only PATH a generated script sees is the fake directory.
async function writeFakeExecutable(directory: string, name: string, source: string) {
  const implementation = join(directory, `${name}.cjs`);
  for (const path of [process.execPath, implementation]) {
    if (path.includes("'")) throw new Error("test-only path cannot be single-quoted");
  }
  await writeFile(implementation, source, "utf8");
  await writeFile(
    join(directory, name),
    `#!/bin/sh\nexec '${process.execPath}' '${implementation}' "$@"\n`,
    "utf8",
  );
  await chmod(join(directory, name), 0o700);
}

async function generatedDockerProject(name: string, rails: "both" | "x402" | "pay-dem" = "both"): Promise<string> {
  const parent = await temporaryDirectory();
  const target = join(parent, name);
  await createDacsAgentProject({
    targetDirectory: target,
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role: "buyer",
    deployment: "docker",
    rails,
    install: false,
  });
  // The README's `cp .env.example .env`, with a fixed compose runtime user.
  const environment = (await readFile(join(target, ".env.example"), "utf8"))
    .replace(/^DACS_RUNTIME_UID=.*$/m, `DACS_RUNTIME_UID=${TEST_ONLY_RUNTIME_UID}`)
    .replace(/^DACS_RUNTIME_GID=.*$/m, `DACS_RUNTIME_GID=${TEST_ONLY_RUNTIME_GID}`);
  const values = parseEnv(environment);
  const compose = await readFile(join(target, "compose.yaml"), "utf8");
  let configured = environment;
  for (const [, name] of compose.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/g)) {
    if (values[name!] === undefined || values[name!] === "") {
      const value = join(target, "fixture-" + name!.toLowerCase());
      configured = configured.replace(new RegExp("^" + name + "=.*$", "m"), name + "=" + value);
      values[name!] = value;
    }
  }
  await writeFile(join(target, ".env"), configured, "utf8");
  return target;
}

const SDK_ENTRY_POINTS = [
  "@kynesyslabs/dacs",
  "@kynesyslabs/dacs/substrate",
  "@kynesyslabs/dacs-node",
  "@kynesyslabs/demosdk/websdk",
  "@kynesyslabs/demosdk/storage",
  "@kynesyslabs/demosdk/abstraction",
];
// The SDK and host kit import these on an x402 rail's first use.
const X402_ENTRY_POINTS = [
  "viem",
  "viem/accounts",
  "@x402/core/client",
  "@x402/core/server",
  "@x402/evm",
  "@x402/evm/exact/client",
  "@x402/evm/exact/server",
  "@x402/fetch",
];
// Where an entry point's stub module lives below /app.
function entryPointModule(entryPoint: string): string {
  const parts = entryPoint.split("/");
  const packageLength = entryPoint.startsWith("@") ? 2 : 1;
  const subpath = parts.slice(packageLength).join("/");
  return join("node_modules", ...parts.slice(0, packageLength), `${subpath || "index"}.js`);
}
const SQLITE_BINDING = join("node_modules", "better-sqlite3", "build", "Release",
  "better_sqlite3.node");

// /app as the generated Dockerfile leaves it: the built service, the package
// files and production dependencies at the versions package.json pins, as
// stub packages that export each entry point. Opening a stub database reads
// SQLITE_BINDING, as better-sqlite3 loads its native binding.
async function writeProductionTree(
  root: string,
  dependencies: Readonly<Record<string, string>>,
  changes: FakeDockerScenario["app"] = {},
): Promise<void> {
  const files: Record<string, string> = {
    [join("dist", "src", "service.js")]: "",
    [join("dist", "src", "cli.js")]: "",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    [entryPointModule("@kynesyslabs/dacs-node/demos-loader")]: "",
    [SQLITE_BINDING]: "",
  };
  for (const [name, version] of Object.entries(dependencies)) {
    files[join("node_modules", name, "package.json")] = JSON.stringify({
      name,
      version: changes.versions?.[name] ?? version,
      type: "module",
      exports: { ".": "./index.js", "./*": "./*.js" },
    });
    files[join("node_modules", name, "index.js")] = "export {};\n";
  }
  for (const entryPoint of [...SDK_ENTRY_POINTS, ...X402_ENTRY_POINTS]) {
    files[entryPointModule(entryPoint)] = "export {};\n";
  }
  files[join("node_modules", "better-sqlite3", "index.js")] = [
    'import { readFileSync } from "node:fs";',
    "export default class Database {",
    "  constructor() {",
    '    readFileSync(new URL("./build/Release/better_sqlite3.node", import.meta.url));',
    "  }",
    '  prepare(sql) { return { get: () => (sql === "SELECT 1 AS one" ? { one: 1 } : {}) }; }',
    "  close() {}",
    "}",
    "",
  ].join("\n");
  for (const path of changes.remove ?? []) delete files[path];
  for (const path of changes.add ?? []) files[path] = "";
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source, "utf8");
  }
  for (const [path, linked] of Object.entries(changes.links ?? {})) {
    await symlink(linked, join(root, path));
  }
}

// Preloaded into the fake's probe process: the identity and Node release the
// container would give it.
const TEST_ONLY_CONTAINER_SHIM = `const seen = JSON.parse(process.env.CREATE_DACS_AGENT_TEST_CONTAINER);
process.getuid = () => seen.uid;
process.getgid = () => seen.gid;
Object.defineProperty(process, "versions", { value: { ...process.versions, node: seen.node } });
`;

// Preloaded into the generated script: stat reports the project directory with
// its device number or inode shifted, as after a remount renumbers its file
// system, or for another directory put at its path.
const TEST_ONLY_STAT_SHIFT_SHIM = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const shift = JSON.parse(process.env.CREATE_DACS_AGENT_TEST_STAT_SHIFT);
const statSync = fs.statSync;
fs.statSync = (path, options) => {
  const stats = statSync(path, options);
  if (options?.bigint === true && String(path) === shift.path) {
    stats.dev += BigInt(shift.dev);
    stats.ino += BigInt(shift.ino);
  }
  return stats;
};
syncBuiltinESMExports();
`;

// Environment that runs the generated script under TEST_ONLY_STAT_SHIFT_SHIM.
async function statShiftEnvironment(
  target: string,
  shift: Readonly<{ dev: number; ino: number | string }>,
): Promise<Record<string, string>> {
  const shim = join(await temporaryDirectory(), "stat-shift-shim.mjs");
  await writeFile(shim, TEST_ONLY_STAT_SHIFT_SHIM, "utf8");
  return {
    NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`,
    CREATE_DACS_AGENT_TEST_STAT_SHIFT: JSON.stringify({ path: await realpath(target), ...shift }),
  };
}

// Runs the generated src/service.ts, transpiled, on the host Node with every
// module it imports replaced by a stub whose exports throw, and reports how it
// exited. env is the service's whole environment apart from PATH.
async function runGeneratedService(target: string, env: Record<string, string>) {
  const root = await temporaryDirectory();
  const service = ts.transpileModule(
    await readFile(join(target, "src", "service.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    [join("dist", "src", "service.js")]: service,
  };
  for (const [, names, specifier] of service.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const local = specifier!.startsWith("./");
    files[local ? join("dist", "src", specifier!) : entryPointModule(specifier!)] = names!
      .split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!).filter(Boolean)
      .map((name) => `export const ${name} = () => { throw new Error("test-only stub"); };\n`)
      .join("");
    if (!local) {
      const parts = specifier!.split("/");
      const name = parts.slice(0, specifier!.startsWith("@") ? 2 : 1).join("/");
      files[join("node_modules", name, "package.json")] = JSON.stringify({
        name,
        type: "module",
        exports: { ".": "./index.js", "./*": "./*.js" },
      });
    }
  }
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source, "utf8");
  }
  const result = spawnSync(process.execPath, [join(root, "dist", "src", "service.js")], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

// umask: run the script under this file-creation mask rather than the test's.
type SmokeOptions = Readonly<{ args?: string[]; env?: Record<string, string>; umask?: string }>;

async function runGeneratedDockerSmoke(
  target: string,
  scenario: FakeDockerScenario | undefined,
  options: SmokeOptions = {},
) {
  const fakeBin = await temporaryDirectory();
  const dockerLog = join(fakeBin, "docker-calls.jsonl");
  const scenarioPath = join(fakeBin, "docker-scenario.json");
  if (scenario !== undefined) {
    const appRoot = join(fakeBin, "app");
    const containerShim = join(fakeBin, "container-shim.mjs");
    const { dependencies } = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    await writeProductionTree(appRoot, dependencies, scenario.app);
    await writeFile(containerShim, TEST_ONLY_CONTAINER_SHIM, "utf8");
    const values = { ...parseEnv(await readFile(join(target, ".env"), "utf8").catch(() => "")), ...options.env };
    const interpolate = (value: string) => value.replace(/\$\{([A-Z0-9_]+)(?:(:-|:\?)([^}]*))?\}/g,
      (_match, name, operator, fallback) => values[name] || (operator === ":-" ? fallback : ""));
    const compose = parseYaml(await readFile(join(target, "compose.yaml"), "utf8"), { merge: true });
    const inspection = Object.fromEntries(Object.entries(compose.services).map(([role, raw]) => {
      const service = raw as any;
      const environment = new Map((Array.isArray(scenario.config.Env) ? scenario.config.Env as string[] : []).map((entry) => {
        const split = entry.indexOf("=");
        return [entry.slice(0, split), entry.slice(split + 1)];
      }));
      for (const [name, value] of Object.entries(service.environment)) environment.set(name, interpolate(String(value)));
      return [role, {
        Config: { User: interpolate(service.user), WorkingDir: "/app", Cmd: GENERATED_SERVICE_COMMAND,
          Env: [...environment].map(([name, value]) => name + "=" + value), Entrypoint: [],
          Healthcheck: { Test: service.healthcheck.test, Interval: 10_000_000_000,
            Timeout: 3_000_000_000, Retries: service.healthcheck.retries, StartPeriod: 10_000_000_000 } },
        Mounts: service.volumes.map((volume: string) => {
          const [source, destination, mode] = interpolate(volume).split(":");
          return { Type: "bind", Source: resolve(target, source!), Destination: destination, RW: mode !== "ro" };
        }),
        HostConfig: { ReadonlyRootfs: service.read_only, Privileged: false,
          NetworkMode: service.network_mode, CapDrop: service.cap_drop,
          SecurityOpt: service.security_opt, Tmpfs: { "/tmp": "rw,noexec,nosuid,size=32m" },
          Init: service.init, PidsLimit: service.pids_limit, Memory: 512 * 1024 * 1024,
          RestartPolicy: { Name: service.restart, MaximumRetryCount: 0 },
          LogConfig: { Type: service.logging.driver, Config: service.logging.options } },
      }];
    }));
    await writeFile(
      scenarioPath,
      JSON.stringify({ ...scenario, appRoot, containerShim, inspection }),
      "utf8",
    );
    await writeFakeExecutable(fakeBin, "docker", TEST_ONLY_FAKE_DOCKER_SOURCE);
  }
  const script = [
    process.execPath,
    join(target, "scripts", "docker-runtime-smoke.mjs"),
    ...(options.args ?? []),
  ];
  const result = spawnSync(
    options.umask === undefined ? script[0]! : "/bin/sh",
    options.umask === undefined ? script.slice(1)
      : ["-c", `umask ${options.umask} && exec "$0" "$@"`, ...script],
    {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: fakeBin,
        CREATE_DACS_AGENT_TEST_DOCKER_LOG: dockerLog,
        CREATE_DACS_AGENT_TEST_DOCKER_SCENARIO: scenarioPath,
        ...options.env,
      },
    },
  );
  const lines = async (path: string) => (await readFile(path, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const invocations = await lines(dockerLog) as string[][];
  // What each compose invocation saw in its environment.
  const composeEnvironments = await lines(`${dockerLog}.compose-env`) as {
    subcommand: string;
    DACS_IMAGE?: string;
    DACS_RUNTIME_UID?: string;
    DACS_RUNTIME_GID?: string;
    COMPOSE_PROJECT_NAME?: string;
    composeVariables: string[];
  }[];
  const containers = await readFile(`${dockerLog}.containers.json`, "utf8")
    .then((source) => (JSON.parse(source) as FakeContainer[]).map(({ inspection: _inspection, ...container }) => container), () => undefined);
  const receipt = await readFile(
    join(target, ".dacs-runtime", "docker-image-smoke.json"),
    "utf8",
  ).then((source) => JSON.parse(source) as unknown, () => undefined);
  return { ...result, invocations, composeEnvironments, containers, receipt };
}

// The identity the generator wrote into a project's Docker lifecycle script.
async function generatedProjectIdentity(target: string): Promise<string> {
  const script = await readFile(join(target, "scripts", "docker-runtime-smoke.mjs"), "utf8");
  const identities = [...script.matchAll(/^const projectIdentity = "([0-9a-f]{32})";$/gm)];
  if (identities.length !== 1) throw new Error("generated script has no single identity");
  return identities[0]![1]!;
}

// The compose project name of a generated project: its directory's name and
// the start of the SHA-256 of its identity followed by its full path.
async function generatedProjectName(target: string): Promise<string> {
  const directory = await realpath(target);
  return `${basename(directory)}-` + createHash("sha256")
    .update(await generatedProjectIdentity(target) + directory).digest("hex").slice(0, 12);
}

// The compose invocation prefix every Docker lifecycle command uses.
async function generatedComposeArguments(target: string): Promise<string[]> {
  const directory = await realpath(target);
  return [
    "compose",
    "--file", join(directory, "compose.yaml"),
    "--project-directory", directory,
    "--project-name", await generatedProjectName(target),
  ];
}

// The inode the Docker lifecycle records for a project directory.
async function directoryInode(target: string): Promise<{ device: string; inode: string }> {
  const observed = await stat(target, { bigint: true });
  return { device: String(observed.dev), inode: String(observed.ino) };
}

// A compose command on the project, rather than `docker compose version`.
const isComposeInvocation = (args: readonly string[]) =>
  args[0] === "compose" && args[1] === "--file";
const COMPOSE_VERSION_CHECK = ["compose", "version", "--short"];
// What each compose command runs first: the version check, then the
// project's containers (none here).
async function composeChecks(target: string): Promise<string[][]> {
  return [COMPOSE_VERSION_CHECK, [
    "ps", "--all", "--quiet", "--no-trunc",
    "--filter", `label=com.docker.compose.project=${await generatedProjectName(target)}`,
  ]];
}

function localImageReferenceOf(environment: string): string {
  const match = /^DACS_IMAGE=(.+)$/m.exec(environment);
  if (match === null) throw new Error("generated .env.example has no DACS_IMAGE");
  return match[1]!;
}

describe("create-dacs-agent", () => {
  test.each(["x402", "pay-dem"] as const)("starts the exact generated role policy for %s alone", async (rails) => {
    const target = await generatedDockerProject(`policy-${rails}-agent`, rails);
    const smoked = await runGeneratedDockerSmoke(target, passingDockerScenario());
    expect(smoked.status, smoked.stderr).toBe(0);
    const started = await runGeneratedDockerSmoke(target, passingDockerScenario(), { args: ["--up"] });
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(started.stdout).services).toEqual(["buyer", "seller"]);
  }, SPAWNING_TEST_TIMEOUT_MS);

  test("rejects malformed public project identities before rendering executable code", () => {
    for (const projectIdentity of ["", "A".repeat(32), "f".repeat(31), '";throw new Error(); //', "a\nb"]) {
      expect(() => projectTemplates({ packageName: "agent", mode: "live-demos", deployment: "docker",
        projectIdentity })).toThrow("projectIdentity must be 32 lower-case hex digits");
    }
  });

  test("refuses a changed role secret mount both before smoke and after its receipt", async () => {
    const target = await generatedDockerProject("mount-policy-agent");
    expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
    const path = join(target, "compose.yaml");
    const approved = await readFile(path, "utf8");
    await writeFile(path, approved.replace(
      "- ${DACS_SELLER_DEMOS_SECRET_FILE:?set DACS_SELLER_DEMOS_SECRET_FILE}:",
      "- ${DACS_BUYER_DEMOS_SECRET_FILE:?set DACS_BUYER_DEMOS_SECRET_FILE}:",
    ));
    for (const args of [["--up"], []]) {
      const refused = await runGeneratedDockerSmoke(target, passingDockerScenario(), { args });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("compose.yaml differs from the generated role policy");
      expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
      expect(refused.containers).toBeUndefined();
    }
  });

  test("builds publishable files from source during pack and publish", async () => {
    const packageSource = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageSource.scripts).toMatchObject({
      prepack: "npm run clean && npm run build",
      prepublishOnly: "npm run clean && npm run build",
      clean: "rm -rf dist",
    });
  });

  test("requires the generated project's host dependency to build during pack", async () => {
    const hostPackage = JSON.parse(
      await readFile(new URL("../../dacs-node/package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(hostPackage.scripts).toMatchObject({
      "build:with-core": "npm --prefix ../.. run build && npm run build",
      prepack: "npm run clean && npm run build:with-core",
      prepublishOnly: "npm run clean && npm run build:with-core",
    });
    const corePackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(corePackage.scripts).toMatchObject({
      prepack: "npm run clean && npm run build",
    });
  });

  test("generates the bounded public-package verifier simulation without installing", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "my-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      install: false,
      role: "demo-all",
      deployment: "local",
    });

    expect(result).toMatchObject({
      mode: "offline",
      profile: "dacs-sdk:fixed-price-offline:v1",
      installed: false,
      ran: false,
    });
    expect(await filesBelow(target)).toEqual([
      ".dockerignore",
      ".env.example",
      ".gitignore",
      "Dockerfile",
      "README.md",
      "compose.yaml",
      "dacs.config.ts",
      "data/.gitkeep",
      "package.json",
      "secrets/README.md",
      "src/buyer.ts",
      "src/config.ts",
      "src/seller.ts",
      "src/service.ts",
      "src/verifier.ts",
      "test/offline-lifecycle.test.ts",
      "tsconfig.json",
    ]);
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
    });
    const generatedSources = await Promise.all(
      (await filesBelow(target)).map((file) => readFile(join(target, file), "utf8")),
    );
    const combined = generatedSources.join("\n");
    expect(combined).not.toContain("../../src/");
    expect(combined).not.toContain("@kynesyslabs/dacs/dist");
    expect(combined).not.toMatch(/PRIVATE_KEY|SEED_PHRASE|MNEMONIC/);
    expect(combined).toContain("normativeConformance");
    expect(combined).toContain("commercialSuccess");
    expect(combined).toContain("not the SR-3 attestation required");
    expect(combined).toContain('randomBytes(16).toString("hex")');
    expect(combined).not.toContain("new Date().toISOString()");
    const dockerignore = await readFile(join(target, ".dockerignore"), "utf8");
    expect(dockerignore.split("\n").filter(Boolean)).toEqual([
      "**",
      "!package.json",
      "!package-lock.json",
      "!tsconfig.json",
      "!dacs.config.ts",
      "!src/",
      "!src/**",
      "!test/",
      "!test/**",
    ]);
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY package.json package-lock.json ./",
    );
    expect(dockerfile).toContain(
      "npm prune --omit=dev --ignore-scripts",
    );
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts");
    expect(dockerfile).not.toContain("RUN npm install");
    expect(dockerfile).not.toContain("COPY . .");
    expect(dockerfile.indexOf("COPY package.json package-lock.json ./"))
      .toBeLessThan(dockerfile.indexOf("RUN npm ci --ignore-scripts"));
    expect(dockerfile).toContain(
      "install --directory --owner=dacs --group=dacs --mode=0750 /app/data",
    );
    expect(dockerfile).not.toContain(
      "COPY --from=build --chown=dacs:dacs /app /app",
    );
    await expect(
      readFile(join(target, "package-lock.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed for incompatible profiles, run without install, and non-empty targets", async () => {
    const parent = await temporaryDirectory();
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "live"),
        mode: "live-demos",
        profile: "dacs-sdk:fixed-price-offline:v1",
        install: false,
      }),
    ).rejects.toThrow(/live-demos mode requires/);
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "run"),
        install: false,
        run: true,
      }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(
      createDacsAgentProject({
        targetDirectory: join(parent, "unsupported-role"),
        role: "buyer" as never,
        install: false,
      }),
    ).rejects.toThrow(/only the single-process demo-all simulation/);

    const occupied = join(parent, "occupied");
    await writeFile(occupied, "occupied", "utf8");
    await expect(
      createDacsAgentProject({ targetDirectory: occupied, install: false }),
    ).rejects.toThrow(/not a directory/);

    const linked = join(parent, "linked");
    await symlink(parent, linked);
    await expect(
      createDacsAgentProject({ targetDirectory: linked, install: false }),
    ).rejects.toThrow(/symbolic link/);

    // A Docker deployment's directory name is its compose project name as it stands.
    const live = {
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      install: false,
    } as const;
    for (const name of ["agent.a", "Agent", "_agent"]) {
      await expect(createDacsAgentProject({
        ...live,
        targetDirectory: join(parent, name),
        deployment: "docker",
      }), name).rejects.toThrow(/directory name must be a compose project name/);
      await expect(lstat(join(parent, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(createDacsAgentProject({
      ...live,
      targetDirectory: join(parent, "Local.Agent"),
      deployment: "local",
    })).resolves.toMatchObject({ deployment: "local" });
    // An offline project has no compose lifecycle to name.
    await expect(createDacsAgentProject({
      targetDirectory: join(parent, "Offline.Agent"),
      deployment: "docker",
      install: false,
    })).resolves.toMatchObject({ mode: "offline", deployment: "docker" });
  });

  test("gives each live project's Docker lifecycle its own random identity", () => {
    const options = {
      packageName: "agent",
      deployment: "docker",
      mode: "live-demos",
      role: "buyer",
      rails: "both",
    } as const;
    const script = (projectIdentity?: string) =>
      projectTemplates({ ...options, projectIdentity })["scripts/docker-runtime-smoke.mjs"]!;
    const identityOf = (source: string) =>
      /^const projectIdentity = "([0-9a-f]{32})";$/m.exec(source)?.[1];
    const given = "a".repeat(32);
    expect(identityOf(script(given))).toBe(given);
    expect(script(given)).toContain(
      'createHash("sha256").update(projectIdentity + projectPath).digest("hex").slice(0, 12)',
    );
    const generated = [script(), script()].map(identityOf);
    expect(generated[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(generated[1]).not.toBe(generated[0]);
    for (const invalid of ["A".repeat(32), "a".repeat(31), "a".repeat(33), "g".repeat(32)]) {
      expect(() => script(invalid)).toThrow("projectIdentity must be 32 lower-case hex digits");
    }
    // A non-string whose text would pass the pattern is refused as well.
    expect(() => projectTemplates({ ...options, projectIdentity: ["a".repeat(32)] as never }))
      .toThrow("projectIdentity must be 32 lower-case hex digits");
  });

  test("renders compose, .env and README around the one image the smoke checks", async () => {
    const target = await generatedDockerProject("compose-image-agent");
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const readme = await readFile(join(target, "README.md"), "utf8");
    const cli = await readFile(join(target, "src", "cli.ts"), "utf8");
    // Both roles inherit the one role anchor: run DACS_IMAGE, never build or pull.
    expect(compose).not.toMatch(/^\s*build:/m);
    expect(compose.match(/^\s*image:.*$/gm)).toEqual([
      "  image: ${DACS_IMAGE:?set DACS_IMAGE}",
    ]);
    expect(compose).toContain("  pull_policy: never\n");
    expect(compose.match(/<<: \*dacs-role/g)).toHaveLength(2);
    expect(compose).toContain(
      'user: "${DACS_RUNTIME_UID:?set DACS_RUNTIME_UID}:${DACS_RUNTIME_GID:?set DACS_RUNTIME_GID}"',
    );
    const image = localImageReferenceOf(environmentExample);
    expect(image).toBe("compose-image-agent:local");
    const steps = [
      "cp .env.example .env",
      `docker build -t ${image} .`,
      "npm run dacs:image:smoke\n",
      "npm run dacs:up\n",
    ].map((step) => readme.indexOf(step));
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect([...steps].sort((left, right) => left - right)).toEqual(steps);
    expect(readme).not.toContain("dacs:image:smoke --");
    expect(readme).not.toContain("my-dacs-agent:local");
    expect(readme).not.toContain("must pass before an installer reports success");
    expect(readme).toContain("the image's configured service command");
    expect(readme).toContain("stop\nat its missing-role check, reporting that check's own reason " +
      "code,\n`service-role-unconfigured`.");
    expect(readme).toContain("with `DACS_IMAGE` set to that image ID rather\nthan the tag");
    expect(readme).toContain("refuse to run while `.env` mentions `COMPOSE_` anywhere");
    expect(readme).toContain("refuse to run while the project has a container\nthat compose created for another directory");
    expect(readme).toContain("the first 12 hex digits of the SHA-256 of this project's identity\n" +
      "followed by the directory's full path");
    expect(readme).toContain("nor does a\nnew project generated at a path this one was moved from");
    expect(readme).toContain("The record also binds this directory's device and inode.");
    expect(readme).toContain("If a reboot or remount changes the\ndevice number, the commands fail closed too");
    expect(readme).toContain("Older inode-only records need the same\nrecovery.");
    expect(readme).toContain("A file-system snapshot,\nclone or rollback restored at the same path with the same device and inode\ncounts as this directory");
    expect(readme).toContain("including in a copy\nwithout `.dacs-runtime/`, they refuse: " +
      "move the project that started the\ncontainers back to run its commands, or remove " +
      "the containers from any\ndirectory with `docker compose --project-name <project> down`");
    expect(readme).not.toContain("from where it is now");
    expect(readme).not.toContain("run them from the project that started");
    expect(readme).toContain("If you moved the project, remove the old\ncontainers with " +
      "`docker compose --project-name <recorded project> down`");
    expect(readme).not.toContain("never share one");
    expect(readme).toContain("Docker CLI and Engine 24 or later with\nCompose 2.10 or later");
    expect(readme).not.toContain("which added");
    expect(readme).toContain(`requires the image to run Node.js ${GENERATED_IMAGE_NODE_VERSION}`);
    // The script's --up, --stop and --down modes are exercised directly below; the
    // CLI only dispatches to them by deployment, after the pre-start doctor for
    // dacs:up, and refuses maintenance when the stop fails.
    expect(cli).not.toContain('command("docker"');
    expect(cli).toContain(
      'command(process.execPath, ["scripts/docker-runtime-smoke.mjs", ...args])',
    );
    // The gate is the doctor's exit code: a block is returned before anything
    // starts, and only missing local stores are initialised and rechecked.
    expect(cli).toContain([
      "async function startGate(): Promise<number> {",
      '  let report = await runGeneratedDoctor("pre-start", "start");',
      "  const localInitializationOnly = report.checks.filter((item) => item.required &&",
      '    item.status !== "pass").every((item) =>',
      '      item.id === "local.data-directory" || item.id === "local.disk-space" ||',
      '      item.id === "local.sqlite");',
      "  if (report.exitCode !== 0 && !localInitializationOnly) {",
      "    printDoctor(report);",
      "    return report.exitCode;",
      "  }",
      "  if (report.exitCode !== 0) {",
      "    await initializeActorStores();",
      '    report = await runGeneratedDoctor("pre-start", "start");',
      "  }",
      "  printDoctor(report);",
      "  return report.exitCode;",
      "}",
    ].join("\n"));
    expect(cli).toContain([
      '  else if (operation === "up") {',
      "    const gate = await startGate();",
      "    if (gate !== 0) { process.exitCode = gate; return; }",
      '    if ((process.env.DACS_DEPLOYMENT ?? "docker") === "local") {',
      "      process.exitCode = await startDacsLocalRoleServices();",
      "      return;",
      "    }",
      "    // Checks the last smoke pass, then starts that image ID as buyer and seller.",
      '    process.exitCode = await dockerRuntime(["--up"]);',
      '  } else if (operation === "down") {',
      '    process.exitCode = (process.env.DACS_DEPLOYMENT ?? "docker") === "local"',
      "      ? await stopDacsLocalRoleServices()",
      '      : await dockerRuntime(["--down"]);',
      '  } else if (operation === "status") {',
    ].join("\n"));
    expect(cli).toContain([
      "async function stopForMaintenance(): Promise<number> {",
      '  return (process.env.DACS_DEPLOYMENT ?? "docker") === "local"',
      "    ? stopDacsLocalRoleServices()",
      '    : dockerRuntime(["--stop"]);',
      "}",
    ].join("\n"));
    // Backup, restore and uninstall each stop first and give up if that fails.
    const stopped = "  if (await stopForMaintenance() !== 0) return 5;\n";
    expect(cli.split(stopped)).toHaveLength(4);
    for (const [operation, effect] of [
      ["backup", "createGeneratedBackupV1({"],
      ["restore", "restoreGeneratedBackupV1({"],
      ["uninstall", "createGeneratedBackupV1({"],
    ] as const) {
      const body = cli.slice(cli.indexOf(`async function ${operation}(`));
      expect(body.indexOf(stopped), operation).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(stopped), operation).toBeLessThan(body.indexOf(effect));
    }
    expect(cli).toContain([
      '  if ((process.env.DACS_DEPLOYMENT ?? "docker") === "docker" &&',
      '      await dockerRuntime(["--down", "--remove-orphans"]) !== 0) return 5;',
    ].join("\n"));

    const local = join(await temporaryDirectory(), "local-image-agent");
    await createDacsAgentProject({
      targetDirectory: local,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "local",
      install: false,
    });
    expect(await readFile(join(local, "README.md"), "utf8")).not.toContain("docker build");
  });

  test("probes the image for every production dependency and payment entry point", async () => {
    for (const [rails, entryPoints] of [
      ["both", [...SDK_ENTRY_POINTS, ...X402_ENTRY_POINTS]],
      ["x402", [...SDK_ENTRY_POINTS, ...X402_ENTRY_POINTS]],
      ["pay-dem", SDK_ENTRY_POINTS],
    ] as const) {
      const target = join(await temporaryDirectory(), `probe-${rails}-agent`);
      await createDacsAgentProject({
        targetDirectory: target,
        mode: "live-demos",
        profile: "dacs-sdk:fixed-price-x402:v1",
        role: "buyer",
        deployment: "docker",
        rails,
        install: false,
      });
      const dependencies = JSON.parse(
        await readFile(join(target, "package.json"), "utf8"),
      ).dependencies as Record<string, string>;
      const smoke = await readFile(join(target, "scripts", "docker-runtime-smoke.mjs"), "utf8");
      const probed = /'const expected = (\{[^']*\});',/.exec(smoke);
      expect(probed, rails).not.toBeNull();
      expect(JSON.parse(probed![1]!), rails).toEqual(dependencies);
      const imported = [...smoke.matchAll(/^ {2}'await import\(("[^"]+")\);',$/gm)]
        .map((match) => JSON.parse(match[1]!) as string);
      expect(imported, rails).toEqual(entryPoints);
      // Opening a database is what loads better-sqlite3's native binding.
      expect(smoke).toContain("'const database = new Database(\":memory:\");',");
      expect(smoke).toContain(
        "'  if (database.prepare(\"SELECT 1 AS one\").get().one !== 1) " +
          "throw new Error(\"better-sqlite3 query failed\");',",
      );
    }
  });

  test("checks the runtime user, directory and command the Dockerfile writes", async () => {
    const target = await generatedDockerProject("image-config-agent");
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    const smoke = await readFile(join(target, "scripts", "docker-runtime-smoke.mjs"), "utf8");
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const user = /^USER (.+)$/m.exec(runtimeStage)![1]!;
    const workingDirectory = /^WORKDIR (.+)$/m.exec(runtimeStage)![1]!;
    const command = JSON.parse(/^CMD (.+)$/m.exec(runtimeStage)![1]!) as string[];
    expect(user).toBe("10001:10001");
    expect(runtimeStage).toContain("--gid 10001 dacs && useradd --system --uid 10001 ");
    expect(command).toEqual(GENERATED_SERVICE_COMMAND);
    expect(smoke).toContain(`if (config.User !== ${JSON.stringify(user)}) {`);
    expect(smoke).toContain(`if (config.WorkingDir !== ${JSON.stringify(workingDirectory)}) {`);
    const checked = /^const expectedCommand = (.+);$/m.exec(smoke);
    expect(JSON.parse(checked![1]!)).toEqual(command);
    // Both stages start from one digest-pinned Node release, which the smoke
    // requires the image to run.
    expect([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1])).toEqual(
      Array(2).fill(`node:${GENERATED_IMAGE_NODE_VERSION}-bookworm-slim` +
        "@sha256:83e53269616ca1b22cf7533e5db4e2f1a0c24a8e818b21691d6d4a69ec9e2c6d"),
    );
    expect(smoke).toContain(
      `if (runtime.node !== ${JSON.stringify(GENERATED_IMAGE_NODE_VERSION)}) {`,
    );
  });

  test.runIf(process.platform !== "win32")(
    "smokes DACS_IMAGE as the compose runtime user and records its one image ID",
    async () => {
      const target = await generatedDockerProject("immutable-image-agent");
      const image = localImageReferenceOf(await readFile(join(target, ".env"), "utf8"));
      const user = `${TEST_ONLY_RUNTIME_UID}:${TEST_ONLY_RUNTIME_GID}`;
      // The tag moves after the first resolution; every later call uses the ID.
      // A permissive umask shows the modes the script itself asks for.
      const result = await runGeneratedDockerSmoke(target, passingDockerScenario({
        imageIds: [TEST_ONLY_FAKE_IMAGE_ID, TEST_ONLY_REPLACEMENT_IMAGE_ID],
      }), { umask: "022" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "pass",
        image,
        imageId: TEST_ONLY_FAKE_IMAGE_ID,
        runtimeUser: user,
        serviceCommand: "stopped-at-role-check",
      });
      // An init process and limits as compose gives each role, and a name to
      // remove it by.
      const containerOptions = [
        "run", "--rm", "--init", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--memory", "512m", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
        "--user", user, "--name", expect.stringMatching(/^dacs-image-smoke-[0-9a-f]{12}$/),
      ];
      expect(result.invocations).toHaveLength(4);
      expect(result.invocations[0]).toEqual([
        "image", "inspect", "--format", "{{.Id}}", image,
      ]);
      expect(result.invocations[1]).toEqual([
        "image", "inspect", "--format", "{{json .Config}}", TEST_ONLY_FAKE_IMAGE_ID,
      ]);
      expect(result.invocations[2]?.slice(0, containerOptions.length + 3)).toEqual([
        ...containerOptions, "--entrypoint", "node", TEST_ONLY_FAKE_IMAGE_ID,
      ]);
      // The image's own configured command: no entrypoint or command override.
      expect(result.invocations[3]).toEqual([...containerOptions, TEST_ONLY_FAKE_IMAGE_ID]);
      const nameOf = (args: string[] | undefined) => args?.[args.indexOf("--name") + 1];
      expect(nameOf(result.invocations[2])).not.toBe(nameOf(result.invocations[3]));
      expect(result.receipt).toEqual({
        receiptVersion: 1,
        image,
        imageId: TEST_ONLY_FAKE_IMAGE_ID,
        user,
        command: GENERATED_SERVICE_COMMAND,
        composeHash: createHash("sha256").update(await readFile(join(target, "compose.yaml"), "utf8")).digest("hex"),
        imageEnvironment: passingDockerScenario().config.Env,
      });
      // Only the project's owner can read the record or its directory.
      const receiptDirectory = join(target, ".dacs-runtime");
      expect((await lstat(receiptDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(receiptDirectory, "docker-image-smoke.json"))).mode & 0o777)
        .toBe(0o600);

      // The probe ran as that user on the pinned Node release and found every
      // production dependency at its pinned version.
      const { dependencies } = JSON.parse(
        await readFile(join(target, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(JSON.parse(result.stdout).runtime).toEqual({
        status: "pass",
        node: GENERATED_IMAGE_NODE_VERSION,
        uid: TEST_ONLY_RUNTIME_UID,
        gid: TEST_ONLY_RUNTIME_GID,
        versions: dependencies,
      });

      // Compose prefers the shell environment over .env; so does the smoke.
      const shell = await runGeneratedDockerSmoke(target, passingDockerScenario(), {
        env: { DACS_RUNTIME_UID: "5151", DACS_RUNTIME_GID: "5252" },
      });
      expect(shell.status).toBe(0);
      expect(shell.invocations[3]).toContain("5151:5252");
      expect(shell.receipt).toMatchObject({ user: "5151:5252" });
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "lets dacs:up start compose only for the image ID and user that last passed the smoke",
    async () => {
      const target = await generatedDockerProject("verified-image-agent");
      const up = { args: ["--up"] };
      const unsmoked = await runGeneratedDockerSmoke(target, passingDockerScenario(), up);
      expect(unsmoked.status).toBe(5);
      expect(unsmoked.stderr).toContain("last passed dacs:image:smoke");
      expect(unsmoked.invocations.filter(isComposeInvocation)).toEqual([]);

      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      // A permissive umask, so that only the script's own mode keeps the record private.
      const started = await runGeneratedDockerSmoke(target, passingDockerScenario(), {
        ...up,
        umask: "022",
      });
      expect(started.stderr).toBe("");
      expect(started.status).toBe(0);
      const projectName = await generatedProjectName(target);
      expect(projectName).toMatch(/^verified-image-agent-[0-9a-f]{12}$/);
      expect(JSON.parse(started.stdout)).toMatchObject({
        status: "started",
        imageId: TEST_ONLY_FAKE_IMAGE_ID,
        project: projectName,
        services: ["buyer", "seller"],
      });
      // The project it started is recorded in the project, owner-only, with the
      // directory that started it.
      const recordPath = join(target, ".dacs-runtime", "compose-project.json");
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
        recordVersion: 1,
        project: projectName,
        directory: await realpath(target),
        ...await directoryInode(target),
      });
      expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);
      expect(started.invocations.filter(isComposeInvocation)).toEqual([[
        ...await generatedComposeArguments(target),
        "up", "--detach", "--no-build", "--pull", "never", "buyer", "seller",
      ]]);
      // Compose's version and the project's owner are checked just before.
      expect(started.invocations.slice(1, 4)).toEqual([
        ...await composeChecks(target),
        started.invocations.filter(isComposeInvocation)[0],
      ]);
      expect(started.composeEnvironments).toEqual([{
        subcommand: "up",
        DACS_IMAGE: TEST_ONLY_FAKE_IMAGE_ID,
        DACS_RUNTIME_UID: String(TEST_ONLY_RUNTIME_UID),
        DACS_RUNTIME_GID: String(TEST_ONLY_RUNTIME_GID),
        COMPOSE_PROJECT_NAME: projectName,
        composeVariables: ["COMPOSE_PROJECT_NAME"],
      }]);

      // A record of another version is not a pass this script understands.
      const receiptPath = join(target, ".dacs-runtime", "docker-image-smoke.json");
      const recorded = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      await writeFile(receiptPath, JSON.stringify({ ...recorded, receiptVersion: 2 }), "utf8");
      const versioned = await runGeneratedDockerSmoke(target, passingDockerScenario(), up);
      expect(versioned.status).toBe(5);
      expect(versioned.invocations.filter(isComposeInvocation)).toEqual([]);
      await writeFile(receiptPath, JSON.stringify(recorded), "utf8");

      // A non-zero check never reaches compose.
      for (const [scenario, env] of [
        [passingDockerScenario({ imageIds: [TEST_ONLY_REPLACEMENT_IMAGE_ID] }), {}],
        [passingDockerScenario(), { DACS_RUNTIME_UID: "5151" }],
        [passingDockerScenario(), { DACS_IMAGE: "another-agent:local" }],
      ] as const) {
        const refused = await runGeneratedDockerSmoke(target, scenario, { ...up, env });
        expect(refused.status).toBe(5);
        expect(refused.stderr).toContain("rerun npm run dacs:image:smoke");
        expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
      }

      // A failed smoke withdraws the earlier pass before checking anything.
      const failed = await runGeneratedDockerSmoke(target, passingDockerScenario({
        service: { status: 0, stderr: "" },
      }));
      expect(failed.status).not.toBe(0);
      expect(failed.receipt).toBeUndefined();
      const withdrawn = await runGeneratedDockerSmoke(target, passingDockerScenario(), up);
      expect(withdrawn.status).toBe(5);
      expect(withdrawn.invocations.filter(isComposeInvocation)).toEqual([]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:up starts the smoked image ID even when the tag moves after the check",
    async () => {
      const target = await generatedDockerProject("moved-tag-agent");
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      // The check resolves the tag to the smoked ID; every later resolution of
      // the tag, including compose creating a container from it, gives another.
      const moved = await runGeneratedDockerSmoke(target, passingDockerScenario({
        imageIds: [TEST_ONLY_FAKE_IMAGE_ID, TEST_ONLY_REPLACEMENT_IMAGE_ID],
      }), { args: ["--up"] });
      expect(moved.stderr).toBe("");
      expect(moved.status).toBe(0);
      expect(moved.composeEnvironments[0]?.DACS_IMAGE).toBe(TEST_ONLY_FAKE_IMAGE_ID);
      expect(moved.containers?.map(({ service, Image }) => [service, Image])).toEqual([
        ["buyer", TEST_ONLY_FAKE_IMAGE_ID],
        ["seller", TEST_ONLY_FAKE_IMAGE_ID],
      ]);

      // npm run dacs:up loads .env into the CLI, so the script inherits the tag
      // and runtime user; compose must still get the smoked image ID.
      const image = localImageReferenceOf(await readFile(join(target, ".env"), "utf8"));
      const inherited = await runGeneratedDockerSmoke(target, passingDockerScenario({
        imageIds: [TEST_ONLY_FAKE_IMAGE_ID, TEST_ONLY_REPLACEMENT_IMAGE_ID],
      }), {
        args: ["--up"],
        env: {
          DACS_IMAGE: image,
          DACS_RUNTIME_UID: String(TEST_ONLY_RUNTIME_UID),
          DACS_RUNTIME_GID: String(TEST_ONLY_RUNTIME_GID),
        },
      });
      expect(inherited.stderr).toBe("");
      expect(inherited.status).toBe(0);
      expect(inherited.composeEnvironments[0]?.DACS_IMAGE).toBe(TEST_ONLY_FAKE_IMAGE_ID);
      expect(inherited.containers?.map(({ Image }) => Image)).toEqual([
        TEST_ONLY_FAKE_IMAGE_ID,
        TEST_ONLY_FAKE_IMAGE_ID,
      ]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:up ignores COMPOSE_FILE, COMPOSE_PROJECT_NAME and compose override files",
    async () => {
      const target = await generatedDockerProject("override-agent");
      const realTarget = await realpath(target);
      const projectName = await generatedProjectName(target);
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      // Each file replaces the buyer's image with an unsmoked tag and adds a service.
      const override = [
        "services:",
        "  buyer:",
        "    image: unsmoked-agent:latest",
        "  extra:",
        "    image: unsmoked-agent:latest",
        "",
      ].join("\n");
      await writeFile(join(target, "compose.override.yaml"), override, "utf8");
      await writeFile(join(target, "extra.yaml"), override, "utf8");
      const scenario = passingDockerScenario({
        imageIds: [TEST_ONLY_FAKE_IMAGE_ID, TEST_ONLY_REPLACEMENT_IMAGE_ID],
      });
      const environments: Record<string, string>[] = [
        {},
        { COMPOSE_FILE: "compose.yaml:extra.yaml" },
        { COMPOSE_PROJECT_NAME: "another-project", COMPOSE_PROFILES: "extra" },
      ];
      for (const env of environments) {
        const started = await runGeneratedDockerSmoke(target, scenario, { args: ["--up"], env });
        expect(started.stderr, JSON.stringify(env)).toBe("");
        expect(started.status).toBe(0);
        expect(started.composeEnvironments[0]).toMatchObject({
          COMPOSE_PROJECT_NAME: projectName,
          composeVariables: ["COMPOSE_PROJECT_NAME"],
        });
        expect(started.containers).toEqual([
          ["buyer", TEST_ONLY_FAKE_IMAGE_ID],
          ["seller", TEST_ONLY_FAKE_IMAGE_ID],
        ].map(([service, Image]) => ({
          Id: `container-${projectName}-${service}`,
          Image,
          project: projectName,
          service,
          running: true,
          workingDir: realTarget,
        })));
      }

      // Compose imports COMPOSE_* variables from .env itself, and falls back to
      // COMPOSE_PROJECT_NAME when the file does not load; such a .env is refused.
      // Compose's .env grammar also starts a statement after any Unicode space,
      // takes any whitespace after export and reads on after a quoted value, so
      // any mention of COMPOSE_ is refused.
      const environment = await readFile(join(target, ".env"), "utf8");
      for (const line of [
        "COMPOSE_PROJECT_NAME=another-project",
        "export COMPOSE_PROFILES=extra",
        "  COMPOSE_FILE=extra.yaml",
        "\fCOMPOSE_PROFILES=extra",
        "\u00a0COMPOSE_PROFILES=extra",
        "export\fCOMPOSE_PROFILES=extra",
        'DACS_X402_TOKEN_NAME="USDC" COMPOSE_PROFILES=extra',
        "# COMPOSE_PROFILES=extra",
      ]) {
        await writeFile(join(target, ".env"), `${environment}${line}\n`, "utf8");
        for (const args of [[], ["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
          const refused = await runGeneratedDockerSmoke(target, scenario, { args });
          expect(refused.status, `${line} ${args.join(" ")}`).toBe(2);
          expect(refused.stderr).toContain(
            "remove every COMPOSE_* variable, and any other mention of COMPOSE_, from .env",
          );
          expect(refused.invocations).toEqual([]);
        }
      }
      await writeFile(join(target, ".env"), environment, "utf8");
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32").each(["buyer", "seller"])(
    "dacs:up checks %s init, resource limits, restart, logging and health policy",
    async (role) => {
      const target = await generatedDockerProject(`bounded-${role}-agent`);
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const up = { args: ["--up"] };
      const model = parseYaml(await readFile(join(target, "compose.yaml"), "utf8"), { merge: true });
      const health = { Test: model.services[role].healthcheck.test,
        Interval: 10_000_000_000, Timeout: 3_000_000_000, Retries: 3, StartPeriod: 10_000_000_000 };
      const refused = [
        ...[
          { Init: false }, { PidsLimit: 0 }, { Memory: 0 },
          { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
          { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 1 } },
          { LogConfig: { Type: "none", Config: {} } },
          { LogConfig: { Type: "json-file", Config: { "max-size": "10m" } } },
          { LogConfig: { Type: "json-file", Config: { "max-size": "100m", "max-file": "3" } } },
          { LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "30" } } },
        ].map((HostConfig) => ({ HostConfig })),
        ...[
          null, { Test: ["NONE"] }, { Interval: 0 }, { Timeout: 0 },
          { Retries: 0 }, { StartPeriod: 0 }, { StartInterval: 1_000_000_000 },
        ].map((change) => ({ Config: { Healthcheck: change === null ? null : {
          ...health, ...change,
        } } })),
      ];
      for (const inspection of refused) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario({
          inspectChanges: { [role]: inspection },
        }), up);
        expect(result.status, JSON.stringify(inspection)).toBe(5);
        expect(result.stderr).toContain(`${role} container resource, restart, logging or health settings differ`);
        expect(result.containers?.every((container) => !container.running)).toBe(true);
      }
      // Docker 24 omits StartInterval; newer engines can return the zero default.
      // Object property order does not alter the effective logging policy.
      const valid = await runGeneratedDockerSmoke(target, passingDockerScenario({
        inspectChanges: { [role]: {
          Config: { Healthcheck: {
            ...health, StartInterval: 0,
          } },
          HostConfig: { LogConfig: { Type: "json-file", Config: { "max-file": "3", "max-size": "10m" } } },
        } },
      }), up);
      expect(valid.stderr).toBe("");
      expect(valid.status).toBe(0);
      // Docker merges daemon defaults into json-file options. Compression
      // preserves the required rotation bounds and must not stop either role.
      for (const compress of ["true", "false"]) {
        const inherited = await runGeneratedDockerSmoke(target, passingDockerScenario({
          inspectChanges: { [role]: { HostConfig: { LogConfig: {
            Type: "json-file", Config: { "max-size": "10m", "max-file": "3", compress },
          } } } },
        }), up);
        expect(inherited.stderr, compress).toBe("");
        expect(inherited.status, compress).toBe(0);
        expect(inherited.containers?.filter((container) => container.running)).toHaveLength(2);
      }
    },
    // Each role runs smoke plus nineteen policy vectors through child processes.
    SPAWNING_TEST_TIMEOUT_MS * 3,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:up refuses running buyer and seller one-offs before start and after a racing start",
    async () => {
      const target = await generatedDockerProject("oneoff-start-agent");
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const up = { args: ["--up"] };
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario(), up)).status).toBe(0);
      const projectName = await generatedProjectName(target);
      for (const service of ["buyer", "seller"]) {
        const oneOff: FakeContainer = {
          Id: `container-${projectName}-${service}-run`, Image: TEST_ONLY_FAKE_IMAGE_ID,
          project: projectName, service, running: true, oneoff: true,
          workingDir: await realpath(target),
        };
        const message = `${service} compose run container is still running; stop it before retrying dacs:up`;
        const refused = await runGeneratedDockerSmoke(target, passingDockerScenario({ containers: [oneOff] }), up);
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain(message);
        expect(refused.invocations.some((args) => isComposeInvocation(args) && args.includes("up"))).toBe(false);
        expect(refused.containers).toBeUndefined(); // No container state was changed.

        const raced = await runGeneratedDockerSmoke(target, passingDockerScenario({ composeUpAdds: [oneOff] }), up);
        expect(raced.status, raced.stderr).toBe(1);
        expect(raced.stderr).toContain(message);
        // Compose stop cannot stop the one-off; report that it needs attention.
        expect(raced.stderr).toContain(`${service} is still running`);
        expect(raced.containers?.find((container) => container.Id === oneOff.Id)?.running).toBe(true);
        expect(raced.containers?.filter((container) => !container.oneoff).every((container) => !container.running)).toBe(true);

        const retried = await runGeneratedDockerSmoke(target, passingDockerScenario({
          containers: [{ ...oneOff, running: false }],
        }), up);
        expect(retried.status).toBe(0);
        expect(retried.stderr).toBe("");
      }
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:up stops both roles unless compose created them from the smoked image ID",
    async () => {
      const target = await generatedDockerProject("checked-start-agent");
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const up = { args: ["--up"] };
      const stop = [...await generatedComposeArguments(target), "stop", "buyer", "seller"];
      const projectName = await generatedProjectName(target);
      const strayContainer: FakeContainer = {
        Id: `container-${projectName}-extra`,
        Image: TEST_ONLY_REPLACEMENT_IMAGE_ID,
        project: projectName,
        service: "extra",
        running: true,
        workingDir: await realpath(target),
      };
      const refused: [Partial<FakeDockerScenario>, string][] = [
        [{ inspectChanges: { seller: { Mounts: [] } } }, "seller container mounts differ"],
        [{ inspectChanges: { seller: { Config: { User: "0:0", Env: [] } } } }, "seller container environment"],
        ...[
          { Privileged: true }, { ReadonlyRootfs: false }, { NetworkMode: "bridge" },
          { CapDrop: [] }, { CapAdd: ["SYS_ADMIN"] }, { SecurityOpt: [] },
          { PidMode: "host" }, { Devices: [{ PathOnHost: "/dev/test" }] },
          { Tmpfs: { "/tmp": "rw,exec" } },
        ].map((HostConfig) => [{ inspectChanges: { seller: { HostConfig } } },
          "seller container security"] as [Partial<FakeDockerScenario>, string]),
        [{ composeCreatesImage: TEST_ONLY_REPLACEMENT_IMAGE_ID },
          `the buyer container runs ${TEST_ONLY_REPLACEMENT_IMAGE_ID}`],
        [{ composeSkips: ["seller"] }, "compose created 0 seller containers"],
        [{ containers: [strayContainer] },
          `service extra is also running in compose project ${projectName}`],
      ];
      for (const [overrides, message] of refused) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(overrides), up);
        expect(result.status, message).toBe(5);
        expect(result.stderr).toContain(`dacs:up stopped buyer and seller: ${message}`);
        expect(result.stdout).toBe("");
        expect(result.invocations.filter(isComposeInvocation).at(-1)).toEqual(stop);
        expect(result.containers?.filter((container) => container.service !== "extra")
          .every((container) => !container.running)).toBe(true);
      }
      // An earlier, stopped container of another service does not block a start.
      const stopped = await runGeneratedDockerSmoke(target, passingDockerScenario({
        containers: [{ ...strayContainer, running: false }],
      }), up);
      expect(stopped.status).toBe(0);
      // A failed or partial start, or a check that cannot complete, also stops
      // both roles and confirms that neither still runs. The first ps is the
      // check before compose up.
      const failedStarts: [Partial<FakeDockerScenario>, number, string][] = [
        [{ composeUpStatus: 17 }, 17, "compose up exited 17"],
        [{ composeUpStatus: 17, composeUpCreates: ["buyer"] }, 17, "compose up exited 17"],
        [{ failsCalls: { ps: [2] } }, 1,
          "could not check the started containers: docker ps failed: test-only ps failure"],
        [{ failsCalls: { container: [1] } }, 1, "could not check the started containers: " +
          "docker container failed: test-only container failure"],
        [{ inspectOutput: "{}" }, 1,
          "could not check the started containers: docker container inspect returned no list"],
      ];
      for (const [overrides, status, message] of failedStarts) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(overrides), up);
        expect(result.status, message).toBe(status);
        expect(result.stderr).toContain(`dacs:up stopped buyer and seller: ${message}`);
        expect(result.stdout).toBe("");
        expect(result.invocations.filter(isComposeInvocation).at(-1)).toEqual(stop);
        expect(result.containers?.every((container) => !container.running), message).toBe(true);
      }
      // A stop that fails, or leaves a role running, is reported as such.
      const failedStops: [Partial<FakeDockerScenario>, string][] = [
        [{ composeCreatesImage: TEST_ONLY_REPLACEMENT_IMAGE_ID, fails: ["compose stop"] },
          "compose stop exited 1"],
        [{ composeCreatesImage: TEST_ONLY_REPLACEMENT_IMAGE_ID, stopLeavesRunning: true },
          "buyer is still running"],
        // The ownership check before the stop, then the check after it.
        [{ failsCalls: { ps: [2, 3] } }, "docker ps failed: test-only ps failure"],
        [{ failsCalls: { ps: [2, 4] } }, "docker ps failed: test-only ps failure"],
      ];
      for (const [overrides, message] of failedStops) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(overrides), up);
        expect(result.status, message).toBe(1);
        expect(result.stderr).toContain(
          `and could not stop buyer and seller or confirm that they stopped: ${message}`,
        );
        expect(result.stderr).not.toContain("dacs:up stopped");
        expect(result.stdout).toBe("");
      }

      // A buyer that compose created for another directory while this start ran
      // is not stopped, and nor is anything else: compose stops by project.
      const elsewhere = join(await temporaryDirectory(), "agent");
      const late: FakeContainer = {
        Id: "container-late-buyer",
        Image: TEST_ONLY_FAKE_IMAGE_ID,
        project: projectName,
        service: "buyer",
        running: true,
        workingDir: elsewhere,
      };
      const raced = await runGeneratedDockerSmoke(target, passingDockerScenario({
        composeUpAdds: [late],
      }), up);
      expect(raced.status).toBe(1);
      expect(raced.stderr).toContain("dacs:up failed (compose created 2 buyer containers) and " +
        "could not stop buyer and seller or confirm that they stopped: compose project " +
        `${projectName} has containers from ${elsewhere}, not from ${await realpath(target)}, ` +
        "so none was stopped");
      expect(raced.invocations.filter(isComposeInvocation).map((args) => args[7]))
        .toEqual(["up"]);
      expect(raced.containers?.find(({ Id }) => Id === late.Id)?.running).toBe(true);
    },
    // Each independent container-policy vector starts and checks real Node children.
    SPAWNING_TEST_TIMEOUT_MS * 2,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:down and maintenance stops use the same compose file and project",
    async () => {
      const target = await generatedDockerProject("lifecycle-agent");
      const prefix = await generatedComposeArguments(target);
      const checks = await composeChecks(target);
      const env = { COMPOSE_FILE: "extra.yaml", COMPOSE_PROJECT_NAME: "another-project" };
      const modes: [string[], string[]][] = [
        [["--stop"], ["stop"]],
        [["--down"], ["down"]],
        [["--down", "--remove-orphans"], ["down", "--remove-orphans"]],
      ];
      for (const [args, compose] of modes) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(), {
          args,
          env,
        });
        expect(result.status, args.join(" ")).toBe(0);
        expect(result.invocations).toEqual([...checks, [...prefix, ...compose],
          ...(args[0] === "--stop" ? [checks[1]] : [])]);
        expect(result.composeEnvironments[0]).toMatchObject({
          COMPOSE_PROJECT_NAME: await generatedProjectName(target),
          composeVariables: ["COMPOSE_PROJECT_NAME"],
        });
        // A compose that fails, or is killed by a signal, fails the command.
        for (const scenario of [
          passingDockerScenario({ fails: [`compose ${compose[0]}`] }),
          passingDockerScenario({ composeKilled: true }),
        ]) {
          const failed = await runGeneratedDockerSmoke(target, scenario, { args, env });
          expect(failed.status, `${args.join(" ")} ${JSON.stringify(scenario.fails)}`).toBe(1);
          expect(failed.invocations).toEqual([...checks, [...prefix, ...compose]]);
        }
      }
      const failed = await runGeneratedDockerSmoke(target, passingDockerScenario({
        daemonDown: true,
      }), { args: ["--down"] });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        `could not check compose and project ${await generatedProjectName(target)}: ` +
          "docker compose failed: Cannot connect to the test-only Docker daemon",
      );
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "runs no compose command on another directory's project or with Compose before v2.10",
    async () => {
      // Two projects whose directories share a name get separate compose projects.
      const production = await generatedDockerProject("agent");
      const staging = await generatedDockerProject("agent");
      expect(basename(dirname(production))).not.toBe(basename(dirname(staging)));
      const productionProject = await generatedProjectName(production);
      const stagingProject = await generatedProjectName(staging);
      expect(productionProject).toMatch(/^agent-[0-9a-f]{12}$/);
      expect(stagingProject).toMatch(/^agent-[0-9a-f]{12}$/);
      expect(stagingProject).not.toBe(productionProject);
      for (const target of [production, staging]) {
        expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      }
      const started = await runGeneratedDockerSmoke(production, passingDockerScenario(), {
        args: ["--up"],
      });
      expect(started.status).toBe(0);
      const productionContainers = started.containers!;
      expect(productionContainers.map(({ project, workingDir }) => [project, workingDir]))
        .toEqual(Array(2).fill([productionProject, await realpath(production)]));
      const lifecycle = [["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]];
      // Staging's commands, including a start that fails while production's
      // roles run, act only on staging's project: a precheck that sees nothing
      // of production's is no longer a race that lets staging stop production.
      const stagingRuns: [string[], Partial<FakeDockerScenario>][] = [
        ...lifecycle.map((args): [string[], Partial<FakeDockerScenario>] => [args, {}]),
        [["--up"], { composeUpStatus: 17, composeUpCreates: ["buyer"] }],
      ];
      for (const [args, overrides] of stagingRuns) {
        const result = await runGeneratedDockerSmoke(staging, passingDockerScenario({
          containers: productionContainers,
          ...overrides,
        }), { args });
        const label = `${args.join(" ")} ${JSON.stringify(overrides)}`;
        expect(result.status, label).toBe("composeUpStatus" in overrides ? 17 : 0);
        expect(result.invocations.filter(isComposeInvocation).every((invocation) =>
          invocation[6] === stagingProject), label).toBe(true);
        // Production's own roles are untouched.
        expect(result.containers?.filter(({ project }) => project === productionProject) ??
          productionContainers, label).toEqual(productionContainers);
      }
      // Containers that compose created for another directory, or without
      // compose's directory label, are no proof of ownership.
      for (const [containers, from] of [
        [productionContainers.map((container) => ({
          ...container,
          workingDir: staging,
        })), staging],
        [productionContainers.map(({ workingDir: _directory, ...container }) => container),
          "an unknown directory"],
      ] as const) {
        for (const args of lifecycle) {
          const refused = await runGeneratedDockerSmoke(production, passingDockerScenario({
            containers: [...containers],
          }), { args });
          expect(refused.status, `${from} ${args.join(" ")}`).toBe(2);
          expect(refused.stderr).toContain(
            `compose project ${productionProject} has containers from ${from}, not from ` +
              `${await realpath(production)}; this project's commands act only on containers ` +
              "compose created for this directory",
          );
          expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
        }
      }

      // Compose before v2.10, or a version it cannot read, is refused.
      for (const composeVersion of ["2.9.0", "v2.9.9", "1.29.2", "dev", "2.10"]) {
        for (const args of lifecycle) {
          const refused = await runGeneratedDockerSmoke(production, passingDockerScenario({
            composeVersion,
          }), { args });
          expect(refused.status, `${composeVersion} ${args.join(" ")}`).toBe(2);
          expect(refused.stderr).toContain(
            "this project needs the Docker Compose plugin v2.10 or later",
          );
          expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
        }
      }
      for (const composeVersion of ["2.10.0", "v2.10.2", "2.40.3-desktop.1", "2.41.0", "3.0.0", "v5.6.0"]) {
        for (const args of lifecycle) {
          const accepted = await runGeneratedDockerSmoke(production, passingDockerScenario({
            composeVersion,
          }), { args });
          expect(accepted.status, `${composeVersion} ${args.join(" ")}`).toBe(0);
          expect(accepted.invocations.filter(isComposeInvocation)).toHaveLength(1);
        }
      }
      // A check that cannot complete runs no compose command either.
      for (const overrides of [
        { fails: ["compose version"] },
        { fails: ["ps"] },
        { containers: productionContainers, fails: ["container"] },
      ]) {
        const failed = await runGeneratedDockerSmoke(production, passingDockerScenario(
          overrides,
        ), { args: ["--stop"] });
        expect(failed.status, JSON.stringify(overrides)).toBe(1);
        expect(failed.stderr).toContain(`could not check compose and project ${productionProject}: `);
        expect(failed.invocations.filter(isComposeInvocation)).toEqual([]);
      }
    },
    SPAWNING_TEST_TIMEOUT_MS * 4,
  );

  test.runIf(process.platform !== "win32")(
    "after a move, runs no compose command until the project started from the old directory is gone",
    async () => {
      const original = await generatedDockerProject("agent");
      const originalPath = await realpath(original);
      const originalProject = await generatedProjectName(original);
      expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status).toBe(0);
      const started = await runGeneratedDockerSmoke(original, passingDockerScenario(), {
        args: ["--up"],
      });
      expect(started.status).toBe(0);
      const running = started.containers!;

      // The directory moves while its roles run, or after a maintenance stop.
      const moved = join(await temporaryDirectory(), "agent");
      await rename(original, moved);
      const movedProject = await generatedProjectName(moved);
      expect(movedProject).not.toBe(originalProject);
      const refusal = `dacs:up last started this project's roles from ${originalPath} as ` +
        `compose project ${originalProject}, which still has containers. If this directory ` +
        `was moved from there, remove them with: docker compose --project-name ` +
        `${originalProject} down, then rerun. If ${originalPath} is another project that is ` +
        "still in use (this directory is a copy of it), delete " +
        ".dacs-runtime/compose-project.json here instead";
      const stopped = (container: FakeContainer) => ({ ...container, running: false });
      // Both roles, running or stopped, or just one of them left.
      for (const containers of [
        running,
        running.map(stopped),
        [running[0]!],
        [stopped(running[1]!)],
      ]) {
        for (const args of [["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
          const refused = await runGeneratedDockerSmoke(moved, passingDockerScenario({
            containers,
          }), { args });
          expect(refused.status, args.join(" ")).toBe(2);
          expect(refused.stderr).toContain(refusal);
          expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
          expect(refused.invocations).toContainEqual([
            "ps", "--all", "--quiet", "--no-trunc",
            "--filter", `label=com.docker.compose.project=${originalProject}`,
          ]);
          expect(refused.containers ?? containers).toEqual(containers);
        }
      }
      // A rename to a name no other project uses is refused just the same.
      const renamed = join(dirname(moved), "agent2");
      await rename(moved, renamed);
      const again = await runGeneratedDockerSmoke(renamed, passingDockerScenario({
        containers: running,
      }), { args: ["--up"] });
      expect(again.status).toBe(2);
      expect(again.stderr).toContain(refusal);
      expect(again.invocations.filter(isComposeInvocation)).toEqual([]);
      await rename(renamed, moved);

      // Once docker compose --project-name <old> down removed them, the moved
      // project starts as its own project and records it.
      const restarted = await runGeneratedDockerSmoke(moved, passingDockerScenario({
        containers: [],
      }), { args: ["--up"] });
      expect(restarted.stderr).toBe("");
      expect(restarted.status).toBe(0);
      expect(JSON.parse(restarted.stdout)).toMatchObject({ project: movedProject });
      expect(restarted.containers?.map(({ project }) => project))
        .toEqual([movedProject, movedProject]);
      const recordPath = join(moved, ".dacs-runtime", "compose-project.json");
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
        recordVersion: 1,
        project: movedProject,
        directory: await realpath(moved),
        ...await directoryInode(moved),
      });

      // A copy whose original still runs proceeds once its copied record is gone,
      // and never touches the original's containers.
      const copiedRecord = {
        recordVersion: 1,
        project: originalProject,
        directory: originalPath,
        ...await directoryInode(moved),
      };
      await writeFile(recordPath, JSON.stringify(copiedRecord), "utf8");
      expect((await runGeneratedDockerSmoke(moved, passingDockerScenario({
        containers: running,
      }), { args: ["--down"] })).status).toBe(2);
      await rm(recordPath);
      const copied = await runGeneratedDockerSmoke(moved, passingDockerScenario({
        containers: running,
      }), { args: ["--down"] });
      expect(copied.status).toBe(0);
      expect(copied.containers).toEqual(running);

      // A record this script cannot read stops every compose command.
      for (const [source, message] of [
        ["{", ".dacs-runtime/compose-project.json is unreadable: "],
        ...[
          { recordVersion: 2 },
          { project: "Agent X" },
          { directory: 1 },
          { inode: undefined },
          { inode: 1 },
          { inode: "" },
          { inode: "1a" },
          { device: 1 },
          { device: "" },
          { device: "1a" },
        ].map((change) => [JSON.stringify({ ...copiedRecord, ...change }),
          ".dacs-runtime/compose-project.json is not a compose project record"]),
      ]) {
        await writeFile(recordPath, source!, "utf8");
        const failed = await runGeneratedDockerSmoke(moved, passingDockerScenario(), {
          args: ["--stop"],
        });
        expect(failed.status, source).toBe(1);
        expect(failed.stderr).toContain(`could not check compose and project ${movedProject}: ` +
          message);
        expect(failed.invocations.filter(isComposeInvocation)).toEqual([]);
      }
    },
    SPAWNING_TEST_TIMEOUT_MS * 4,
  );

  test.runIf(process.platform !== "win32")(
    "records the project before compose starts, so a failed start's left role blocks a moved directory",
    async () => {
      const original = await generatedDockerProject("agent");
      const originalProject = await generatedProjectName(original);
      expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status).toBe(0);
      // Compose creates the buyer, fails, and the buyer cannot then be stopped.
      const failed = await runGeneratedDockerSmoke(original, passingDockerScenario({
        composeUpStatus: 17,
        composeUpCreates: ["buyer"],
        fails: ["compose stop"],
      }), { args: ["--up"] });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("stop them before anything else");
      expect(failed.containers?.map(({ service, running }) => [service, running]))
        .toEqual([["buyer", true]]);
      expect(JSON.parse(await readFile(
        join(original, ".dacs-runtime", "compose-project.json"), "utf8",
      ))).toEqual({
        recordVersion: 1,
        project: originalProject,
        directory: await realpath(original),
        ...await directoryInode(original),
      });

      const moved = join(await temporaryDirectory(), "agent");
      await rename(original, moved);
      const refused = await runGeneratedDockerSmoke(moved, passingDockerScenario({
        containers: failed.containers,
      }), { args: ["--up"] });
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain(`as compose project ${originalProject}, which still has ` +
        "containers");
      expect(refused.invocations.filter(isComposeInvocation)).toEqual([]);
      expect(refused.containers ?? failed.containers).toEqual(failed.containers);
    },
    SPAWNING_TEST_TIMEOUT_MS * 2,
  );

  test.runIf(process.platform !== "win32")(
    "gives a project generated where a moved one used to be its own project",
    async () => {
      const original = await generatedDockerProject("agent");
      const originalPath = await realpath(original);
      const originalProject = await generatedProjectName(original);
      expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status).toBe(0);
      const started = await runGeneratedDockerSmoke(original, passingDockerScenario(), {
        args: ["--up"],
      });
      expect(started.status).toBe(0);
      const running = started.containers!;

      // The project moves while its roles run, and a new one is generated in its place.
      const moved = join(await temporaryDirectory(), "agent");
      await rename(original, moved);
      await createDacsAgentProject({
        targetDirectory: original,
        mode: "live-demos",
        profile: "dacs-sdk:fixed-price-x402:v1",
        role: "buyer",
        deployment: "docker",
        rails: "both",
        install: false,
      });
      await writeFile(join(original, ".env"), await readFile(join(moved, ".env")));
      expect(await realpath(original)).toBe(originalPath);
      expect(await generatedProjectIdentity(original))
        .not.toBe(await generatedProjectIdentity(moved));
      const newProject = await generatedProjectName(original);
      expect(newProject).toMatch(/^agent-[0-9a-f]{12}$/);
      expect(newProject).not.toBe(originalProject);

      // Its maintenance commands name only its own, empty project.
      for (const args of [["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
        const result = await runGeneratedDockerSmoke(original, passingDockerScenario({
          containers: running,
        }), { args });
        expect(result.status, args.join(" ")).toBe(0);
        expect(result.containers, args.join(" ")).toEqual(running);
        expect(result.invocations.filter(isComposeInvocation)).toEqual([[
          ...await generatedComposeArguments(original),
          ...(args[0] === "--stop" ? ["stop"] : ["down", ...args.slice(1)]),
        ]]);
      }

      // Its dacs:up starts its own pair and leaves the moved project's roles running.
      expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status).toBe(0);
      const own = await runGeneratedDockerSmoke(original, passingDockerScenario({
        containers: running,
      }), { args: ["--up"] });
      expect(own.stderr).toBe("");
      expect(own.status).toBe(0);
      expect(JSON.parse(own.stdout)).toMatchObject({ project: newProject });
      expect(own.containers?.slice(0, 2)).toEqual(running);
      expect(own.containers?.slice(2).map(({ project }) => project))
        .toEqual([newProject, newProject]);
    },
    SPAWNING_TEST_TIMEOUT_MS * 2,
  );

  test.runIf(process.platform !== "win32")(
    "runs no compose command from a copy put where a running project was moved from",
    async () => {
      const original = await generatedDockerProject("agent");
      const originalPath = await realpath(original);
      const project = await generatedProjectName(original);
      expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status).toBe(0);
      const started = await runGeneratedDockerSmoke(original, passingDockerScenario(), {
        args: ["--up"],
      });
      expect(started.status).toBe(0);
      const running = started.containers!;
      const stopped = running.map((container) => ({ ...container, running: false }));
      // The directory that started them stops them.
      const own = await runGeneratedDockerSmoke(original, passingDockerScenario({
        containers: running,
      }), { args: ["--stop"] });
      expect(own.status).toBe(0);
      expect(own.containers).toEqual(stopped);

      // The project moves while its roles run, and a copy of it, with or
      // without its .dacs-runtime/ records, is put back where it was.
      const moved = join(await temporaryDirectory(), "agent");
      await rename(original, moved);
      const refusal = `compose project ${project} has containers, but ` +
        ".dacs-runtime/compose-project.json does not show that dacs:up started them from " +
        `this directory: it may be a copy of a project that was moved from ${originalPath} ` +
        "while its roles ran, or its device changed after a remount. " +
        "Move this directory aside and that project back here to run its commands, or remove " +
        "the containers from any directory with: docker compose " +
        `--project-name ${project} down (both data directories are kept), then rerun`;
      for (const runtime of ["copied", "omitted"]) {
        await cp(moved, original, { recursive: true });
        if (runtime === "omitted") await rm(join(original, ".dacs-runtime"), { recursive: true });
        // Smoked again, so that only the project check stands between it and compose.
        expect((await runGeneratedDockerSmoke(original, passingDockerScenario())).status)
          .toBe(0);
        expect(await realpath(original)).toBe(originalPath);
        expect(await generatedProjectName(original)).toBe(project);
        const collision = await statShiftEnvironment(original, {
          dev: 1,
          ino: String((await stat(moved, { bigint: true })).ino -
            (await stat(original, { bigint: true })).ino),
        });
        for (const env of [undefined, collision]) {
          for (const containers of [running, stopped, [running[0]!]]) {
            for (const args of [["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
              const label = `${runtime} ${env ? "inode collision" : "copy"} ${args.join(" ")}`;
              const refused = await runGeneratedDockerSmoke(original, passingDockerScenario({
                containers,
              }), { args, env });
              expect(refused.status, label).toBe(2);
              expect(refused.stderr, label).toContain(refusal);
              expect(refused.invocations.filter(isComposeInvocation), label).toEqual([]);
              expect(refused.containers ?? containers, label).toEqual(containers);
            }
          }
        }
        // Once the moved project's containers are gone, the copy starts as its own.
        const fresh = await runGeneratedDockerSmoke(original, passingDockerScenario({
          containers: [],
        }), { args: ["--up"] });
        expect(fresh.stderr).toBe("");
        expect(fresh.status, runtime).toBe(0);
        expect(JSON.parse(await readFile(
          join(original, ".dacs-runtime", "compose-project.json"), "utf8",
        ))).toEqual({
          recordVersion: 1,
          project,
          directory: originalPath,
          ...await directoryInode(original),
        });
        await rm(original, { recursive: true });
      }

      // Moved back into place, the project that started them stops and removes them.
      await rename(moved, original);
      const stoppedAgain = await runGeneratedDockerSmoke(original, passingDockerScenario({
        containers: running,
      }), { args: ["--stop"] });
      expect(stoppedAgain.stderr).toBe("");
      expect(stoppedAgain.status).toBe(0);
      expect(stoppedAgain.containers).toEqual(stopped);
      const removed = await runGeneratedDockerSmoke(original, passingDockerScenario({
        containers: running,
      }), { args: ["--down"] });
      expect(removed.status).toBe(0);
      expect(removed.containers).toEqual([]);
    },
    SPAWNING_TEST_TIMEOUT_MS * 4,
  );

  test.runIf(process.platform !== "win32")(
    "refuses colliding inodes on another device and recovers explicitly after a remount",
    async () => {
      const target = await generatedDockerProject("agent");
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const started = await runGeneratedDockerSmoke(target, passingDockerScenario(), { args: ["--up"] });
      expect(started.status).toBe(0);
      const running = started.containers!;
      const recordPath = join(target, ".dacs-runtime", "compose-project.json");
      const originalRecord = await readFile(recordPath, "utf8");
      for (const shift of [{ dev: 0, ino: 1 }, { dev: 1, ino: 0 }]) {
        const env = await statShiftEnvironment(target, shift);
        for (const args of [["--stop"], ["--down"], ["--down", "--remove-orphans"], ["--up"]]) {
          const result = await runGeneratedDockerSmoke(target, passingDockerScenario({ containers: running }),
            { args, env });
          expect(result.status, JSON.stringify({ shift, args })).toBe(2);
          expect(result.stderr).toContain("or its device changed after a remount");
          expect(result.stderr).toContain("docker compose --project-name ");
          expect(result.invocations.filter(isComposeInvocation)).toEqual([]);
          expect(result.containers ?? running).toEqual(running);
          expect(await readFile(recordPath, "utf8")).toBe(originalRecord);
        }
      }
      // An older inode-only record is readable but cannot authorize an action
      // on existing containers, even if the inode and path match.
      const record = JSON.parse(originalRecord) as Record<string, unknown>;
      delete record.device;
      await writeFile(recordPath, JSON.stringify(record), "utf8");
      const legacy = await runGeneratedDockerSmoke(target, passingDockerScenario({ containers: running }),
        { args: ["--stop"] });
      expect(legacy.status).toBe(2);
      expect(legacy.invocations.filter(isComposeInvocation)).toEqual([]);
      // After the explicit down removes the containers, up can rebind the
      // record to the remounted directory, and its own stop works again.
      const env = await statShiftEnvironment(target, { dev: 1, ino: 0 });
      const restarted = await runGeneratedDockerSmoke(target, passingDockerScenario({ containers: [] }),
        { args: ["--up"], env });
      expect(restarted.stderr).toBe("");
      expect(restarted.status).toBe(0);
      const rebound = JSON.parse(await readFile(recordPath, "utf8"));
      expect(rebound.device).toBe(String((await stat(target, { bigint: true })).dev + 1n));
      const own = await runGeneratedDockerSmoke(target, passingDockerScenario({ containers: restarted.containers! }),
        { args: ["--stop"], env });
      expect(own.status).toBe(0);
      expect(own.invocations.filter(isComposeInvocation)).toHaveLength(1);
    },
    SPAWNING_TEST_TIMEOUT_MS * 2,
  );

  test.runIf(process.platform !== "win32")(
    "requires the image's configured service command to load and stop at its role check",
    async () => {
      const target = await generatedDockerProject("service-command-agent");
      for (const service of [
        { status: 0, stderr: "" },
        // The role line alone is not enough: the command must also exit 1.
        { status: 0, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" },
        {
          status: 1,
          stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@kynesyslabs/dacs-node'\n",
        },
        { status: 125, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" },
        { status: 1, stderr: "" },
        // The service's generic failure line does not show which check failed.
        { status: 1, stderr: GENERATED_GENERIC_FAILURE_REPORT + "\n" },
      ]) {
        const result = await runGeneratedDockerSmoke(
          target,
          passingDockerScenario({ service }),
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "configured service command did not load and stop at its role check",
        );
        expect(result.receipt).toBeUndefined();
      }
      const warned = await runGeneratedDockerSmoke(target, passingDockerScenario({
        service: {
          status: 1,
          stderr: "(node:1) ExperimentalWarning: test-only\n" +
            GENERATED_ROLE_CHECK_REPORT + "\n",
        },
      }));
      expect(warned.status).toBe(0);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "passes the smoke only on the line the generated service's role check reports",
    async () => {
      const target = await generatedDockerProject("role-check-agent");
      // With no role, as the smoke runs the image's command, the service stops
      // at its role check and reports that check's own reason code.
      const unconfigured = await runGeneratedService(target, {});
      expect(unconfigured).toEqual({ status: 1, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" });
      // Past the role check, a failure without a reason code reports the generic line.
      const failed = await runGeneratedService(target, { DACS_ROLE: "buyer" });
      expect(failed).toEqual({ status: 1, stderr: GENERATED_GENERIC_FAILURE_REPORT + "\n" });

      const passed = await runGeneratedDockerSmoke(target, passingDockerScenario({
        service: { status: unconfigured.status!, stderr: unconfigured.stderr },
      }));
      expect(passed.status).toBe(0);
      expect(passed.receipt).toBeDefined();
      const refused = await runGeneratedDockerSmoke(target, passingDockerScenario({
        service: { status: failed.status!, stderr: failed.stderr },
      }));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        "configured service command did not load and stop at its role check",
      );
      expect(refused.receipt).toBeUndefined();
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "removes a smoke container that outlives DACS_IMAGE_SMOKE_TIMEOUT_SECONDS",
    async () => {
      const target = await generatedDockerProject("hanging-service-agent");
      for (const hang of ["probe", "service"] as const) {
        expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
        const startedAt = Date.now();
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario({ hang }), {
          env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "1" },
        });
        expect(Date.now() - startedAt, hang).toBeLessThan(20_000);
        expect(result.status, hang).toBe(1);
        const run = result.invocations.filter((args) => args[0] === "run").at(-1)!;
        const name = run[run.indexOf("--name") + 1];
        expect(result.stderr).toContain(
          `container ${name} did not exit within 1s (DACS_IMAGE_SMOKE_TIMEOUT_SECONDS) and was removed`,
        );
        expect(result.invocations.at(-1)).toEqual(["rm", "--force", name]);
        expect(result.receipt).toBeUndefined();
      }
      // A container that cannot be removed is not reported as removed.
      const kept = await runGeneratedDockerSmoke(target, passingDockerScenario({
        hang: "probe",
        fails: ["rm"],
      }), { env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "1" } });
      expect(kept.status).toBe(1);
      const name = kept.invocations.at(-1)![2];
      expect(kept.stderr).toContain(`and could not be removed; run docker rm --force ${name}`);
      expect(kept.stderr).not.toContain("was removed");
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "rejects each image, probe and docker failure and withdraws the earlier pass",
    async () => {
      const target = await generatedDockerProject("rejected-image-agent");
      const { config } = passingDockerScenario();
      const composeUser = `${TEST_ONLY_RUNTIME_UID}:${TEST_ONLY_RUNTIME_GID}`;
      // Docker CLI 28.2 and later omit an unset entrypoint (the default config
      // here); earlier versions print null, and ENTRYPOINT [] may print [].
      // An image with no environment omits Env as well.
      const { Env: _environment, ...withoutEnvironment } = config;
      for (const accepted of [
        config,
        { ...config, Entrypoint: null },
        { ...config, Entrypoint: [] },
        withoutEnvironment,
      ]) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario({
          config: accepted,
        }));
        expect(result.stderr, JSON.stringify(accepted)).toBe("");
        expect(result.status).toBe(0);
        expect(result.receipt).toMatchObject({ imageId: TEST_ONLY_FAKE_IMAGE_ID });
        expect(JSON.parse(result.stdout)).toMatchObject({
          configuredEntrypoint: accepted.Entrypoint ?? null,
        });
      }
      const rejected: [Partial<FakeDockerScenario>, string][] = [
        [{ imageIds: ["rejected-image-agent:local"] },
          "image reference did not resolve to an immutable Docker image ID"],
        [{ config: { ...config, User: "0:0" } },
          "image runtime user is not the generated non-root identity"],
        [{ config: { ...config, WorkingDir: "/" } },
          "image working directory is not /app"],
        [{ config: { ...config, Entrypoint: ["unexpected-program"] } },
          "image entrypoint overrides the generated DACS service command"],
        [{ config: { ...config, Entrypoint: [""] } },
          "image entrypoint overrides the generated DACS service command"],
        [{ config: { ...config, Entrypoint: "node" } },
          "image entrypoint overrides the generated DACS service command"],
        // A role, or any DACS setting, baked into the image.
        [{ config: { ...config, Env: [...config.Env as string[], "DACS_ROLE=seller"] } },
          "image environment sets a DACS_ variable"],
        [{ config: { ...config, Env: ["DACS_DEPLOYMENT=docker"] } },
          "image environment sets a DACS_ variable"],
        [{ config: { ...config, Env: "DACS_ROLE=seller" } },
          "image environment sets a DACS_ variable"],
        [{ config: { ...config, Cmd: ["node", "dist/src/cli.js"] } },
          "image command does not start the generated DACS service"],
        [{ config: { ...config, Cmd: [...GENERATED_SERVICE_COMMAND, "--inspect"] } },
          "image command does not start the generated DACS service"],
        [{ probe: { status: "fail", uid: TEST_ONLY_RUNTIME_UID, gid: TEST_ONLY_RUNTIME_GID } },
          "container probe did not report a pass"],
        // An image whose process does not run as the compose user.
        [{ container: { uid: 10001 } },
          `container runtime identity is not the compose user ${composeUser}`],
        [{ container: { gid: 10001 } },
          `container runtime identity is not the compose user ${composeUser}`],
        // Any Node release but the one the Dockerfile pins, or none reported.
        ...["18.0.0", "20.18.0", "20.19.2", "22.12.0", "v20.19.1"].map((node) =>
          [{ container: { node } },
            `container runs Node.js ${node}, not the ${GENERATED_IMAGE_NODE_VERSION} ` +
              "the generated Dockerfile installs"] as [Partial<FakeDockerScenario>, string]),
        [{ probe: { status: "pass", uid: TEST_ONLY_RUNTIME_UID, gid: TEST_ONLY_RUNTIME_GID } },
          "container runs Node.js undefined, not the"],
        [{ daemonDown: true },
          "docker image failed: Cannot connect to the test-only Docker daemon"],
      ];
      for (const [overrides, message] of rejected) {
        const passed = await runGeneratedDockerSmoke(target, passingDockerScenario());
        expect(passed.receipt).toMatchObject({ imageId: TEST_ONLY_FAKE_IMAGE_ID });
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(overrides));
        expect(result.status, message).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.receipt, message).toBeUndefined();
      }
      // A mutable reference is never inspected or run.
      const mutable = await runGeneratedDockerSmoke(target, passingDockerScenario({
        imageIds: ["rejected-image-agent:local"],
      }));
      expect(mutable.invocations).toHaveLength(1);

      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const missing = await runGeneratedDockerSmoke(target, undefined);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("ENOENT");
      expect(missing.receipt).toBeUndefined();
      const upMissing = await runGeneratedDockerSmoke(target, undefined, {
        args: ["--up"],
      });
      expect(upMissing.status).toBe(1);
      expect(upMissing.stderr).toContain("ENOENT");
    },
    SPAWNING_TEST_TIMEOUT_MS * 2,
  );

  test.runIf(process.platform !== "win32")(
    "fails the image probe for each wrong production file, version, entry point, binding or root",
    async () => {
      const target = await generatedDockerProject("probed-tree-agent");
      const { dependencies } = JSON.parse(
        await readFile(join(target, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      const required = [
        join("dist", "src", "service.js"),
        join("dist", "src", "cli.js"),
        "package.json",
        "package-lock.json",
      ];
      const forbidden = ["src", "test", ".env", "tsconfig.json", "dacs.config.ts"];
      const failures: [Partial<FakeDockerScenario>, string][] = [
        ...Object.keys(dependencies).map((name) =>
          [{ app: { versions: { [name]: "0.0.0-test" } } }, `${name} version mismatch`] as
            [Partial<FakeDockerScenario>, string]),
        ...required.map((path) =>
          [{ app: { remove: [path] } }, `ENOENT: no such file or directory, access '`] as
            [Partial<FakeDockerScenario>, string]),
        ...forbidden.map((path) =>
          [{ app: { add: [path] } }, `development or secret path is present: `] as
            [Partial<FakeDockerScenario>, string]),
        ...[...SDK_ENTRY_POINTS, ...X402_ENTRY_POINTS].map((entryPoint) =>
          [{ app: { remove: [entryPointModule(entryPoint)] } }, "ERR_MODULE_NOT_FOUND"] as
            [Partial<FakeDockerScenario>, string]),
        [{ app: { remove: [SQLITE_BINDING] } }, "better_sqlite3.node"],
        [{ container: { uid: 0, gid: 0 } }, "container executed as root"],
      ];
      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      for (const [overrides, message] of failures) {
        const label = JSON.stringify(overrides);
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(overrides));
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain("docker run failed: ");
        expect(result.stderr, label).toContain(message);
        // Which path, for the file checks.
        const path = overrides.app?.remove?.[0] ?? overrides.app?.add?.[0];
        if (path !== undefined && !path.startsWith("node_modules")) {
          expect(result.stderr, label).toContain(`${path}`);
        }
        expect(result.receipt, label).toBeUndefined();
        // The image's own command never ran.
        expect(result.invocations.filter((args) => args[0] === "run"), label).toHaveLength(1);
      }
      // A forbidden path that cannot be checked fails the probe too; one that
      // resolves to nothing is absent.
      const unchecked = await runGeneratedDockerSmoke(target, passingDockerScenario({
        app: { links: { ".env": ".env" } },
      }));
      expect(unchecked.status).toBe(1);
      expect(unchecked.stderr).toContain("ELOOP");
      const dangling = await runGeneratedDockerSmoke(target, passingDockerScenario({
        app: { links: { ".env": "absent" } },
      }));
      expect(dangling.stderr).toBe("");
      expect(dangling.status).toBe(0);
    },
    SPAWNING_TEST_TIMEOUT_MS * 4,
  );

  test.runIf(process.platform !== "win32")(
    "withdraws smoke receipts before every early preflight failure and preserves them for lifecycle commands",
    async () => {
      const target = await generatedDockerProject("early-smoke-agent");
      const receiptPath = join(target, ".dacs-runtime", "docker-image-smoke.json");
      const envPath = join(target, ".env");
      const environment = await readFile(envPath, "utf8");
      const receipt = { previous: "successful-smoke" };
      await mkdir(dirname(receiptPath), { recursive: true });
      const seed = () => writeFile(receiptPath, JSON.stringify(receipt), "utf8");
      const invalidSettings: Record<string, string>[] = [
        { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "0" },
        { DACS_IMAGE: "" },
        { DACS_RUNTIME_UID: "0" },
      ];
      for (const env of invalidSettings) {
        await seed();
        const result = await runGeneratedDockerSmoke(target, undefined, { env });
        expect(result.status).toBe(2);
        expect(result.invocations).toEqual([]);
        expect(result.receipt).toBeUndefined();
      }
      // An unreadable .env must fail even on root-capable test hosts.
      await rm(envPath);
      await mkdir(envPath);
      await seed();
      const unreadable = await runGeneratedDockerSmoke(target, undefined);
      expect(unreadable.status).toBe(1);
      expect(unreadable.stderr).toContain("EISDIR");
      expect(unreadable.receipt).toBeUndefined();
      await rm(envPath, { recursive: true });
      await writeFile(envPath, environment + "\nCOMPOSE_FILE=foreign.yaml\n", "utf8");
      for (const args of [[], ["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
        await seed();
        const result = await runGeneratedDockerSmoke(target, undefined, { args });
        expect(result.status).toBe(2);
        expect(result.invocations).toEqual([]);
        expect(result.receipt).toEqual(args.length === 0 ? undefined : receipt);
      }
      await writeFile(envPath, environment, "utf8");
      await seed();
      const renamed = join(dirname(target), "Agent.invalid");
      await rename(target, renamed);
      const invalidDirectory = await runGeneratedDockerSmoke(renamed, undefined);
      expect(invalidDirectory.status).toBe(2);
      expect(invalidDirectory.receipt).toBeUndefined();
      await rename(renamed, target);
      await rm(envPath);
      await seed();
      const missingEnvironment = await runGeneratedDockerSmoke(target, undefined);
      expect(missingEnvironment.status).toBe(2);
      expect(missingEnvironment.receipt).toBeUndefined();
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "requires DACS_IMAGE and a non-root compose user before calling docker",
    async () => {
      const target = await generatedDockerProject("smoke-usage-agent");
      const usageErrors: [SmokeOptions, string][] = [
        [{ args: ["my-agent:local"] }, "usage: node scripts/docker-runtime-smoke.mjs"],
        [{ args: ["--verify-smoked"] }, "usage: node scripts/docker-runtime-smoke.mjs"],
        [{ args: ["--up", "--down"] }, "usage: node scripts/docker-runtime-smoke.mjs"],
        [{ env: { DACS_IMAGE: "" } }, "usage: set DACS_IMAGE and non-root"],
        [{ args: ["--up"], env: { DACS_IMAGE: "" } }, "usage: set DACS_IMAGE and non-root"],
        [{ env: { DACS_RUNTIME_UID: "0" } }, "usage: set DACS_IMAGE and non-root"],
        [{ env: { DACS_RUNTIME_GID: "root" } }, "usage: set DACS_IMAGE and non-root"],
        [{ env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "0" } }, "is 1-9999"],
        [{ env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "10000" } }, "is 1-9999"],
        [{ env: { DACS_IMAGE: "agent image:local" } }, "usage: set DACS_IMAGE and non-root"],
        [{ env: { DACS_RUNTIME_UID: "2147483648" } }, "usage: set DACS_IMAGE and non-root"],
        [{ env: { DACS_RUNTIME_GID: "2147483648" } }, "usage: set DACS_IMAGE and non-root"],
      ];
      for (const [options, message] of usageErrors) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(), options);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(message);
        expect(result.invocations).toEqual([]);
      }
      // dacs:up runs no smoke container, so the smoke timeout cannot block it.
      const upWithTimeout = await runGeneratedDockerSmoke(target, passingDockerScenario(), {
        args: ["--up"],
        env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "0" },
      });
      expect(upWithTimeout.status).toBe(5);
      expect(upWithTimeout.stderr).toContain("last passed dacs:image:smoke");
      // An empty setting is unset, so the timeout default applies.
      const emptyTimeout = await runGeneratedDockerSmoke(target, passingDockerScenario(), {
        env: { DACS_IMAGE_SMOKE_TIMEOUT_SECONDS: "" },
      });
      expect(emptyTimeout.stderr).toBe("");
      expect(emptyTimeout.status).toBe(0);
      // A .env that exists but cannot be read is an error, not an empty file.
      if (process.getuid?.() !== 0) {
        await chmod(join(target, ".env"), 0o000);
        try {
          const unreadable = await runGeneratedDockerSmoke(target, passingDockerScenario());
          expect(unreadable.status).toBe(1);
          expect(unreadable.stderr).toContain("EACCES");
          expect(unreadable.invocations).toEqual([]);
        } finally {
          await chmod(join(target, ".env"), 0o600);
        }
      }

      // Compose would normalise these names, so that agent.a, Agent-A and agenta
      // would all collide; the script uses a directory's name only as it stands.
      let directory = target;
      for (const name of ["agent.a", "Agent-A", "-agent", "agent a"]) {
        const renamed = join(dirname(directory), name);
        await rename(directory, renamed);
        directory = renamed;
        for (const args of [[], ["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
          const result = await runGeneratedDockerSmoke(directory, passingDockerScenario(), { args });
          expect(result.status, `${name} ${args.join(" ")}`).toBe(2);
          expect(result.stderr).toContain("whose name is a compose project name");
          expect(result.invocations).toEqual([]);
        }
      }
      await rename(directory, target);

      await rm(join(target, ".env"));
      const missing = await runGeneratedDockerSmoke(target, passingDockerScenario());
      expect(missing.status).toBe(2);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test("generates a guarded authority-separated dual-rail Docker bootstrap", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "live-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "both",
      install: false,
    });
    expect(result).toMatchObject({
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "both",
      installed: false,
      doctor: "not-run",
    });
    expect(await filesBelow(target)).toEqual(expect.arrayContaining([
      "src/cli.ts",
      "src/doctor.ts",
      "src/funded-doctor.ts",
      "src/fulfilment-examples.ts",
      "src/lifecycle.ts",
      "src/local-lifecycle.ts",
      "src/telemetry.ts",
      "src/purchase.ts",
      "src/setup.ts",
      "src/service.ts",
      "src/upgrade.ts",
      "scripts/docker-runtime-smoke.mjs",
      "test/live-bootstrap.test.ts",
      "compose.yaml",
      "Dockerfile",
      "data/buyer/.gitkeep",
      "data/seller/.gitkeep",
    ]));
    for (const role of ["buyer", "seller"] as const) {
      const observed = await lstat(join(target, "data", role));
      expect(observed.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(observed.mode & 0o077).toBe(0);
    }
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
      "@kynesyslabs/demosdk": "4.0.16",
      "@x402/core": "2.15.0",
      "@x402/evm": "2.15.0",
      "@x402/fetch": "2.15.0",
      "better-sqlite3": "12.6.2",
      "viem": "2.55.19",
    });
    expect(packageSource.dacs).toEqual({
      generatorVersion: "0.1.0-alpha.0",
      releaseMetadataVersion: 1,
      standardRevision: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20",
      configSchemaVersion: 1,
      sqliteSchemaVersion: 8,
      supportedSqliteMigrationFrom: [1, 2, 3, 4, 5, 6, 7, 8],
      breakingConfigurationChanges: [],
    });
    expect(packageSource.scripts).toMatchObject({
      "dacs:doctor": expect.any(String),
      "dacs:doctor:funded": expect.any(String),
      "dacs:up": expect.any(String),
      "dacs:setup": expect.any(String),
      "dacs:buy": expect.any(String),
      "dacs:status": expect.any(String),
      "dacs:metrics": expect.any(String),
      "dacs:down": expect.any(String),
      "dacs:upgrade": expect.any(String),
      "dacs:backup": expect.any(String),
      "dacs:restore": expect.any(String),
      "dacs:uninstall": expect.any(String),
      "dacs:image:smoke": "node scripts/docker-runtime-smoke.mjs",
    });
    for (const command of Object.values(packageSource.scripts as Record<string, string>)) {
      if (command.includes("dist/src/") || command.includes("dist/test/")) {
        expect(command).toContain(
          "node --import @kynesyslabs/dacs-node/demos-loader",
        );
      }
    }
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    expect(compose).toContain("DACS_BUYER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_SELLER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_BUYER_DEMOS_SECRET_FILE");
    expect(compose).toContain("DACS_SELLER_DEMOS_SECRET_FILE");
    expect(compose).toContain("DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE");
    expect(compose).toContain("/run/secrets/wallet-authority-token:ro");
    expect(compose).toContain("DACS_WALLET_AUTHORITY_URL");
    expect(compose).toContain("DACS_X402_LISTING_DRAFT_FILE");
    expect(compose).toContain("DACS_PAY_DEM_LISTING_DRAFT_FILE");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("DACS_RUNTIME_UID");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("network_mode: host");
    expect(compose).toContain("http://127.0.0.1:3101");
    expect(compose).not.toContain("http://buyer:");
    expect(compose).not.toContain("http://seller:");
    expect(compose).not.toMatch(/(?:3306|5432|6379):/);
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const expectedRuntimeUid = typeof process.getuid === "function" && process.getuid() > 0
      ? process.getuid() : 10001;
    expect(environmentExample).toContain(`DACS_RUNTIME_UID=${expectedRuntimeUid}`);
    expect(environmentExample).toContain("DACS_DEPLOYMENT=docker");
    expect(environmentExample).not.toContain("DACS_SETUP_WRITE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_PURCHASE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_DOCTOR_FUNDED_CONFIRM");
    expect(environmentExample).not.toContain("DACS_RESTORE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_UNINSTALL_CONFIRM");
    expect(environmentExample).toContain("DACS_BACKUP_AUTH_KEY_FILE=");
    expect(environmentExample).toContain("DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE=");
    expect(environmentExample).toContain("DACS_WALLET_AUTHORITY_URL=");
    expect(environmentExample).toContain("DACS_WALLET_MAX_CONCURRENT_EFFECTS=1");
    expect(environmentExample).toContain("DACS_X402_WALLET_MAX_CUMULATIVE_DEBIT=100");
    expect(environmentExample).toContain("DACS_PAY_DEM_WALLET_MINIMUM_RESERVE=5");
    const generatedConfig = await readFile(join(target, "dacs.config.ts"), "utf8");
    expect(generatedConfig).toContain("write confirmation must not be persisted in .env");
    expect(generatedConfig).toContain("dacs4:registry:v0.1");
    expect(generatedConfig).toContain('["pay-dem","x402"]');
    expect(generatedConfig).not.toContain("dacs4:registry:x402");
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts");
    expect(dockerfile).toContain("RUN npm rebuild better-sqlite3");
    expect(dockerfile).toContain("npm ci --ignore-scripts --omit=optional --no-audit --no-fund");
    expect(dockerfile).toContain("npm prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund");
    expect(dockerfile).toContain("--mode=0755 /app");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("ENTRYPOINT []");
    expect(dockerfile).toContain(
      'CMD ["node", "--import", "@kynesyslabs/dacs-node/demos-loader", "dist/src/service.js"]',
    );
    expect(dockerfile).not.toContain("COPY . .");
    const imageSmoke = await readFile(
      join(target, "scripts", "docker-runtime-smoke.mjs"),
      "utf8",
    );
    expect(imageSmoke).toContain('"--network", "none"');
    expect(imageSmoke).toContain('"--read-only"');
    expect(imageSmoke).toContain('config.User !== "10001:10001"');
    expect(imageSmoke).toContain('await import("@kynesyslabs/dacs/substrate")');
    expect(imageSmoke).toContain('await import("@kynesyslabs/demosdk/websdk")');
    expect(imageSmoke).not.toContain('await import("@kynesyslabs/demosdk")');
    expect(imageSmoke).toContain('+ "\\\\n");');
    expect(imageSmoke).not.toContain("shell: true");
    const combined = (await Promise.all(
      (await filesBelow(target)).map((file) => readFile(join(target, file), "utf8")),
    )).join("\n");
    expect(combined).not.toContain("git+");
    expect(combined).not.toContain("../../src/");
    expect(JSON.stringify(packageSource)).not.toContain("file:");
    expect(combined).not.toContain("reviewed-live-adapter-not-configured");
    expect(combined).toContain("resolveDacsX402ExistingListingV1");
    expect(combined).toContain("readDacsPublicJsonV1");
    expect(combined).toContain("inspectDacsX402PurchaseCostV1");
    expect(combined).toContain("inspectDacsDemosBalanceHeadroomV1");
    expect(combined).toContain("inspectDacsX402AssetBalanceV1");
    expect(combined).toContain("inspectDacsX402GasBalanceV1");
    expect(combined).toContain("inspectDacsX402ListingDraftV1");
    expect(combined).toContain("prepareDacsListingSetupV1");
    expect(combined).toContain("createDacsListingSetupExecutorV1");
    expect(combined).toContain("createDacsPurchaseQueueExecutorV1");
    expect(combined).toContain("prepareDacsX402PurchaseV1");
    expect(combined).toContain("prepareDacsPayDemPurchaseV1");
    expect(combined).toContain("maximumDemosStorageWriteFeeDem");
    expect(combined).toContain("consent-bound plan reserve five buyer writes");
    expect(combined).toContain("resolveDacsPayDemExistingListingV1");
    expect(combined).toContain("createDacsFixedPriceMultirailBuyerLiveV1");
    expect(combined).toContain("createDacsFixedPriceMultirailSellerLiveV1");
    expect(combined).toContain("createDacsRemoteWalletSpendAuthorityV2");
    expect(combined).not.toContain("createDacsRemoteWalletSpendAuthorityV1");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_ID");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_EPOCH");
    expect(combined).toContain("DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
    expect(combined).not.toContain("createDacsWalletSpendAuthorityV1");
    expect(combined).not.toContain("createDacsX402WalletSpendRecoveryAuthenticatorV1");
    expect(combined).not.toContain("createDacsPayDemWalletSpendRecoveryAuthenticatorV1");
    expect(combined).not.toContain("authenticateRecovery: async () => true");
    expect(combined).not.toContain(
      'if (observation.disposition !== "settled") return true',
    );
    expect(combined).toContain("assets: Object.freeze([Object.freeze({");
    expect(combined).not.toContain('stateDirectory: context.config.dataDirectory');
    expect(combined).toContain("backup-authority-state-rejected");
    expect(combined).toContain("import the complete legacy wallet-spend journal");
    expect(combined).toContain("Never empty-provision an existing");
    expect(combined).toContain('walletPolicyStatus: "post-start-inspection-required"');
    expect(combined).toContain('reasonCode: "wallet-spend-operator-action-required"');
    expect(combined).toContain("operatorActionCount: status.operatorActionReservations.length");
    expect(combined).toContain("reservedWorstCaseDebit: asset.reservedWorstCaseDebit");
    expect(combined).toContain("availableHeadroom: asset.availableHeadroom");
    expect(combined).toContain("--max-total-debit-dem");
    expect(combined).toContain("dacs-generated-purchase-request/v1");
    expect(combined).toContain("--resume-job");
    expect(combined).toContain("resume: input.resume");
    expect(combined).toContain("createDacsX402ExactRetainedReplayConfirmerV1");
    expect(combined).toContain("startDacsLocalRoleServices");
    expect(combined).not.toContain('adapterStatus: "not-configured"');
    expect(combined).toContain("runDacsGuardedCommandV1");
    expect(combined).toContain("openDacsListingDiscoveryStoreV1");
    expect(combined).toContain("createDacsListingDiscoveryRequestHandlerV1");
    expect(combined).toContain('writePolicy: "read-only"');
    expect(combined).toContain("readDacsRoleServiceStatusesV1");
    expect(combined).toContain("createDacsLiveRoleRuntimeV1");
    expect(combined).not.toContain("createDacsUnavailableLiveCommerceGraphV1");
    expect(combined).toContain("createDacsFixedPriceX402BuyerLiveV1");
    expect(combined).toContain("createDacsFixedPriceX402SellerLiveV1");
    expect(combined).toContain("DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK");
    expect(combined).toContain('finalityTag: "latest"');
    expect(combined).toContain('evmFinalityTag: "latest"');
    expect(combined).toContain("retryDelayMs: 5_000");
    expect(combined).toContain("minimumConfirmations: Number(finalityBlocks)");
    expect(combined).toContain("inspectDacsX402TokenDomainV1");
    expect(combined).toContain("DACS_X402_TOKEN_NAME=USDC");
    expect(combined).not.toContain("DACS_X402_TOKEN_NAME=USD Coin");
    expect(combined).not.toContain('status: "not-configured"');
    expect(combined).toContain("createCommerceGraph: async");
    expect(combined).not.toContain("createOperations: () => Object.freeze({})");
    expect(combined).toContain("post-start-doctor-required");
    expect(combined).toContain("DACS_SETUP_WRITE_CONFIRM=1");
    expect(combined).toContain("DACS_PURCHASE_CONFIRM=1");
    expect(combined).toContain("DACS_DOCTOR_FUNDED_CONFIRM=1");
    expect(combined).toContain("DACS_RESTORE_CONFIRM=1");
    expect(combined).toContain("DACS_UNINSTALL_CONFIRM=1");
    expect(combined).toContain("dacs-generated-backup/v1");
    expect(combined).toContain("backup-authentication-failed");
    expect(combined).toContain("safetyBackupDirectory");
    expect(combined).toContain("--explain");
    expect(combined).toContain("createStaticJsonFulfilment");
    expect(combined).toContain("reconcileExactEffectBeforeRetry");
    expect(combined).toContain("blindRetryPermitted: false");
    expect(combined).toContain("dacs-generated-commerce-timing/v1");
    expect(combined).toContain("operational-telemetry-not-normative-proof");
    expect(combined).toContain("telemetry-capacity-reached");
    expect(combined).toContain("prepareDacsFundedDoctorV1");
    expect(combined).toContain("createDacsFundedDoctorExecutorV1");
    expect(combined).toContain("--resume-run");
    expect(combined).toContain("reconciliation is read-only");
    expect(combined).not.toContain("funded doctor adapter is not configured");
    expect(combined).toContain("dacs-generated-upgrade-check/v1");
    expect(combined).toContain("inspectDacsNodeSqliteUpgradeSafetyV1");
    expect(combined.match(/httpTransport: Object\.freeze/g)).toHaveLength(2);
    expect(combined).toContain(
      "sqliteSchemaVersion: backup.release.sqliteSchemaVersion + 1",
    );
    expect(combined).toContain("release: { ...backup.release, sqliteSchemaVersion: 0 }");
    expect(combined).toContain("registry.npmjs.org");
    expect(combined).toContain("automatic-upgrade-not-supported");
    expect(combined).not.toContain('availableVersion: "not-queried"');
  });

  test("generates a native DEM project without EVM or x402 dependencies", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "native-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller",
      deployment: "docker",
      rails: "pay-dem",
      install: false,
    });
    expect(result).toMatchObject({ rails: "pay-dem", installed: false });
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
      "@kynesyslabs/demosdk": "4.0.16",
      "better-sqlite3": "12.6.2",
    });
    const config = await readFile(join(target, "dacs.config.ts"), "utf8");
    expect(config).toContain('["pay-dem"]');
    expect(config).toContain('requestedNetwork: "demos"');
    const environment = await readFile(join(target, ".env.example"), "utf8");
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    for (const source of [environment, compose]) {
      expect(source).not.toContain("DACS_BUYER_EVM_SECRET_FILE");
      expect(source).not.toContain("DACS_SELLER_EVM_SECRET_FILE");
      expect(source).not.toContain("DACS_EVM_RPC_URL");
      expect(source).not.toContain("DACS_X402_");
      expect(source).not.toContain("DACS_FIXED_PRICE_AMOUNT");
      expect(source).not.toContain("DACS_MAX_EVM_NETWORK_FEE_ETH");
      expect(source).toContain("DACS_PAY_DEM_LISTING_DRAFT_FILE");
      expect(source).toContain("DACS_MAX_PAY_DEM_TOTAL_DEBIT");
    }
    expect(environment).toContain("DACS_MAX_SERVICE_ASSET=DEM");
    expect(compose).toContain("DACS_MAX_SERVICE_ASSET:-DEM");
  });

  test("generates an x402 project without native-payment configuration noise", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "x402-agent");
    await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      rails: "x402",
      install: false,
    });
    const environment = await readFile(join(target, ".env.example"), "utf8");
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    for (const source of [environment, compose]) {
      expect(source).not.toContain("DACS_PAY_DEM_");
      expect(source).not.toContain("DACS_MAX_PAY_DEM_");
      expect(source).toContain("DACS_X402_LISTING_DRAFT_FILE");
      expect(source).toContain("DACS_X402_FACILITATOR_URL");
    }
  });

  test("generates a real local role-service lifecycle when selected", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "local-live-agent");
    await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "local",
      install: false,
    });
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const lifecycle = await readFile(join(target, "src/local-lifecycle.ts"), "utf8");
    const cli = await readFile(join(target, "src/cli.ts"), "utf8");
    expect(environmentExample).toContain("DACS_DEPLOYMENT=local");
    expect(lifecycle).toContain('DACS_ROLE: role');
    expect(lifecycle).toContain('process.kill(record.pid, "SIGTERM")');
    expect(lifecycle).toContain("local-runtime-process-identity-mismatch");
    expect(cli).toContain("startDacsLocalRoleServices");
    expect(cli).toContain("stopDacsLocalRoleServices");
  });

  test("publishes the complete tree atomically across a nested-symlink race", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "atomic-agent");
    const outside = join(parent, "outside");
    await mkdir(outside);

    const plantDuringPartialPublication = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 5_000; attempt += 1) {
        try {
          await lstat(join(target, "secrets", "README.md"));
          try {
            await lstat(join(target, "src", "verifier.ts"));
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await symlink(outside, join(target, "src"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
      return false;
    };

    const [result, planted] = await Promise.all([
      createDacsAgentProject({ targetDirectory: target, install: false }),
      plantDuringPartialPublication(),
    ]);
    expect(result.files).toContain("src/verifier.ts");
    expect(planted).toBe(false);
    expect((await readdir(outside))).toEqual([]);
    expect((await lstat(join(target, "src"))).isDirectory()).toBe(true);
    expect(await readdir(parent)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.staging-/)]),
    );
  });

  test("allows only one complete publisher for a concurrent target", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "contended-agent");
    const results = await Promise.allSettled([
      createDacsAgentProject({ targetDirectory: target, install: false }),
      createDacsAgentProject({ targetDirectory: target, install: false }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await filesBelow(target)).toContain("src/service.ts");
    expect(await readdir(parent)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.staging-/)]),
    );
  });

  test("defines the concurrent empty-target publication boundary", async () => {
    const parent = await temporaryDirectory();
    const staging = join(parent, ".agent.staging-test");
    const target = join(parent, "agent");
    await mkdir(staging);
    await writeFile(join(staging, "complete.txt"), "complete\n", "utf8");

    const publication = publishCompleteStagingDirectory(
      staging,
      target,
      () => mkdir(target),
    );
    if (process.platform === "win32") {
      await expect(publication).rejects.toBeDefined();
      return;
    }
    await expect(publication).resolves.toBeUndefined();
    await expect(readFile(join(target, "complete.txt"), "utf8")).resolves.toBe("complete\n");
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("parses the documented non-interactive command", () => {
    expect(
      parseCreateDacsAgentArguments(["my-agent", "--yes", "--run"]),
    ).toMatchObject({
      targetDirectory: "my-agent",
      yes: true,
      run: true,
      install: true,
    });
  });

  test("parses the documented non-interactive live bootstrap", () => {
    expect(parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--profile",
      "dacs-sdk:fixed-price-x402:v1", "--role", "seller", "--deploy", "docker",
      "--rails", "both",
    ])).toMatchObject({
      targetDirectory: "my-agent",
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller",
      deployment: "docker",
      rails: "both",
      yes: true,
    });
    expect(() => parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--rails", "fallback",
    ])).toThrow(/x402, pay-dem or both/);
    expect(() => parseCreateDacsAgentArguments([
      "my-agent", "--yes", "--mode", "live-demos", "--role", "verifier",
    ])).toThrow(/demo-all, buyer or seller/);
  });

  test("rejects the unimplemented live verifier role through the public API", async () => {
    const parent = await temporaryDirectory();
    await expect(createDacsAgentProject({
      targetDirectory: join(parent, "verifier-live-agent"),
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "verifier" as never,
      install: false,
    })).rejects.toThrow(/demo-all, buyer or seller/);
  });
});
