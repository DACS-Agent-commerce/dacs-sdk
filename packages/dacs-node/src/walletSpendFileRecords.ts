import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalize } from "@kynesyslabs/dacs/canonical";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMPORARY_SUFFIX = ".tmp";

function ownedByThisProcess(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/**
 * Creates the directory with mode 0700 when it is missing, then checks it.
 *
 * @throws Error `wallet-spend-file-directory-unsafe` when the path is a symlink,
 *   not a directory, not mode 0700, or not owned by this process.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o777) !== DIRECTORY_MODE) ||
      !ownedByThisProcess(metadata.uid)) {
    throw new Error("wallet-spend-file-directory-unsafe");
  }
}

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOSYS", "ENOTSUP"]);

/** Flushes a directory's entries; file systems that cannot are tolerated. */
async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

/** Writes the canonical JSON of the value to a new, fsynced temporary file next to the path. */
async function writeTemporary(path: string, value: unknown): Promise<string> {
  const temporary = `${path}.${process.pid}.${randomUUID()}${TEMPORARY_SUFFIX}`;
  try {
    const handle = await open(temporary, "wx", FILE_MODE);
    try {
      await handle.writeFile(canonicalize(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return temporary;
}

/**
 * Names in the directory that are not temporary files.
 *
 * @throws The file-system error when the directory cannot be read.
 */
export async function listRecordNames(directory: string): Promise<readonly string[]> {
  return (await readdir(directory)).filter((name) => !name.endsWith(TEMPORARY_SUFFIX));
}

/**
 * Reads one record: a private regular file of at most `maximumBytes`, valid UTF-8,
 * whose JSON text is exactly its canonical encoding.
 *
 * @returns The parsed value, or undefined when the file does not exist.
 * @throws Error `wallet-spend-file-record-damaged` on any other defect.
 */
export async function readRecord(path: string, maximumBytes: number): Promise<unknown | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o777) !== FILE_MODE) ||
      !ownedByThisProcess(metadata.uid) || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error("wallet-spend-file-record-damaged");
  }
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (bytes.length < 1 || bytes.length > maximumBytes || canonicalize(parsed) !== text) {
      throw new Error("not canonical");
    }
    return parsed;
  } catch (cause) {
    throw new Error("wallet-spend-file-record-damaged", { cause });
  }
}

/**
 * Creates the record only if the name is free. The file appears complete or not at all.
 *
 * @returns true when this call created it, false when the name already existed.
 * @throws The file-system error when writing, linking or syncing fails.
 */
export async function createRecordExclusive(path: string, value: unknown): Promise<boolean> {
  const temporary = await writeTemporary(path, value);
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(dirname(path));
  return true;
}

/**
 * Replaces the record atomically: temporary file, fsync, rename, directory fsync.
 *
 * @throws The file-system error when writing, renaming or syncing fails.
 */
export async function replaceRecord(path: string, value: unknown): Promise<void> {
  const temporary = await writeTemporary(path, value);
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Removes the record; a missing file is not an error. */
export async function removeRecord(path: string): Promise<void> {
  await rm(path, { force: true });
}
