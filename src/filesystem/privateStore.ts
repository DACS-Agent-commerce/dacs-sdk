import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { DacsError } from "../errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const WRITE_ACCESS_MASK = 0o022;
const STICKY_BIT = 0o1000;

// Network/distributed filesystems do not provide the host-local rename, link,
// lock and durability contract on which these stores rely.
const NETWORK_FILESYSTEM_MAGIC = new Set([
  0x00006969, // Linux NFS_SUPER_MAGIC
  0x01021997, // Linux V9FS_MAGIC
  0x00c36400, // Linux CEPH_SUPER_MAGIC
  0x47504653, // Linux GPFS_MAGIC
  0xfe534d42, // Linux SMB2_MAGIC_NUMBER
  0xff534d42, // Linux CIFS_MAGIC_NUMBER
]);

const NETWORK_FILESYSTEM_TYPES = new Set([
  "9p",
  "afpfs",
  "ceph",
  "cifs",
  "davfs",
  "fuse.rclone",
  "fuse.sshfs",
  "gpfs",
  "lustre",
  "nfs",
  "nfs4",
  "smb",
  "smbfs",
  "sshfs",
  "webdav",
]);

interface MountEntry {
  mountPoint: string;
  type: string;
}

let mountEntriesCache:
  | { expiresAt: number; value: Promise<readonly MountEntry[]> }
  | undefined;

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function withinPath(candidate: string, parent: string): boolean {
  const normalized = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(normalized);
}

async function loadMountEntries(): Promise<readonly MountEntry[]> {
  if (process.platform === "linux") {
    const text = await readFile("/proc/self/mountinfo", "utf8");
    return text.split("\n").flatMap((line) => {
      const separator = line.indexOf(" - ");
      if (separator < 0) return [];
      const before = line.slice(0, separator).split(" ");
      const after = line.slice(separator + 3).split(" ");
      if (before.length < 5 || after.length < 1) return [];
      return [{
        mountPoint: decodeMountPath(before[4]!),
        type: after[0]!.toLowerCase(),
      }];
    });
  }
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("/sbin/mount", [], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return stdout.split("\n").flatMap((line) => {
      const match = /^.+ on (.+) \(([^,)]+)/u.exec(line);
      return match === null
        ? []
        : [{ mountPoint: decodeMountPath(match[1]!), type: match[2]!.toLowerCase() }];
    });
  }
  return [];
}

async function filesystemType(path: string, label: string): Promise<string> {
  const now = Date.now();
  if (mountEntriesCache === undefined || mountEntriesCache.expiresAt <= now) {
    mountEntriesCache = {
      expiresAt: now + 1_000,
      value: loadMountEntries(),
    };
  }
  let entries: readonly MountEntry[];
  try {
    entries = await mountEntriesCache.value;
  } catch (error) {
    mountEntriesCache = undefined;
    throw filesystemError(label, "mount type could not be established", error);
  }
  const match = entries.filter((entry) => withinPath(path, entry.mountPoint))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  if (match === undefined) {
    throw filesystemError(label, "mount type could not be established");
  }
  return match.type;
}

const SYNC_DIRECTORY_MARKERS = new Set([
  "cloudstorage",
  "dropbox",
  "google drive",
  "googledrive",
  "icloud drive",
  "mobile documents",
  "onedrive",
]);

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

function filesystemError(label: string, reason: string, cause?: unknown): DacsError {
  return new DacsError(`${label} ${reason}`, cause === undefined ? undefined : { cause });
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function absoluteFilesystemPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw filesystemError(label, "path must be a non-empty filesystem path");
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
  // macOS exposes immutable root-owned compatibility aliases for these paths.
  // Normalize those platform aliases before applying the no-symlink policy;
  // application-controlled symlinks remain forbidden and are never resolved.
  if (process.platform === "darwin") {
    for (const [alias, physical] of [
      ["/var", "/private/var"],
      ["/tmp", "/private/tmp"],
      ["/etc", "/private/etc"],
    ] as const) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) {
        return `${physical}${absolute.slice(alias.length)}`;
      }
    }
  }
  return absolute;
}

