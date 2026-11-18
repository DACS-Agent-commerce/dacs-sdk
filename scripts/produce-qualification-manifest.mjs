// Crash-safe, exclusive publication of qualification evidence.
//
// Every entry is published by linking a synchronized staging file to its final name. The link fails
// if the name exists, so the file system decides which of two producers wins a name, and no lock
// file is left behind by a crash. Both link outcomes synchronize the target directory, and every
// directory's parent is synchronized after the directory is ensured.
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";

const STAGING_PREFIX = ".staging-";
const INDEX_DIRECTORY = "index";
const MANIFESTS_DIRECTORY = "manifests";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A refused publication. `code` is `result_content_changed`, `evidence_sync_failed` or
 * `evidence_write_failed`; `cause` holds the file operation's own error when there is one. */
export class QualificationEvidenceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "QualificationEvidenceError";
    this.code = code;
  }
}

/** The file operations the publisher uses, bound to `node:fs/promises`. `open` returns a handle with
 * `close()`; `readFile(path, maxBytes)` returns at most `maxBytes` bytes of a regular file. */
export const nodeEvidenceFs = {
  open: (path, flags) => fsPromises.open(path, flags),
  write: (handle, bytes) => handle.writeFile(bytes),
  fsync: (handle) => handle.sync(),
  link: (existing, path) => fsPromises.link(existing, path),
  unlink: (path) => fsPromises.unlink(path),
  mkdir: (path) => fsPromises.mkdir(path),
  async readFile(path, maxBytes) {
    const handle = await fsPromises.open(path, "r");
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a regular file`);
      const buffer = Buffer.alloc(maxBytes);
      let length = 0;
      while (length < maxBytes) {
        const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  },
};

async function guarded(code, action, operation) {
  try { return await operation(); } catch (cause) {
    if (cause instanceof QualificationEvidenceError) throw cause;
    throw new QualificationEvidenceError(code, `${action} failed: ${cause.message}`, { cause });
  }
}

/**
 * Creates a publisher over the file operations `fs`. Each publisher is one invocation: its staging
 * files are `.staging-<invocationId>-<n>`, and it removes only those. Staging files of other
 * invocations may belong to a live producer and are never read, linked or removed.
 * Call `ensureDirectories` before publishing.
 */
export function createEvidencePublisher(fs, invocationId = randomUUID()) {
  let stagingCount = 0;

  async function syncDirectory(path) {
    await guarded("evidence_sync_failed", `synchronizing ${path}`, async () => {
      const handle = await fs.open(path, "r");
      try { await fs.fsync(handle); } finally { await handle.close(); }
    });
  }

  async function ensureDirectory(path) {
    await guarded("evidence_write_failed", `creating ${path}`, async () => {
      try { await fs.mkdir(path); } catch (error) { if (error.code !== "EEXIST") throw error; }
    });
    // Synchronized whether or not this run created it: an earlier run may have died before its sync.
    await syncDirectory(dirname(path));
  }

  async function writeStagingFile(directory, bytes) {
    const path = join(directory, `${STAGING_PREFIX}${invocationId}-${stagingCount++}`);
    const handle = await guarded("evidence_write_failed", `creating ${path}`, () => fs.open(path, "wx"));
    try {
      await guarded("evidence_write_failed", `writing ${path}`, () => fs.write(handle, bytes));
      await guarded("evidence_sync_failed", `synchronizing ${path}`, () => fs.fsync(handle));
    } catch (error) {
      await removeOwnFile(path);
      throw error;
    } finally { await handle.close().catch(() => {}); }
    return path;
  }

  // A file that cannot be removed is left for the manual removal in the runbook; it must not hide the
  // outcome of the publication.
  async function removeOwnFile(path) {
    await fs.unlink(path).catch(() => {});
  }

  async function linkOrReadExisting(staging, finalPath, bytes) {
    try {
      await fs.link(staging, finalPath);
      return undefined;
    } catch (cause) {
      if (cause.code !== "EEXIST") {
        throw new QualificationEvidenceError("evidence_write_failed", `linking ${finalPath} failed: ${cause.message}`, { cause });
      }
    }
    // One byte more than the new entry: an existing entry of any other length differs.
    return guarded("evidence_write_failed", `reading ${finalPath}`, () => fs.readFile(finalPath, bytes.length + 1));
  }

  async function publishExclusive(directory, name, bytes) {
    const staging = await writeStagingFile(directory, bytes);
    try {
      const existing = await linkOrReadExisting(staging, join(directory, name), bytes);
      if (existing !== undefined && !existing.equals(bytes)) return { outcome: "different", existing };
      await syncDirectory(directory);
      return { outcome: existing === undefined ? "created" : "identical" };
    } finally { await removeOwnFile(staging); }
  }

  return {
    /** Creates `<evidenceDirectory>`, its `index` and its `manifests` directory, and synchronizes each
     * parent. Throws `evidence_write_failed` or `evidence_sync_failed`. */
    async ensureDirectories(evidenceDirectory) {
      await ensureDirectory(evidenceDirectory);
      await ensureDirectory(join(evidenceDirectory, INDEX_DIRECTORY));
      await ensureDirectory(join(evidenceDirectory, MANIFESTS_DIRECTORY));
    },

    /**
     * Publishes `bytes` as `<directory>/<name>` if the name is free. Returns `{ outcome: "created" }`
     * once the name is linked and the directory synchronized; `{ outcome: "identical" }` when the name
     * holds exactly these bytes, after synchronizing the directory (another producer may have linked
     * it and not yet synchronized); or `{ outcome: "different", existing }` with the bytes already
     * there, which are left as they are. Throws `evidence_write_failed` or `evidence_sync_failed`.
     */
    publishExclusive,

    /**
     * Records that result `id` has content hash `contentSha256` in
     * `<evidenceDirectory>/index/<sha256(id)>.json`. Returns `{ outcome: "created" | "identical" }`
     * after the entry is durable. Throws `result_content_changed` when the id already holds another
     * hash, `evidence_write_failed` when the existing entry is not one this producer wrote, and
     * `evidence_sync_failed` when a synchronization fails.
     */
    async publishIndexAssociation(evidenceDirectory, id, contentSha256) {
      const name = `${createHash("sha256").update(id).digest("hex")}.json`;
      const directory = join(evidenceDirectory, INDEX_DIRECTORY);
      const result = await publishExclusive(directory, name, Buffer.from(JSON.stringify({ id, contentSha256 })));
      if (result.outcome !== "different") return result;
      const recorded = parseIndexEntry(result.existing);
      if (recorded?.id !== id || recorded.contentSha256 === contentSha256) {
        throw new QualificationEvidenceError("evidence_write_failed", `index entry ${name} is not an entry this producer wrote for the id`);
      }
      throw new QualificationEvidenceError("result_content_changed", `result ${id} is already recorded with different content`);
    },
  };
}

function parseIndexEntry(bytes) {
  try {
    const entry = JSON.parse(bytes.toString("utf8"));
    return typeof entry?.id === "string" && SHA256_HEX.test(entry.contentSha256) ? entry : undefined;
  } catch { return undefined; }
}
