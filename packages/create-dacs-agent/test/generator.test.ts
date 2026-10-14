import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createDacsAgentProject } from "../src/index.js";
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
  reasonCode: "role-runtime-unavailable",
});

interface FakeContainer {
  Id: string;
  Image: string;
  project: string;
  service: string;
  running: boolean;
}

interface FakeDockerScenario {
  // Successive resolutions of an image tag, by `docker image inspect --format
  // {{.Id}}` or by compose creating a container from a tag; the last repeats.
  imageIds: string[];
  daemonDown?: boolean;
  config: Readonly<Record<string, unknown>>;
  probe: Readonly<Record<string, unknown>>;
  service: Readonly<{ status: number; stderr: string }>;
  // That container never exits by itself.
  hang?: "probe" | "service";
  // compose up exits with this status after creating only composeUpCreates.
  composeUpStatus?: number;
  composeUpCreates?: string[];
  // These docker commands ("ps", "container", "rm" or "compose <subcommand>")
  // fail every time, or only the first time.
  fails?: string[];
  failsOnce?: string[];
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
  containers?: FakeContainer[];
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
    probe: { status: "pass", uid: TEST_ONLY_RUNTIME_UID, gid: TEST_ONLY_RUNTIME_GID },
    service: { status: 1, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" },
    ...overrides,
  };
}

