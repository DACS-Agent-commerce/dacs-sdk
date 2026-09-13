export const LIFECYCLE_SOURCE = `import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { VERSION } from "@kynesyslabs/dacs";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  DACS_NODE_CONFIG_SCHEMA_VERSION,
  DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES,
} from "@kynesyslabs/dacs-node";
import { DACS_NODE_SQLITE_SCHEMA_VERSION } from "@kynesyslabs/dacs-node/sqlite";

import { loadRoleConfig } from "./config.js";

const BACKUP_SCHEMA = "dacs-generated-backup/v1" as const;
const ROLES = ["buyer", "seller"] as const;
type Role = typeof ROLES[number];

interface BackupFileV1 {
  path: string;
  bytes: number;
  sha256: string;
}

interface BackupRoleV1 {
  role: Role;
  files: readonly BackupFileV1[];
}

interface BackupManifestV1 {
  schema: typeof BACKUP_SCHEMA;
  backupId: string;
  createdAt: number;
  release: {
    sdkVersion: string;
    standardRevision: string;
    configSchemaVersion: number;
    sqliteSchemaVersion: number;
  };
  roles: readonly BackupRoleV1[];
}

const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface GeneratedLifecyclePathsV1 {
  buyer: string;
  seller: string;
  authKeyFile: string;
}

function configuredAuthKeyFile(override?: string): string {
  const authKeyFile = override ?? process.env.DACS_BACKUP_AUTH_KEY_FILE;
  if (authKeyFile === undefined || authKeyFile.trim() === "") {
    throw new Error("backup-auth-key-file-unconfigured");
  }
  return resolve(authKeyFile);
}

function paths(overrides: Partial<GeneratedLifecyclePathsV1> = {}):
Readonly<GeneratedLifecyclePathsV1> {
  return Object.freeze({
    buyer: resolve(overrides.buyer ?? loadRoleConfig("buyer").dataDirectory),
    seller: resolve(overrides.seller ?? loadRoleConfig("seller").dataDirectory),
    authKeyFile: configuredAuthKeyFile(overrides.authKeyFile),
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

async function privateDirectory(path: string, reason: string): Promise<void> {
  const observed = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new Error(reason);
  }
}

async function ownedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const observed = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isFile() || observed.isSymbolicLink() ||
      observed.size > maximumBytes ||
      (process.platform !== "win32" && (observed.mode & 0o777) !== 0o600) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new Error("backup-owned-file-unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const value = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("backup-owned-file-changed");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function authKey(path: string): Promise<Buffer> {
  const encoded = (await ownedFile(path, 256)).toString("utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error("backup-auth-key-invalid");
  }
  return Buffer.from(encoded, "hex");
}

async function safeParent(path: string): Promise<void> {
  const observed = await lstat(dirname(path));
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o022) !== 0) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new Error("backup-parent-directory-unsafe");
  }
}

function inside(value: string): boolean {
  return value === "" ||
    (!value.startsWith(".." + sep) && value !== ".." && !value.startsWith(sep));
}

function disjoint(left: string, right: string): void {
  if (inside(relative(left, right)) || inside(relative(right, left))) {
    throw new Error("backup-paths-overlap");
  }
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 &&
    !value.startsWith("/") && !value.includes("\\\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function streamFile(
  source: string,
  target?: string,
): Promise<{ bytes: number; sha256: string }> {
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const targetHandle = target === undefined ? undefined : await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile()) throw new Error("backup-source-entry-unsupported");
    const hash = createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        hash.update(chunk);
        done(null, targetHandle === undefined ? undefined : chunk);
      },
    });
    if (targetHandle === undefined) {
      await pipeline(
        createReadStream(source, { fd: sourceHandle.fd, autoClose: false }),
        counter,
      );
    } else {
      await pipeline(
        createReadStream(source, { fd: sourceHandle.fd, autoClose: false }),
        counter,
        createWriteStream(target!, { fd: targetHandle.fd, autoClose: false }),
      );
      await targetHandle.sync();
    }
    const after = await sourceHandle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        bytes !== after.size) {
      throw new Error("backup-source-file-changed");
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await Promise.allSettled([
      sourceHandle.close(),
      ...(targetHandle === undefined ? [] : [targetHandle.close()]),
    ]);
  }
}

async function copyTree(
  source: string,
  target: string,
  prefix = "",
): Promise<BackupFileV1[]> {
  await privateDirectory(source, "backup-source-directory-unsafe");
  await mkdir(target, { mode: 0o700 });
  const files: BackupFileV1[] = [];
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.includes("/") || entry.name.includes("\\\\")) {
      throw new Error("backup-source-entry-invalid");
    }
    const relativePath = prefix === "" ? entry.name : prefix + "/" + entry.name;
    const sourcePath = resolve(source, entry.name);
    const targetPath = resolve(target, entry.name);
    const observed = await lstat(sourcePath);
    if (observed.isSymbolicLink()) throw new Error("backup-source-symlink-rejected");
    if (observed.isDirectory()) {
      files.push(...await copyTree(sourcePath, targetPath, relativePath));
    } else if (observed.isFile()) {
      files.push(Object.freeze({
        path: relativePath,
        ...await streamFile(sourcePath, targetPath),
      }));
    } else {
      throw new Error("backup-source-entry-unsupported");
    }
  }
  if (prefix !== "" && files.length === 0) {
    throw new Error("backup-empty-directory-unsupported");
  }
  return files;
}

async function exclusiveText(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function manifestText(value: BackupManifestV1): string {
  return JSON.stringify(value, null, 2) + "\\n";
}

function manifestMac(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export async function createGeneratedBackupV1(input: Readonly<{
  outputDirectory: string;
  paths?: Partial<GeneratedLifecyclePathsV1>;
  now?: number;
  backupId?: string;
}>): Promise<Readonly<BackupManifestV1>> {
  const output = resolve(input.outputDirectory);
  const configured = paths(input.paths);
  const backupId = input.backupId ?? randomUUID();
  const createdAt = input.now ?? Date.now();
  if (!BACKUP_ID.test(backupId) ||
      !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("backup-identity-invalid");
  }
  if (configured.buyer === configured.seller) {
    throw new Error("backup-role-directories-shared");
  }
  await safeParent(output);
  disjoint(configured.buyer, output);
  disjoint(configured.seller, output);
  try {
    await lstat(output);
    throw new Error("backup-target-exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = output + ".staging-" + backupId;
  await mkdir(staging, { mode: 0o700 });
  try {
    const roles: BackupRoleV1[] = [];
    await mkdir(resolve(staging, "roles"), { mode: 0o700 });
    for (const role of ROLES) {
      roles.push(Object.freeze({
        role,
        files: Object.freeze(
          await copyTree(configured[role], resolve(staging, "roles", role)),
        ),
      }));
    }
    const manifest: BackupManifestV1 = Object.freeze({
      schema: BACKUP_SCHEMA,
      backupId,
      createdAt,
      release: Object.freeze({
        sdkVersion: VERSION,
        standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
        configSchemaVersion: DACS_NODE_CONFIG_SCHEMA_VERSION,
        sqliteSchemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
      }),
      roles: Object.freeze(roles),
    });
    const encoded = manifestText(manifest);
    const key = await authKey(configured.authKeyFile);
    try {
      await exclusiveText(resolve(staging, "manifest.json"), encoded);
      await exclusiveText(
        resolve(staging, "manifest.hmac"),
        manifestMac(encoded, key) + "\\n",
      );
    } finally {
      key.fill(0);
    }
    await rename(staging, output);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parsedManifest(value: unknown): BackupManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup-manifest-invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (!exactKeys(manifest, ["backupId", "createdAt", "release", "roles", "schema"]) ||
      manifest.schema !== BACKUP_SCHEMA ||
      typeof manifest.backupId !== "string" ||
      !BACKUP_ID.test(manifest.backupId) ||
      !Number.isSafeInteger(manifest.createdAt) || Number(manifest.createdAt) <= 0 ||
      !Array.isArray(manifest.roles) || manifest.roles.length !== 2) {
    throw new Error("backup-manifest-invalid");
  }
  if (manifest.release === null || typeof manifest.release !== "object" ||
      Array.isArray(manifest.release)) throw new Error("backup-manifest-invalid");
  const release = manifest.release as Record<string, unknown>;
  if (!exactKeys(release, [
    "configSchemaVersion", "sdkVersion", "sqliteSchemaVersion", "standardRevision",
  ]) || typeof release.sdkVersion !== "string" || release.sdkVersion.length === 0 ||
      release.sdkVersion.length > 128 ||
      typeof release.standardRevision !== "string" ||
      release.standardRevision.length === 0 || release.standardRevision.length > 256 ||
      !Number.isSafeInteger(release.configSchemaVersion) ||
      Number(release.configSchemaVersion) <= 0 ||
      !Number.isSafeInteger(release.sqliteSchemaVersion) ||
      Number(release.sqliteSchemaVersion) <= 0) {
    throw new Error("backup-manifest-invalid");
  }
  const roles = manifest.roles.map((roleValue) => {
    if (roleValue === null || typeof roleValue !== "object" ||
        Array.isArray(roleValue)) throw new Error("backup-manifest-invalid");
    const role = roleValue as Record<string, unknown>;
    if (!exactKeys(role, ["files", "role"]) ||
        (role.role !== "buyer" && role.role !== "seller") ||
        !Array.isArray(role.files)) throw new Error("backup-manifest-invalid");
    const files = role.files.map((fileValue) => {
      if (fileValue === null || typeof fileValue !== "object" ||
          Array.isArray(fileValue)) throw new Error("backup-manifest-invalid");
      const file = fileValue as Record<string, unknown>;
      if (!exactKeys(file, ["bytes", "path", "sha256"]) ||
          typeof file.path !== "string" || !safeRelative(file.path) ||
          !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 ||
          typeof file.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error("backup-manifest-invalid");
      }
      return Object.freeze({
        path: file.path,
        bytes: Number(file.bytes),
        sha256: file.sha256,
      });
    });
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error("backup-manifest-invalid");
    }
    return Object.freeze({ role: role.role, files: Object.freeze(files) });
  });
  if (new Set(roles.map((role) => role.role)).size !== 2) {
    throw new Error("backup-manifest-invalid");
  }
  return Object.freeze({
    schema: BACKUP_SCHEMA,
    backupId: manifest.backupId,
    createdAt: Number(manifest.createdAt),
    release: Object.freeze({
      sdkVersion: release.sdkVersion,
      standardRevision: release.standardRevision,
      configSchemaVersion: Number(release.configSchemaVersion),
      sqliteSchemaVersion: Number(release.sqliteSchemaVersion),
    }),
    roles: Object.freeze(roles),
  });
}

export async function inspectGeneratedBackupV1(input: Readonly<{
  backupDirectory: string;
  authKeyFile?: string;
}>): Promise<Readonly<BackupManifestV1>> {
  const root = resolve(input.backupDirectory);
  await privateDirectory(root, "backup-directory-unsafe");
  const rootEntries = (await readdir(root)).sort();
  if (JSON.stringify(rootEntries) !==
      JSON.stringify(["manifest.hmac", "manifest.json", "roles"])) {
    throw new Error("backup-directory-layout-invalid");
  }
  await privateDirectory(resolve(root, "roles"), "backup-directory-unsafe");
  const roleEntries = (await readdir(resolve(root, "roles"))).sort();
  if (JSON.stringify(roleEntries) !== JSON.stringify(["buyer", "seller"])) {
    throw new Error("backup-directory-layout-invalid");
  }
  const encoded = (await ownedFile(resolve(root, "manifest.json"), 1_048_576))
    .toString("utf8");
  const recorded = (await ownedFile(resolve(root, "manifest.hmac"), 256))
    .toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(recorded)) throw new Error("backup-hmac-invalid");
  const key = await authKey(configuredAuthKeyFile(input.authKeyFile));
  try {
    const expected = manifestMac(encoded, key);
    if (!timingSafeEqual(Buffer.from(recorded, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("backup-authentication-failed");
    }
  } finally {
    key.fill(0);
  }
  const manifest = parsedManifest(JSON.parse(encoded));
  for (const role of manifest.roles) {
    const actual: BackupFileV1[] = [];
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      await privateDirectory(directory, "backup-directory-unsafe");
      const beforeCount = actual.length;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = prefix === "" ? entry.name : prefix + "/" + entry.name;
        if (!safeRelative(relativePath)) throw new Error("backup-entry-invalid");
        const entryPath = resolve(directory, entry.name);
        const observed = await lstat(entryPath);
        if (observed.isSymbolicLink()) throw new Error("backup-symlink-rejected");
        if (observed.isDirectory()) await walk(entryPath, relativePath);
        else if (observed.isFile()) {
          actual.push(Object.freeze({ path: relativePath, ...await streamFile(entryPath) }));
        } else throw new Error("backup-entry-unsupported");
      }
      if (prefix !== "" && actual.length === beforeCount) {
        throw new Error("backup-empty-directory-unsupported");
      }
    };
    await walk(resolve(root, "roles", role.role));
    const expected = [...role.files].sort((a, b) => a.path.localeCompare(b.path));
    actual.sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("backup-content-mismatch");
    }
  }
  return manifest;
}

export function assertGeneratedBackupRestorableV1(
  manifest: Readonly<BackupManifestV1>,
): void {
  if (manifest.release.standardRevision !== FIXED_PRICE_X402_STANDARD_REVISION ||
      manifest.release.configSchemaVersion !== DACS_NODE_CONFIG_SCHEMA_VERSION ||
      manifest.release.sqliteSchemaVersion > DACS_NODE_SQLITE_SCHEMA_VERSION ||
      !DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES.some(
        (version) => version === manifest.release.sqliteSchemaVersion,
      )) {
    throw new Error("restore-backup-release-incompatible");
  }
}

export async function restoreGeneratedBackupV1(input: Readonly<{
  backupDirectory: string;
  expectedBackupId: string;
  safetyBackupDirectory: string;
  paths?: Partial<GeneratedLifecyclePathsV1>;
}>): Promise<Readonly<{ backupId: string; safetyBackupId: string }>> {
  const configured = paths(input.paths);
  const backupDirectory = resolve(input.backupDirectory);
  const safetyBackupDirectory = resolve(input.safetyBackupDirectory);
  disjoint(backupDirectory, safetyBackupDirectory);
  for (const role of ROLES) {
    disjoint(backupDirectory, configured[role]);
    disjoint(safetyBackupDirectory, configured[role]);
  }
  const manifest = await inspectGeneratedBackupV1({
    backupDirectory,
    authKeyFile: configured.authKeyFile,
  });
  assertGeneratedBackupRestorableV1(manifest);
  if (manifest.backupId !== input.expectedBackupId) {
    throw new Error("restore-backup-identity-mismatch");
  }
  const safety = await createGeneratedBackupV1({
    outputDirectory: safetyBackupDirectory,
    paths: configured,
  });
  const operationId = randomUUID();
  const staged: { current: string; staging: string }[] = [];
  const moved: { current: string; old: string }[] = [];
  try {
    for (const role of ROLES) {
      const current = configured[role];
      const staging = current + ".restore-" + operationId;
      staged.push({ current, staging });
      await copyTree(resolve(backupDirectory, "roles", role), staging);
    }
    for (const item of staged) {
      const old = item.current + ".replaced-" + operationId;
      await rename(item.current, old);
      moved.push({ current: item.current, old });
      await rename(item.staging, item.current);
    }
  } catch (error) {
    let rollbackIncomplete = false;
    for (const item of [...moved].reverse()) {
      try {
        await rm(item.current, { recursive: true, force: true });
        await rename(item.old, item.current);
      } catch {
        rollbackIncomplete = true;
      }
    }
    for (const item of staged) {
      try {
        await rm(item.staging, { recursive: true, force: true });
      } catch {
        rollbackIncomplete = true;
      }
    }
    if (rollbackIncomplete) {
      throw new Error("restore-rollback-incomplete", { cause: error });
    }
    throw error;
  }
  for (const item of moved) {
    await rm(item.old, { recursive: true, force: true });
  }
  return Object.freeze({
    backupId: manifest.backupId,
    safetyBackupId: safety.backupId,
  });
}
`;