function pathComponents(path: string): string[] {
  const root = parse(path).root;
  const tail = path.slice(root.length).split(sep).filter(Boolean);
  const result = [root];
  let current = root;
  for (const component of tail) {
    current = join(current, component);
    result.push(current);
  }
  return result;
}

function isSyncDirectory(path: string): boolean {
  return path.toLowerCase().split(/[\\/]+/u).some((component) =>
    SYNC_DIRECTORY_MARKERS.has(component) ||
    /^(?:dropbox|google ?drive|icloud drive|onedrive)(?:[ (\-]|$)/u.test(component));
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(metadata: FileIdentity): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertSingleLink(metadata: Stats, label: string, path: string): void {
  if (metadata.nlink !== 1) {
    throw filesystemError(
      label,
      `regular file has ${metadata.nlink} hard links; exactly one is required: ${path}`,
    );
  }
}

function assertPosixPolicyAvailable(label: string): number {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw filesystemError(
      label,
      "cannot establish owner and ACL safety on this platform without a platform adapter",
    );
  }
  return process.getuid();
}

function assertOwnerAndMode(
  metadata: Stats,
  label: string,
  path: string,
  currentUid: number,
  finalOwnedComponent: boolean,
): void {
  const ownerIsCurrent = metadata.uid === currentUid;
  const ownerIsSystem = metadata.uid === 0;
  if ((finalOwnedComponent && !ownerIsCurrent) || (!ownerIsCurrent && !ownerIsSystem)) {
    throw filesystemError(label, `path component has an unsafe owner: ${path}`);
  }
  if ((metadata.mode & WRITE_ACCESS_MASK) !== 0) {
    // A root-owned sticky directory (normally /tmp or /var/tmp) protects entries
    // from replacement by unrelated users and is safe as an *ancestor*. The
    // configured store root itself is never admitted with this exception.
    const protectedSystemScratch = !finalOwnedComponent && ownerIsSystem &&
      (metadata.mode & STICKY_BIT) !== 0;
    if (!protectedSystemScratch) {
      throw filesystemError(label, `path component is group/world writable: ${path}`);
    }
  }
}

async function assertExistingChain(
  path: string,
  label: string,
  finalOwnedComponent: boolean,
  allowMissingTail: boolean,
): Promise<void> {
  const currentUid = assertPosixPolicyAvailable(label);
  const components = pathComponents(path);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    let metadata;
    try {
      metadata = await lstat(component);
    } catch (error) {
      if (allowMissingTail && errno(error) === "ENOENT") return;
      throw filesystemError(label, `cannot inspect path component: ${component}`, error);
    }
    if (metadata.isSymbolicLink()) {
      throw filesystemError(
        label,
        `path is an unsafe directory because it contains a symbolic link: ${component}`,
      );
    }
    const final = index === components.length - 1;
    if (!metadata.isDirectory()) {
      throw filesystemError(label, `path component is not a directory: ${component}`);
    }
    assertOwnerAndMode(metadata, label, component, currentUid, final && finalOwnedComponent);
  }
}

async function openVerifiedDirectory(path: string, label: string) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw filesystemError(label, `path is not a safe directory: ${path}`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isDirectory() || !sameIdentity(opened, before) || !sameIdentity(opened, after)) {
      throw filesystemError(label, `directory changed while it was being opened: ${path}`);
    }
    return { handle, identity: identityOf(opened) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyDirectoryIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw filesystemError(label, `directory changed during the filesystem operation: ${path}`);
  }
}

async function assertLocalFilesystem(path: string, label: string): Promise<void> {
  if (isSyncDirectory(path)) {
    throw filesystemError(label, "must not use a consumer sync directory");
  }
  let details;
  try {
    details = await statfs(path);
  } catch (error) {
    throw filesystemError(label, "filesystem type could not be established", error);
  }
  const magic = Number(details.type) >>> 0;
  if (NETWORK_FILESYSTEM_MAGIC.has(magic)) {
    throw filesystemError(label, "must use a local filesystem");
  }
  const type = await filesystemType(path, label);
  if (NETWORK_FILESYSTEM_TYPES.has(type)) {
    throw filesystemError(label, `must use a local filesystem, not ${type}`);
  }
}

