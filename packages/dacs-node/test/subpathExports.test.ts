import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const recordingHook = pathToFileURL(
  join(packageDirectory, "test/helpers/recordingResolveHook.mjs"),
).href;
const distUrlPrefix = pathToFileURL(join(packageDirectory, "dist/")).href;

const NEW_SUBPATHS = [
  { subpath: "./public-fetch", module: "publicFetch" },
  { subpath: "./public-json", module: "publicJson" },
  { subpath: "./secrets", module: "secrets" },
] as const;
const NEW_SPECIFIERS = NEW_SUBPATHS.map(
  ({ subpath }) => `@kynesyslabs/dacs-node/${subpath.slice(2)}`,
);
const VECTOR_SECRET_CONTENT = "contracts-vector-not-a-key-0001";

interface ResolveRecord {
  readonly specifier: string;
  readonly parentURL: string | null;
}

interface ScriptRun {
  readonly result: Record<string, unknown>;
  readonly resolved: readonly ResolveRecord[];
}

describe("dacs-node subpath exports that load no SQLite", () => {
  const roots: string[] = [];

  function scratchDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-node-subpaths-"));
    roots.push(directory);
    return directory;
  }

  /**
   * Runs an ES module script in a child process started inside the package,
   * so the package's own name resolves through its export map. The script
   * prints one JSON object. With the recording hook (`runHookedScript`) the
   * log lists every resolution requested and the SQLite driver is refused.
   */
  function runScript(script: string, hookArguments: string[] = []): ScriptRun {
    const logPath = join(scratchDirectory(), "resolved.jsonl");
    writeFileSync(logPath, "");
    const child = spawnSync(
      process.execPath,
      [...hookArguments, "--input-type=module", "-e", script],
      {
        cwd: packageDirectory,
        env: { ...process.env, DACS_RESOLVE_LOG: logPath },
        encoding: "utf8",
      },
    );
    expect(child.stderr).toBe("");
    const resolved = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as ResolveRecord);
    return { result: JSON.parse(child.stdout) as Record<string, unknown>, resolved };
  }

  function runHookedScript(script: string): ScriptRun {
    return runScript(script, ["--import", recordingHook]);
  }

  function importOutcome(specifier: string): ScriptRun {
    return runHookedScript(`
      try {
        await import(${JSON.stringify(specifier)});
        console.log(JSON.stringify({ imported: true }));
      } catch (error) {
        console.log(JSON.stringify({ imported: false, code: error.code }));
      }
    `);
  }

  function requestedDriver(run: ScriptRun): boolean {
    return run.resolved.some(({ specifier }) => specifier === "better-sqlite3");
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports ./public-fetch, ./public-json and ./secrets as literal types and import pairs whose targets exist after build", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    for (const { subpath, module } of NEW_SUBPATHS) {
      const entry = {
        types: `./dist/${module}.d.ts`,
        import: `./dist/${module}.js`,
      };
      expect(manifest.exports[subpath]).toEqual(entry);
      expect(existsSync(join(packageDirectory, entry.types))).toBe(true);
      expect(existsSync(join(packageDirectory, entry.import))).toBe(true);
    }
    expect(Object.keys(manifest.exports).filter((key) => key.includes("*")))
      .toEqual([]);
  });

  it("importing ./secrets, ./public-json or ./public-fetch never requests better-sqlite3", () => {
    for (const specifier of NEW_SPECIFIERS) {
      const run = importOutcome(specifier);
      expect(run.result, specifier).toEqual({ imported: true });
      expect(requestedDriver(run), specifier).toBe(false);
    }
  });

  it("the ./sqlite subpath requests better-sqlite3 (control for the hook)", () => {
    const run = importOutcome("@kynesyslabs/dacs-node/sqlite");
    expect(requestedDriver(run)).toBe(true);
    expect(run.result).toEqual({ imported: false, code: "ERR_MODULE_NOT_FOUND" });
  });

  it("./secrets resolves only node: built-ins", () => {
    const run = importOutcome("@kynesyslabs/dacs-node/secrets");
    const fromPackage = run.resolved.filter(
      ({ parentURL }) => parentURL?.startsWith(distUrlPrefix) === true,
    );
    expect(fromPackage.length).toBeGreaterThan(0);
    for (const { specifier } of fromPackage) {
      expect(specifier).toMatch(/^node:/);
    }
  });

  it("subpath and root exports are the same objects", () => {
    const { result } = runScript(`
      const root = await import("@kynesyslabs/dacs-node");
      const secrets = await import("@kynesyslabs/dacs-node/secrets");
      const publicJson = await import("@kynesyslabs/dacs-node/public-json");
      const publicFetch = await import("@kynesyslabs/dacs-node/public-fetch");
      console.log(JSON.stringify({
        loadDacsSecretV1: secrets.loadDacsSecretV1 === root.loadDacsSecretV1,
        DacsSecretLoadError: secrets.DacsSecretLoadError === root.DacsSecretLoadError,
        readDacsPublicJsonV1: publicJson.readDacsPublicJsonV1 === root.readDacsPublicJsonV1,
        DacsPublicJsonError: publicJson.DacsPublicJsonError === root.DacsPublicJsonError,
        createDacsPublicHttpsFetchV1:
          publicFetch.createDacsPublicHttpsFetchV1 === root.createDacsPublicHttpsFetchV1,
        DacsPublicHttpsFetchError:
          publicFetch.DacsPublicHttpsFetchError === root.DacsPublicHttpsFetchError,
      }));
    `);
    expect(result).toEqual({
      loadDacsSecretV1: true,
      DacsSecretLoadError: true,
      readDacsPublicJsonV1: true,
      DacsPublicJsonError: true,
      createDacsPublicHttpsFetchV1: true,
      DacsPublicHttpsFetchError: true,
    });
  });

  it("the packed file list contains each new export target and its declaration", () => {
    const pack = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    expect(pack.status, pack.stderr).toBe(0);
    const [{ files }] = JSON.parse(pack.stdout) as [
      { files: { path: string }[] },
    ];
    const packed = new Set(files.map(({ path }) => path));
    for (const { module } of NEW_SUBPATHS) {
      expect(packed.has(`dist/${module}.js`), `${module}.js`).toBe(true);
      expect(packed.has(`dist/${module}.d.ts`), `${module}.d.ts`).toBe(true);
    }
  });

  it("deep imports outside the export map stay refused", () => {
    const run = importOutcome("@kynesyslabs/dacs-node/dist/secrets.js");
    expect(run.result).toEqual({
      imported: false,
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  });

  it("the loader imported from ./secrets loads a 0600 file and refuses a missing file with no other source", () => {
    const directory = scratchDirectory();
    const filePath = join(directory, "seller.key");
    writeFileSync(filePath, VECTOR_SECRET_CONTENT, { mode: 0o600 });
    chmodSync(filePath, 0o600);
    const missingPath = join(directory, "absent.key");
    const { result } = runScript(`
      import { loadDacsSecretV1, DacsSecretLoadError } from "@kynesyslabs/dacs-node/secrets";
      const options = { name: "dacs-seller-key", mode: "live-demos" };
      const loaded = await loadDacsSecretV1({ ...options, filePath: ${JSON.stringify(filePath)} });
      const outcome = {
        source: loaded.source,
        byteLength: loaded.bytes().byteLength,
        warningCodes: loaded.warningCodes,
      };
      loaded.destroy();
      try {
        await loadDacsSecretV1({ ...options, filePath: ${JSON.stringify(missingPath)} });
        outcome.missing = "loaded";
      } catch (error) {
        outcome.missing = error instanceof DacsSecretLoadError ? error.reasonCode : "other";
      }
      console.log(JSON.stringify(outcome));
    `);
    expect(result).toEqual({
      source: "file",
      byteLength: 31,
      warningCodes: [],
      missing: "secret-not-found",
    });
  });
});
