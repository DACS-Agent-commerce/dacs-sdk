import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { afterEach, expect, it } from "vitest";

import { LIFECYCLE_SOURCE } from "../src/lifecycleTemplate.js";

const release = JSON.parse(await readFile(
  new URL("../../../package.json", import.meta.url), "utf8",
)) as { version: string; dacs: {
  standardRevision: string; configSchemaVersion: number; sqliteSchemaVersion: number;
  supportedSqliteMigrationFrom: number[];
} };
const roots: string[] = [];

async function lifecycle(sdkVersion = release.version) {
  const root = await mkdtemp(join(tmpdir(), "dacs-lifecycle-template-"));
  roots.push(root);
  // Exercise the generated executable with release constants supplied at its
  // package boundary, including a current schema outside the migration list.
  const constants = join(root, "constants.mjs");
  await writeFile(constants, `
    export const VERSION = ${JSON.stringify(sdkVersion)};
    export const FIXED_PRICE_X402_STANDARD_REVISION = ${JSON.stringify(release.dacs.standardRevision)};
    export const DACS_NODE_CONFIG_SCHEMA_VERSION = ${release.dacs.configSchemaVersion};
    export const DACS_NODE_SQLITE_SCHEMA_VERSION = ${release.dacs.sqliteSchemaVersion};
    export const DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES = ${JSON.stringify(
      release.dacs.supportedSqliteMigrationFrom.filter((v) => v !== release.dacs.sqliteSchemaVersion),
    )};
    export function loadRoleConfig() { throw new Error("explicit paths required"); }
  `);
  const source = LIFECYCLE_SOURCE.replace(
    /from "(?:@kynesyslabs\/dacs(?:\/commerce)?|@kynesyslabs\/dacs-node(?:\/sqlite)?|\.\/config\.js)"/g,
    `from ${JSON.stringify(pathToFileURL(constants).href)}`,
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const path = join(root, "lifecycle.mjs");
  await writeFile(path, compiled);
  const api = await import(/* @vite-ignore */ pathToFileURL(path).href);
  return { root, api };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("admits the current SDK and supported schemas, refusing other SDK releases", async () => {
  const { api } = await lifecycle();
  const manifest = { release: {
    sdkVersion: release.version,
    standardRevision: release.dacs.standardRevision,
    configSchemaVersion: release.dacs.configSchemaVersion,
    sqliteSchemaVersion: release.dacs.sqliteSchemaVersion,
  } };
  expect(() => api.assertGeneratedBackupRestorableV1(manifest)).not.toThrow();
  for (const sdkVersion of ["0.0.0", "999.0.0", "invalid", ""]) {
    expect(() => api.assertGeneratedBackupRestorableV1({
      ...manifest, release: { ...manifest.release, sdkVersion },
    })).toThrow("restore-backup-release-incompatible");
  }
  for (const sqliteSchemaVersion of [0, release.dacs.sqliteSchemaVersion + 1]) {
    expect(() => api.assertGeneratedBackupRestorableV1({
      ...manifest, release: { ...manifest.release, sqliteSchemaVersion },
    })).toThrow("restore-backup-release-incompatible");
  }
  expect(() => api.assertGeneratedBackupRestorableV1({
    ...manifest, release: { ...manifest.release, sqliteSchemaVersion: 1 },
  })).not.toThrow();
});

it("rejects an authenticated backup from another SDK before replacing actor directories", async () => {
  const { root, api: current } = await lifecycle();
  const { api: previous } = await lifecycle("0.0.0");
  const paths = {
    buyer: join(root, "buyer"), seller: join(root, "seller"),
    authKeyFile: join(root, "backup-auth.hex"),
  };
  for (const directory of [paths.buyer, paths.seller]) {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "actor.sqlite"), "backup", { mode: 0o600 });
  }
  await writeFile(paths.authKeyFile, "12".repeat(32), { mode: 0o600 });
  const backupDirectory = join(root, "backup");
  const backup = await previous.createGeneratedBackupV1({ outputDirectory: backupDirectory, paths });
  for (const directory of [paths.buyer, paths.seller]) {
    await writeFile(join(directory, "actor.sqlite"), "current");
  }
  await expect(current.restoreGeneratedBackupV1({
    backupDirectory, expectedBackupId: backup.backupId,
    safetyBackupDirectory: join(root, "safety"), paths,
  })).rejects.toThrow("restore-backup-release-incompatible");
  for (const directory of [paths.buyer, paths.seller]) {
    expect(await readFile(join(directory, "actor.sqlite"), "utf8")).toBe("current");
  }
});