// Compose is modelled only as far as dacs:up depends on it: which files it
// reads (--file, else COMPOSE_FILE, else compose.yaml plus compose.override.yaml),
// the project name (--project-name, else COMPOSE_PROJECT_NAME, else the
// directory name), each service's image (an override's per-service image:,
// else DACS_IMAGE from the environment, else .env) and the services started
// (those named, else every service in the files).
const TEST_ONLY_FAKE_DOCKER_SOURCE = `const {
  appendFileSync, existsSync, readFileSync, writeFileSync,
} = require("node:fs");
const { basename, join, resolve } = require("node:path");
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
  if ((scenario.fails ?? []).includes(name) ||
      ((scenario.failsOnce ?? []).includes(name) && once(name))) {
    process.stderr.write("test-only " + name + " failure\\n");
    process.exit(1);
  }
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
      state.push(...kept, { Id, Image, project, service, running: true });
    }
    saveContainers(state);
    if (scenario.composeUpStatus !== undefined) process.exit(scenario.composeUpStatus);
  } else if (subcommand === "stop" && !scenario.stopLeavesRunning) {
    for (const container of state) {
      if (container.project === project && selected.includes(container.service)) {
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
  else process.stdout.write(JSON.stringify(scenario.probe) + "\\n");
} else if (args[0] === "run") {
  if (scenario.hang === "service") hang();
  else {
    process.stderr.write(scenario.service.stderr);
    process.exitCode = scenario.service.status;
  }
} else if (args[0] === "rm" && args[1] === "--force") {
  // Removing the named smoke container succeeds unless it fails.
  failIf("rm");
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
  failIf("container");
  if (scenario.inspectOutput !== undefined && once("inspect-output")) {
    process.stdout.write(scenario.inspectOutput + "\\n");
    process.exit(0);
  }
  const state = containers();
  process.stdout.write(JSON.stringify(args.slice(2).map((id) => {
    const container = state.find((candidate) => candidate.Id === id);
    return {
      Id: id,
      Image: container.Image,
      Config: { Labels: {
        "com.docker.compose.project": container.project,
        "com.docker.compose.service": container.service,
        "com.docker.compose.oneoff": "False",
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

async function generatedDockerProject(name: string): Promise<string> {
  const parent = await temporaryDirectory();
  const target = join(parent, name);
  await createDacsAgentProject({
    targetDirectory: target,
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role: "buyer",
    deployment: "docker",
    rails: "both",
    install: false,
  });
  // The README's `cp .env.example .env`, with a fixed compose runtime user.
  const environment = (await readFile(join(target, ".env.example"), "utf8"))
    .replace(/^DACS_RUNTIME_UID=.*$/m, `DACS_RUNTIME_UID=${TEST_ONLY_RUNTIME_UID}`)
    .replace(/^DACS_RUNTIME_GID=.*$/m, `DACS_RUNTIME_GID=${TEST_ONLY_RUNTIME_GID}`);
  await writeFile(join(target, ".env"), environment, "utf8");
  return target;
}

type SmokeOptions = Readonly<{ args?: string[]; env?: Record<string, string> }>;

async function runGeneratedDockerSmoke(
  target: string,
  scenario: FakeDockerScenario | undefined,
  options: SmokeOptions = {},
) {
  const fakeBin = await temporaryDirectory();
  const dockerLog = join(fakeBin, "docker-calls.jsonl");
  const scenarioPath = join(fakeBin, "docker-scenario.json");
  if (scenario !== undefined) {
    await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
    await writeFakeExecutable(fakeBin, "docker", TEST_ONLY_FAKE_DOCKER_SOURCE);
  }
  const result = spawnSync(
    process.execPath,
    [join(target, "scripts", "docker-runtime-smoke.mjs"), ...(options.args ?? [])],
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
    .then((source) => JSON.parse(source) as FakeContainer[], () => undefined);
  const receipt = await readFile(
    join(target, ".dacs-runtime", "docker-image-smoke.json"),
    "utf8",
  ).then((source) => JSON.parse(source) as unknown, () => undefined);
  return { ...result, invocations, composeEnvironments, containers, receipt };
}

// The compose invocation prefix every Docker lifecycle command uses.
async function generatedComposeArguments(target: string): Promise<string[]> {
  const directory = await realpath(target);
  return [
    "compose",
    "--file", join(directory, "compose.yaml"),
    "--project-directory", directory,
    "--project-name", basename(directory),
  ];
}

const isComposeInvocation = (args: readonly string[]) => args[0] === "compose";

function localImageReferenceOf(environment: string): string {
  const match = /^DACS_IMAGE=(.+)$/m.exec(environment);
  if (match === null) throw new Error("generated .env.example has no DACS_IMAGE");
  return match[1]!;
}

describe("create-dacs-agent", () => {
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
  });

  test.runIf(process.platform !== "win32")(
    "never runs npm with --no-install",
    async () => {
      const fakeBin = await temporaryDirectory();
      const npmLog = join(fakeBin, "npm-calls.jsonl");
      await writeFakeExecutable(fakeBin, "npm", `require("node:fs").appendFileSync(
  ${JSON.stringify(npmLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`);
      const parent = await temporaryDirectory();
      const inheritedPath = process.env.PATH;
      process.env.PATH = fakeBin;
      try {
        await createDacsAgentProject({ targetDirectory: join(parent, "offline"), install: false });
        for (const deployment of ["docker", "local"] as const) {
          await createDacsAgentProject({
            targetDirectory: join(parent, `live-${deployment}`),
            mode: "live-demos",
            profile: "dacs-sdk:fixed-price-x402:v1",
            role: "seller",
            deployment,
            install: false,
          });
        }
      } finally {
        process.env.PATH = inheritedPath;
      }
      await expect(readFile(npmLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "installs with npm's audit report visible and tells users to run npm audit",
    async () => {
      const fakeBin = await temporaryDirectory();
      const npmLog = join(fakeBin, "npm-calls.jsonl");
      await writeFakeExecutable(fakeBin, "npm", `require("node:fs").appendFileSync(
  ${JSON.stringify(npmLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
      const target = join(await temporaryDirectory(), "audited-agent");
      const inheritedPath = process.env.PATH;
      process.env.PATH = fakeBin;
      try {
        await createDacsAgentProject({
          targetDirectory: target,
          mode: "live-demos",
          profile: "dacs-sdk:fixed-price-x402:v1",
          role: "buyer",
          deployment: "docker",
          rails: "both",
        });
      } finally {
        process.env.PATH = inheritedPath;
      }
      const invocations = (await readFile(npmLog, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as string[]);
      // Install with every lifecycle script off, rebuild only the reviewed native
      // SQLite adapter, then run the pre-start doctor.
      expect(invocations).toEqual([
        ["install", "--ignore-scripts", "--omit=optional", "--no-fund"],
        ["rebuild", "better-sqlite3"],
        ["run", "dacs:doctor", "--", "--phase", "pre-start", "--for", "start"],
      ]);
      expect(invocations.flat()).not.toContain("--no-audit");
      const readme = await readFile(join(target, "README.md"), "utf8");
      expect(readme).toContain("\nnpm audit\n");
      expect(readme).toContain("run `npm audit` in this project yourself");
      expect(readme).not.toContain("release gate");
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

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
    expect(readme).toContain("with `DACS_IMAGE` set to that image ID rather\nthan the tag");
    expect(readme).toContain("refuse to run\nwhile `.env` sets any `COMPOSE_*` variable");
    expect(readme).toContain("Compose plugin v2.10 or later");
    // The script's --up, --stop and --down modes are exercised directly below; the
    // CLI only dispatches to them by deployment, after the pre-start doctor for
    // dacs:up, and refuses maintenance when the stop fails.
    expect(cli).not.toContain('command("docker"');
    expect(cli).toContain(
      'command(process.execPath, ["scripts/docker-runtime-smoke.mjs", ...args])',
    );
    expect(cli).toContain([
      "async function startGate(): Promise<number> {",
      '  let report = await runGeneratedDoctor("pre-start", "start");',
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
    const sdkEntryPoints = [
      "@kynesyslabs/dacs",
      "@kynesyslabs/dacs/substrate",
      "@kynesyslabs/dacs-node",
      "@kynesyslabs/demosdk/websdk",
      "@kynesyslabs/demosdk/storage",
      "@kynesyslabs/demosdk/abstraction",
    ];
    // The SDK and host kit import these on an x402 rail's first use.
    const x402EntryPoints = [
      "viem",
      "viem/accounts",
      "@x402/core/client",
      "@x402/core/server",
      "@x402/evm",
      "@x402/evm/exact/client",
      "@x402/evm/exact/server",
      "@x402/fetch",
    ];
    for (const [rails, entryPoints] of [
      ["both", [...sdkEntryPoints, ...x402EntryPoints]],
      ["x402", [...sdkEntryPoints, ...x402EntryPoints]],
      ["pay-dem", sdkEntryPoints],
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
  });

  test.runIf(process.platform !== "win32")(
    "smokes DACS_IMAGE as the compose runtime user and records its one image ID",
    async () => {
      const target = await generatedDockerProject("immutable-image-agent");
      const image = localImageReferenceOf(await readFile(join(target, ".env"), "utf8"));
      const user = `${TEST_ONLY_RUNTIME_UID}:${TEST_ONLY_RUNTIME_GID}`;
      // The tag moves after the first resolution; every later call uses the ID.
      const result = await runGeneratedDockerSmoke(target, passingDockerScenario({
        imageIds: [TEST_ONLY_FAKE_IMAGE_ID, TEST_ONLY_REPLACEMENT_IMAGE_ID],
      }));
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
      });

      // Compose prefers the shell environment over .env; so does the smoke.
      const shell = await runGeneratedDockerSmoke(target, passingDockerScenario({
        probe: { status: "pass", uid: 5151, gid: 5252 },
      }), { env: { DACS_RUNTIME_UID: "5151", DACS_RUNTIME_GID: "5252" } });
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
      const started = await runGeneratedDockerSmoke(target, passingDockerScenario(), up);
      expect(started.stderr).toBe("");
      expect(started.status).toBe(0);
      expect(JSON.parse(started.stdout)).toMatchObject({
        status: "started",
        imageId: TEST_ONLY_FAKE_IMAGE_ID,
        services: ["buyer", "seller"],
      });
      expect(started.invocations.filter(isComposeInvocation)).toEqual([[
        ...await generatedComposeArguments(target),
        "up", "--detach", "--no-build", "--pull", "never", "buyer", "seller",
      ]]);
      expect(started.composeEnvironments).toEqual([{
        subcommand: "up",
        DACS_IMAGE: TEST_ONLY_FAKE_IMAGE_ID,
        DACS_RUNTIME_UID: String(TEST_ONLY_RUNTIME_UID),
        DACS_RUNTIME_GID: String(TEST_ONLY_RUNTIME_GID),
        COMPOSE_PROJECT_NAME: "verified-image-agent",
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
          COMPOSE_PROJECT_NAME: "override-agent",
          composeVariables: ["COMPOSE_PROJECT_NAME"],
        });
        expect(started.containers).toEqual([
          ["buyer", TEST_ONLY_FAKE_IMAGE_ID],
          ["seller", TEST_ONLY_FAKE_IMAGE_ID],
        ].map(([service, Image]) => ({
          Id: `container-override-agent-${service}`,
          Image,
          project: "override-agent",
          service,
          running: true,
        })));
      }

      // Compose imports COMPOSE_* variables from .env itself, and falls back to
      // COMPOSE_PROJECT_NAME when the file does not load; such a .env is refused.
      const environment = await readFile(join(target, ".env"), "utf8");
      for (const line of [
        "COMPOSE_PROJECT_NAME=another-project",
        "export COMPOSE_PROFILES=extra",
        "  COMPOSE_FILE=extra.yaml",
      ]) {
        await writeFile(join(target, ".env"), `${environment}${line}\n`, "utf8");
        for (const args of [[], ["--up"], ["--stop"], ["--down"], ["--down", "--remove-orphans"]]) {
          const refused = await runGeneratedDockerSmoke(target, scenario, { args });
          expect(refused.status, `${line} ${args.join(" ")}`).toBe(2);
          expect(refused.stderr).toContain("remove every COMPOSE_* variable from .env");
          expect(refused.invocations).toEqual([]);
        }
      }
      await writeFile(join(target, ".env"), environment, "utf8");
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
      const strayContainer: FakeContainer = {
        Id: "container-checked-start-agent-extra",
        Image: TEST_ONLY_REPLACEMENT_IMAGE_ID,
        project: "checked-start-agent",
        service: "extra",
        running: true,
      };
      const refused: [Partial<FakeDockerScenario>, string][] = [
        [{ composeCreatesImage: TEST_ONLY_REPLACEMENT_IMAGE_ID },
          `the buyer container runs ${TEST_ONLY_REPLACEMENT_IMAGE_ID}`],
        [{ composeSkips: ["seller"] }, "compose created 0 seller containers"],
        [{ containers: [strayContainer] },
          "service extra is also running in compose project checked-start-agent"],
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
      // both roles and confirms that neither still runs.
      const failedStarts: [Partial<FakeDockerScenario>, number, string][] = [
        [{ composeUpStatus: 17 }, 17, "compose up exited 17"],
        [{ composeUpStatus: 17, composeUpCreates: ["buyer"] }, 17, "compose up exited 17"],
        [{ failsOnce: ["ps"] }, 1,
          "could not check the started containers: docker ps failed: test-only ps failure"],
        [{ failsOnce: ["container"] }, 1, "could not check the started containers: " +
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
        [{ fails: ["ps"] }, "docker ps failed: test-only ps failure"],
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
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "dacs:down and maintenance stops use the same compose file and project",
    async () => {
      const target = await generatedDockerProject("lifecycle-agent");
      const prefix = await generatedComposeArguments(target);
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
        expect(result.invocations).toEqual([[...prefix, ...compose]]);
        expect(result.composeEnvironments[0]).toMatchObject({
          COMPOSE_PROJECT_NAME: "lifecycle-agent",
          composeVariables: ["COMPOSE_PROJECT_NAME"],
        });
        // A compose that fails, or is killed by a signal, fails the command.
        for (const scenario of [
          passingDockerScenario({ fails: [`compose ${compose[0]}`] }),
          passingDockerScenario({ composeKilled: true }),
        ]) {
          const failed = await runGeneratedDockerSmoke(target, scenario, { args, env });
          expect(failed.status, `${args.join(" ")} ${JSON.stringify(scenario.fails)}`).toBe(1);
          expect(failed.invocations).toEqual([[...prefix, ...compose]]);
        }
      }
      const failed = await runGeneratedDockerSmoke(target, passingDockerScenario({
        daemonDown: true,
      }), { args: ["--down"] });
      expect(failed.status).toBe(1);
    },
    SPAWNING_TEST_TIMEOUT_MS,
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
        [{ probe: { status: "pass", uid: 10001, gid: TEST_ONLY_RUNTIME_GID } },
          `container runtime identity is not the compose user ${composeUser}`],
        [{ probe: { status: "pass", uid: TEST_ONLY_RUNTIME_UID, gid: 10001 } },
          `container runtime identity is not the compose user ${composeUser}`],
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
