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

it("admits only the exact creating SDK, refusing other or unparseable versions", async () => {
  const { api } = await lifecycle("1.2.3-beta.2");
  const manifest = { release: {
    sdkVersion: release.version,
    standardRevision: release.dacs.standardRevision,
    configSchemaVersion: release.dacs.configSchemaVersion,
    sqliteSchemaVersion: release.dacs.sqliteSchemaVersion,
  } };
  const withSdk = (sdkVersion: unknown) => ({
    ...manifest, release: { ...manifest.release, sdkVersion },
  });
  expect(() => api.assertGeneratedBackupRestorableV1(withSdk("1.2.3-beta.2")))
    .not.toThrow();
  for (const sdkVersion of [
    "1.2.3-beta.2+build.7", "1.2.3-beta.2+001", "1.2.3-beta.1", "1.2.2",
    "0.1.0-alpha.0", "1.2.3", "1.2.3-beta.3", "1.2.4", "2.0.0", "999.0.0",
    "invalid", "", "01.2.3", "1.2", "1.2.3-", "v1.2.3", "1.2.3\n",
    "1.2.3-01", "1.2.3-beta.01", 123, null, undefined,
  ]) {
    expect(() => api.assertGeneratedBackupRestorableV1(withSdk(sdkVersion)), String(sdkVersion))
      .toThrow("restore-backup-release-incompatible");
  }
  // Matching SDK versions must still satisfy the other release metadata.
  for (const changed of [
    { standardRevision: "another-revision" },
    { configSchemaVersion: release.dacs.configSchemaVersion + 1 },
    { sqliteSchemaVersion: 0 },
    { sqliteSchemaVersion: release.dacs.sqliteSchemaVersion + 1 },
  ]) {
    expect(() => api.assertGeneratedBackupRestorableV1({
      release: { ...manifest.release, sdkVersion: "1.2.3-beta.2", ...changed },
    })).toThrow("restore-backup-release-incompatible");
  }
  expect(() => api.assertGeneratedBackupRestorableV1({
    release: { ...manifest.release, sdkVersion: "1.2.3-beta.2", sqliteSchemaVersion: 1 },
  })).not.toThrow();
  expect(() => api.assertGeneratedBackupRestorableV1(withSdk("2.0.0")))
    .toThrow("backup created by SDK 2.0.0, running SDK 1.2.3-beta.2");
  expect(() => api.assertGeneratedBackupRestorableV1(withSdk("nope")))
    .toThrow("backup created by SDK (unparseable version), running SDK 1.2.3-beta.2");
});

async function populatedPaths(root: string) {
  const paths = {
    buyer: join(root, "buyer"), seller: join(root, "seller"),
    authKeyFile: join(root, "backup-auth.hex"),
  };
  for (const directory of [paths.buyer, paths.seller]) {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "actor.sqlite"), "backup", { mode: 0o600 });
  }
  await writeFile(paths.authKeyFile, "12".repeat(32), { mode: 0o600 });
  return paths;
}

it("restores a same-release backup into the regenerated project", async () => {
  const { root, api: current } = await lifecycle("0.2.0");
  const { api: previous } = await lifecycle("0.2.0");
  const paths = await populatedPaths(root);
  const backupDirectory = join(root, "backup");
  const backup = await previous.createGeneratedBackupV1({ outputDirectory: backupDirectory, paths });
  expect(backup.release.sdkVersion).toBe("0.2.0");
  for (const directory of [paths.buyer, paths.seller]) {
    await writeFile(join(directory, "actor.sqlite"), "regenerated");
  }
  const restored = await current.restoreGeneratedBackupV1({
    backupDirectory, expectedBackupId: backup.backupId,
    safetyBackupDirectory: join(root, "safety"), paths,
  });
  expect(restored.backupId).toBe(backup.backupId);
  for (const directory of [paths.buyer, paths.seller]) {
    expect(await readFile(join(directory, "actor.sqlite"), "utf8")).toBe("backup");
  }
});

it.each(["0.0.0", "999.0.0"])("rejects an authenticated backup from SDK %s before replacing actor directories", async (otherVersion) => {
  const { root, api: current } = await lifecycle();
  const { api: newer } = await lifecycle(otherVersion);
  const paths = await populatedPaths(root);
  const backupDirectory = join(root, "backup");
  const backup = await newer.createGeneratedBackupV1({ outputDirectory: backupDirectory, paths });
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

 it("orders arbitrarily long numeric prerelease identifiers without Number rounding", async () => {
  const { api } = await lifecycle("1.2.3-9007199254740993");
  const manifest = (sdkVersion: string) => ({ release: { ...release.dacs, sdkVersion } });
  for (const sdkVersion of ["1.2.3-9007199254740992", "1.2.3-9007199254740993", "1.2.3-999999999999999"]) {
    expect(() => api.assertGeneratedBackupRestorableV1(manifest(sdkVersion))).not.toThrow();
  }
  for (const sdkVersion of ["1.2.3-9007199254740994", "1.2.3-10000000000000000"]) {
    expect(() => api.assertGeneratedBackupRestorableV1(manifest(sdkVersion))).toThrow("restore-backup-release-incompatible");
  }
});
