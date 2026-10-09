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

/** Inspect the descriptor actually read; filesystem errors must never expose paths. */
export function readDoctorSecretFile(
  path: string,
  source: DoctorSecretFile["source"],
): { value?: string; file: DoctorSecretFile } {
  let descriptor: number | undefined;
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
    const unsafe = (stat: { mode: number; uid: number }): boolean =>
      context.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 ||
        (context.currentUid !== undefined && stat.uid !== context.currentUid));
    if (unsafe(initial)) {
      return { file: { ...context, symlink: false, mode: initial.mode, ownerUid: initial.uid } };
    }
    // Nonblocking open prevents a raced FIFO replacement from hanging the CLI.
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, flags);
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
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length === 0 || length > MAX_SECRET_BYTES) {
      throw new Error("Credential file is empty or too large");
    }
    return { value: bytes.toString("utf8", 0, length).trimEnd(), file };
  } catch {
    throw new Error(`Could not read ${source} credential file; check that it is a readable regular file`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Do not expose close errors or paths.
      }
    }
  }
}