/**
 * Create and admit a private, host-local store directory.
 *
 * Every existing component is inspected with `lstat`, so a symlink anywhere in
 * the configured path is rejected. Existing components are never chmod'd into
 * acceptance: unsafe ownership or permissions fail closed. Missing components
 * are created one at a time at 0700 and immediately re-inspected.
 */
export async function preparePrivateStoreDirectory(
  requestedPath: string,
  label = "durable filesystem store",
): Promise<string> {
  const path = absoluteFilesystemPath(requestedPath, label);
  if (isSyncDirectory(path)) {
    throw filesystemError(label, "must not use a consumer sync directory");
  }
  await assertExistingChain(path, label, false, true);
  const components = pathComponents(path);
  for (let index = 1; index < components.length; index += 1) {
    const component = components[index]!;
    let created = false;
    try {
      await mkdir(component, { mode: DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        throw filesystemError(label, `cannot create private directory: ${component}`, error);
      }
    }
    await assertExistingChain(component, label, created || component === path, false);
    if (created) {
      const parent = await openVerifiedDirectory(dirname(component), label);
      try {
        await parent.handle.sync();
      } finally {
        await parent.handle.close();
      }
    }
  }
  // The root path itself may be `/` only in a malformed deployment. It cannot
  // satisfy final-owned-component admission for an unprivileged process.
  await assertExistingChain(path, label, true, false);
  await assertLocalFilesystem(path, label);
  const verified = await openVerifiedDirectory(path, label);
  await verified.handle.close();
  return path;
}

/** Read a private regular file without following a symlink at the endpoint. */
export async function readPrivateFile(
  requestedPath: string,
  encoding: BufferEncoding = "utf8",
  label = "durable filesystem file",
): Promise<string> {
  const path = absoluteFilesystemPath(requestedPath, label);
  const parent = dirname(path);
  await assertExistingChain(parent, label, true, false);
  // Keep this check in the primitive, not only directory preparation: these
  // functions are public and the mount beneath an admitted path can change.
  await assertLocalFilesystem(parent, label);
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw filesystemError(label, `path is unsafe because it is a symbolic link: ${path}`);
  }
  if (!before.isFile()) {
    throw filesystemError(label, `path is not a regular file: ${path}`);
  }
  assertSingleLink(before, label, path);
  assertOwnerAndMode(before, label, path, assertPosixPolicyAvailable(label), true);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errno(error) === "ELOOP") {
      throw filesystemError(label, `path is a symbolic link: ${path}`, error);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isFile() || !sameIdentity(opened, before) || !sameIdentity(opened, after)) {
      throw filesystemError(label, `file changed while it was being opened: ${path}`);
    }
    assertSingleLink(opened, label, path);
    assertSingleLink(after, label, path);
    const contents = await handle.readFile({ encoding });
    const finalOpened = await handle.stat();
    const finalPath = await lstat(path);
    if (!sameIdentity(finalOpened, opened) || !sameIdentity(finalPath, opened)) {
      throw filesystemError(label, `file changed while it was being read: ${path}`);
    }
    assertSingleLink(finalOpened, label, path);
    assertSingleLink(finalPath, label, path);
    return contents;
  } finally {
    await handle.close();
  }
}

/**
 * Remove a temporary only while its pathname still names the inode created by
 * this process. Node has no unlinkat-by-descriptor primitive, so the final
 * pathname unlink retains the narrow same-UID race documented in the durable
 * filesystem policy; an identity mismatch always fails closed and is left for
 * an operator to inspect.
 */
async function unlinkTemporaryIfSameIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || !sameIdentity(before, expected)) {
    throw filesystemError(
      label,
      `temporary publication changed before cleanup; refusing to remove it: ${path}`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isFile() || !sameIdentity(opened, expected) ||
        !sameIdentity(after, expected)) {
      throw filesystemError(
        label,
        `temporary publication changed before cleanup; refusing to remove it: ${path}`,
      );
    }
  } finally {
    await handle.close();
  }
  await unlink(path);
}

