import {
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

  test("generates a guarded authority-separated live Docker bootstrap", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "live-agent");
    const result = await createDacsAgentProject({
      targetDirectory: target,
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      install: false,
    });
    expect(result).toMatchObject({
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "buyer",
      deployment: "docker",
      installed: false,
      doctor: "not-run",
    });
    expect(await filesBelow(target)).toEqual(expect.arrayContaining([
      "src/cli.ts",
      "src/doctor.ts",
      "src/service.ts",
      "test/live-bootstrap.test.ts",
      "compose.yaml",
      "Dockerfile",
    ]));
    const packageSource = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageSource.dependencies).toEqual({
      "@kynesyslabs/dacs": "0.1.0-alpha.0",
      "@kynesyslabs/dacs-node": "0.1.0-alpha.0",
      "@kynesyslabs/demosdk": "4.0.16",
      "@x402/core": "2.15.0",
      "@x402/evm": "2.15.0",
      "@x402/fetch": "2.15.0",
      "viem": "2.52.2",
    });
    expect(packageSource.scripts).toMatchObject({
      "dacs:doctor": expect.any(String),
      "dacs:doctor:funded": expect.any(String),
      "dacs:up": expect.any(String),
      "dacs:setup": expect.any(String),
      "dacs:buy": expect.any(String),
      "dacs:status": expect.any(String),
      "dacs:down": expect.any(String),
      "dacs:upgrade": expect.any(String),
    });
    const compose = await readFile(join(target, "compose.yaml"), "utf8");
    expect(compose).toContain("DACS_BUYER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_SELLER_DATA_DIRECTORY");
    expect(compose).toContain("DACS_BUYER_DEMOS_SECRET_FILE");
    expect(compose).toContain("DACS_SELLER_DEMOS_SECRET_FILE");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("DACS_RUNTIME_UID");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).not.toMatch(/(?:3306|5432|6379):/);
    const environmentExample = await readFile(join(target, ".env.example"), "utf8");
    const expectedRuntimeUid = typeof process.getuid === "function" && process.getuid() > 0
      ? process.getuid() : 10001;
    expect(environmentExample).toContain(`DACS_RUNTIME_UID=${expectedRuntimeUid}`);
    expect(environmentExample).not.toContain("DACS_SETUP_WRITE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_PURCHASE_CONFIRM");
    expect(environmentExample).not.toContain("DACS_DOCTOR_FUNDED_CONFIRM");
    const generatedConfig = await readFile(join(target, "dacs.config.ts"), "utf8");
    expect(generatedConfig).toContain("write confirmation must not be persisted in .env");
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts");
    expect(dockerfile).toContain("RUN npm rebuild better-sqlite3");
    expect(dockerfile).toContain("--mode=0755 /app");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).not.toContain("COPY . .");
    const combined = (await Promise.all(
      (await filesBelow(target)).map((file) => readFile(join(target, file), "utf8")),
    )).join("\n");
    expect(combined).not.toContain("git+");
    expect(combined).not.toContain("../../src/");
    expect(JSON.stringify(packageSource)).not.toContain("file:");
    expect(combined).toContain("reviewed-live-adapter-not-configured");
    expect(combined).toContain("DACS_SETUP_WRITE_CONFIRM=1");
    expect(combined).toContain("DACS_PURCHASE_CONFIRM=1");
    expect(combined).toContain("DACS_DOCTOR_FUNDED_CONFIRM=1");
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
    ])).toMatchObject({
      targetDirectory: "my-agent",
      mode: "live-demos",
      profile: "dacs-sdk:fixed-price-x402:v1",
      role: "seller",
      deployment: "docker",
      yes: true,
    });
  });
});
