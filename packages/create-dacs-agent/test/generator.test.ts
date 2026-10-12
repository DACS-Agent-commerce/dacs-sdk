import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface FakeDockerScenario {
  // Successive answers to `docker image inspect --format {{.Id}}`; the last repeats.
  imageIds: string[];
  daemonDown?: boolean;
  config: Readonly<Record<string, unknown>>;
  probe: Readonly<Record<string, unknown>>;
  service: Readonly<{ status: number; stderr: string }>;
}

function passingDockerScenario(
  overrides: Partial<FakeDockerScenario> = {},
): FakeDockerScenario {
  return {
    imageIds: [TEST_ONLY_FAKE_IMAGE_ID],
    config: {
      User: "10001:10001",
      WorkingDir: "/app",
      Entrypoint: null,
      Cmd: GENERATED_SERVICE_COMMAND,
    },
    probe: { status: "pass", uid: TEST_ONLY_RUNTIME_UID, gid: TEST_ONLY_RUNTIME_GID },
    service: { status: 1, stderr: GENERATED_ROLE_CHECK_REPORT + "\n" },
    ...overrides,
  };
}

const TEST_ONLY_FAKE_DOCKER_SOURCE = `const {
  appendFileSync, existsSync, readFileSync, writeFileSync,
} = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.CREATE_DACS_AGENT_TEST_DOCKER_LOG;
const scenario = JSON.parse(readFileSync(
  process.env.CREATE_DACS_AGENT_TEST_DOCKER_SCENARIO, "utf8"));
appendFileSync(log, JSON.stringify(args) + "\\n");
if (scenario.daemonDown) {
  process.stderr.write("Cannot connect to the test-only Docker daemon\\n");
  process.exit(1);
}
if (args[0] === "image" && args[1] === "inspect" && args[3] === "{{.Id}}") {
  const counter = log + ".resolutions";
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  const ids = scenario.imageIds;
  process.stdout.write(ids[Math.min(count, ids.length - 1)] + "\\n");
} else if (args[0] === "image" && args[1] === "inspect" &&
    args[3] === "{{json .Config}}") {
  process.stdout.write(JSON.stringify(scenario.config) + "\\n");
} else if (args[0] === "run" && args.includes("--entrypoint")) {
  process.stdout.write(JSON.stringify(scenario.probe) + "\\n");
} else if (args[0] === "run") {
  process.stderr.write(scenario.service.stderr);
  process.exitCode = scenario.service.status;
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
  const invocations = (await readFile(dockerLog, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const receipt = await readFile(
    join(target, ".dacs-runtime", "docker-image-smoke.json"),
    "utf8",
  ).then((source) => JSON.parse(source) as unknown, () => undefined);
  return { ...result, invocations, receipt };
}

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
    const verify = cli.indexOf(
      '["scripts/docker-runtime-smoke.mjs", "--verify-smoked"]',
    );
    expect(verify).toBeGreaterThan(cli.indexOf("await startGate()"));
    expect(verify).toBeLessThan(cli.indexOf('["compose", "up", "-d"]'));
    expect(cli).toContain("process.exitCode = smoked !== 0");

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

  test("probes the image for the exact versions the project depends on", async () => {
    const target = await generatedDockerProject("probe-version-agent");
    const dependencies = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    ).dependencies as Record<string, string>;
    const smoke = await readFile(join(target, "scripts", "docker-runtime-smoke.mjs"), "utf8");
    const probed = /'const expected = (\{[^']*\});',/.exec(smoke);
    expect(probed).not.toBeNull();
    const expected = JSON.parse(probed![1]!) as Record<string, string>;
    expect(Object.keys(expected).sort()).toEqual([
      "@kynesyslabs/dacs",
      "@kynesyslabs/dacs-node",
      "@kynesyslabs/demosdk",
      "better-sqlite3",
    ]);
    for (const [name, version] of Object.entries(expected)) {
      expect(version, name).toBe(dependencies[name]);
    }
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
      const containerOptions = [
        "run", "--rm", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--user", user,
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
    "lets dacs:up start only the image ID and user that last passed the smoke",
    async () => {
      const target = await generatedDockerProject("verified-image-agent");
      const verify = { args: ["--verify-smoked"] };
      const unsmoked = await runGeneratedDockerSmoke(target, passingDockerScenario(), verify);
      expect(unsmoked.status).toBe(5);
      expect(unsmoked.stderr).toContain("last passed dacs:image:smoke");

      expect((await runGeneratedDockerSmoke(target, passingDockerScenario())).status).toBe(0);
      const verified = await runGeneratedDockerSmoke(target, passingDockerScenario(), verify);
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        status: "verified",
        imageId: TEST_ONLY_FAKE_IMAGE_ID,
      });
      expect(verified.invocations).toHaveLength(1);

      for (const [scenario, env] of [
        [passingDockerScenario({ imageIds: [TEST_ONLY_REPLACEMENT_IMAGE_ID] }), {}],
        [passingDockerScenario(), { DACS_RUNTIME_UID: "5151" }],
        [passingDockerScenario(), { DACS_IMAGE: "another-agent:local" }],
      ] as const) {
        const refused = await runGeneratedDockerSmoke(target, scenario, { ...verify, env });
        expect(refused.status).toBe(5);
        expect(refused.stderr).toContain("rerun npm run dacs:image:smoke");
      }

      // A failed smoke withdraws the earlier pass before checking anything.
      const failed = await runGeneratedDockerSmoke(target, passingDockerScenario({
        service: { status: 0, stderr: "" },
      }));
      expect(failed.status).not.toBe(0);
      expect(failed.receipt).toBeUndefined();
      const withdrawn = await runGeneratedDockerSmoke(target, passingDockerScenario(), verify);
      expect(withdrawn.status).toBe(5);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "win32")(
    "requires the image's configured service command to load and stop at its role check",
    async () => {
      const target = await generatedDockerProject("service-command-agent");
      for (const service of [
        { status: 0, stderr: "" },
        { status: 1, stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'viem'\n" },
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
    "requires DACS_IMAGE and a non-root compose user before calling docker",
    async () => {
      const target = await generatedDockerProject("smoke-usage-agent");
      const usageErrors: SmokeOptions[] = [
        { args: ["my-agent:local"] },
        { env: { DACS_IMAGE: "" } },
        { env: { DACS_RUNTIME_UID: "0" } },
        { env: { DACS_RUNTIME_GID: "root" } },
      ];
      for (const options of usageErrors) {
        const result = await runGeneratedDockerSmoke(target, passingDockerScenario(), options);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("usage: set DACS_IMAGE and non-root");
        expect(result.invocations).toEqual([]);
      }
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