async function createSyncedTemporary(
  finalPath: string,
  value: string | Uint8Array,
  label: string,
): Promise<{ temporary: string; identity: FileIdentity }> {
  const temporary = join(
    dirname(finalPath),
    `.${parse(finalPath).base}.${randomBytes(24).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", FILE_MODE);
  let identity: FileIdentity | undefined;
  try {
    const created = await handle.stat();
    if (!created.isFile() || created.isSymbolicLink()) {
      throw filesystemError(label, "temporary publication is not a regular file");
    }
    assertSingleLink(created, label, temporary);
    identity = identityOf(created);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(value);
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        !sameIdentity(metadata, identity)) {
      throw filesystemError(label, "temporary publication is not a regular file");
    }
    assertSingleLink(metadata, label, temporary);
    return { temporary, identity };
  } catch (error) {
    if (identity !== undefined) {
      await unlinkTemporaryIfSameIdentity(temporary, identity, label);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function validatePublishedFile(
  path: string,
  identity: FileIdentity,
  label: string,
): Promise<void> {
  const published = await lstat(path);
  if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(published, identity)) {
    throw filesystemError(label, `published file identity is unsafe: ${path}`);
  }
  assertSingleLink(published, label, path);
  assertOwnerAndMode(published, label, path, assertPosixPolicyAvailable(label), true);
}

/**
 * Durably replace a private file using an unpredictable O_EXCL temporary,
 * fsync(file), atomic rename, endpoint identity validation and fsync(directory).
 */
export async function atomicWritePrivateFile(
  requestedPath: string,
  value: string | Uint8Array,
  label = "durable filesystem publication",
): Promise<void> {
  const path = absoluteFilesystemPath(requestedPath, label);
  const parent = dirname(path);
  await assertExistingChain(parent, label, true, false);
  await assertLocalFilesystem(parent, label);
  const directory = await openVerifiedDirectory(parent, label);
  let temporary: { path: string; identity: FileIdentity } | undefined;
  try {
    const staged = await createSyncedTemporary(path, value, label);
    temporary = { path: staged.temporary, identity: staged.identity };
    await verifyDirectoryIdentity(parent, directory.identity, label);
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw filesystemError(label, `existing publication path is unsafe: ${path}`);
      }
      assertSingleLink(existing, label, path);
      assertOwnerAndMode(existing, label, path, assertPosixPolicyAvailable(label), true);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    await rename(temporary.path, path);
    temporary = undefined;
    await validatePublishedFile(path, staged.identity, label);
    await verifyDirectoryIdentity(parent, directory.identity, label);
    await directory.handle.sync();
  } finally {
    if (temporary !== undefined) {
      await unlinkTemporaryIfSameIdentity(
        temporary.path,
        temporary.identity,
        label,
      );
    }
    await directory.handle.close();
  }
}

/**
 * Durably publish a private file only when the final path is absent. A hard
 * link is the no-overwrite commit point; EEXIST is preserved for callers.
 */
export async function exclusiveWritePrivateFile(
  requestedPath: string,
  value: string | Uint8Array,
  label = "durable filesystem exclusive publication",
): Promise<void> {
  const path = absoluteFilesystemPath(requestedPath, label);
  const parent = dirname(path);
  await assertExistingChain(parent, label, true, false);
  await assertLocalFilesystem(parent, label);
  const directory = await openVerifiedDirectory(parent, label);
  let temporary: { path: string; identity: FileIdentity } | undefined;
  try {
    const staged = await createSyncedTemporary(path, value, label);
    temporary = { path: staged.temporary, identity: staged.identity };
    await verifyDirectoryIdentity(parent, directory.identity, label);
    await link(temporary.path, path);
    // Remove our staging name before validating the retained publication so a
    // successfully returned file has exactly one link. If the temporary was
    // replaced, cleanup refuses to unlink the replacement.
    await unlinkTemporaryIfSameIdentity(temporary.path, temporary.identity, label);
    temporary = undefined;
    await validatePublishedFile(path, staged.identity, label);
    await verifyDirectoryIdentity(parent, directory.identity, label);
    await directory.handle.sync();
  } finally {
    if (temporary !== undefined) {
      await unlinkTemporaryIfSameIdentity(
        temporary.path,
        temporary.identity,
        label,
      );
    }
    await directory.handle.close();
  }
}

/** True when `candidate` is contained by `root`, without resolving symlinks. */
export function isPathWithinPrivateRoot(root: string, candidate: string): boolean {
  const from = resolve(root);
  const to = resolve(candidate);
  const suffix = relative(from, to);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}
