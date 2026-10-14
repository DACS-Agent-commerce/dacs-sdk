import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

// Internal CLI transport, not part of the public doctor options.
export interface DoctorSecretFile {
  source: "rpc" | "wallet";
  symlink: boolean;
  mode?: number;
  ownerUid?: number;
  currentUid?: number;
  platform: NodeJS.Platform;
}

// Match packages/dacs-node/src/secrets.ts without coupling the CLI to the host.
const MAX_SECRET_BYTES = 65_536;

class CredentialContentError extends Error {}

/**
 * Decode like the host consumer (packages/dacs-node/src/demosRuntime.ts):
 * fatal UTF-8, then trim. Malformed or blank text is unusable.
 */
export function decodeDoctorCredential(bytes: Uint8Array): string | undefined {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Inspect the descriptor actually read; filesystem errors must never expose paths. */
export function readDoctorSecretFile(
  path: string,
  source: DoctorSecretFile["source"],
): { value?: string; file: DoctorSecretFile } {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const initial = lstatSync(path);
    const context = {
      source,
      currentUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      platform: process.platform,
    };
    if (initial.isSymbolicLink()) {
      return { file: { ...context, symlink: true } };
    }
    if (!initial.isFile()) {
      throw new Error("Credential file is not regular");
    }
    // Like the host, both the pathname and descriptor snapshots must be admissible.
    if (initial.size <= 0 || initial.size > MAX_SECRET_BYTES) {
      throw new Error("Credential file is empty or too large");
    }
    // The host applies this on every platform; Windows modes are never 0600.
    const unsafe = (stat: { mode: number; uid: number }): boolean =>
      (stat.mode & 0o777) !== 0o600 ||
        (context.currentUid !== undefined && stat.uid !== context.currentUid);
    if (unsafe(initial)) {
      return { file: { ...context, symlink: false, mode: initial.mode, ownerUid: initial.uid } };
    }
    // Nonblocking open prevents a raced FIFO replacement from hanging the CLI.
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0);
    try {
      descriptor = openSync(path, flags);
    } catch (error) {
      // A symlink swapped in after lstat is a symlink failure, as on the host.
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return { file: { ...context, symlink: true } };
      }
      throw error;
    }
    const admitted = fstatSync(descriptor);
    if (!admitted.isFile() || initial.dev !== admitted.dev || initial.ino !== admitted.ino) {
      throw new Error("Credential file changed or is not regular");
    }
    const file: DoctorSecretFile = {
      ...context, symlink: false, mode: admitted.mode, ownerUid: admitted.uid,
    };
    if (unsafe(admitted)) {
      return { file };
    }
    if (admitted.size <= 0 || admitted.size > MAX_SECRET_BYTES) {
      throw new Error("Credential file is empty or too large");
    }
    bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length === 0 || length > MAX_SECRET_BYTES) {
      throw new Error("Credential file is empty or too large");
    }
    const value = decodeDoctorCredential(bytes.subarray(0, length));
    if (value === undefined) {
      throw new CredentialContentError();
    }
    return { value, file };
  } catch (error) {
    throw new Error(error instanceof CredentialContentError
      ? `Could not use ${source} credential file; it must contain non-empty UTF-8 text`
      : `Could not read ${source} credential file; check that it is a readable regular file`);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Do not expose close errors or paths.
      }
    }
  }
}
