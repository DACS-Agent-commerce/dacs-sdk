import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./validate.js";

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 4096;
// The publisher exits before a fresh Node process verifies its retained file.
// Neither process imports the host's module state or a saved qualification.
const PROBE_PROGRAM = `
const fs = require("node:fs");
const [phase, directory, temporary, published, expected] = process.argv.slice(1);
if (phase === "publish") {
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, expected); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(temporary, published);
  fs.unlinkSync(temporary);
  const dir = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
} else {
  const retained = () => {
    const fd = fs.openSync(published, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== Buffer.byteLength(expected)) process.exit(1);
      const bytes = Buffer.alloc(Buffer.byteLength(expected) + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return bytes.subarray(0, count).toString("utf8");
    } finally { fs.closeSync(fd); }
  };
  if (retained() !== expected) process.exit(1);
  fs.writeFileSync(temporary, "different", { flag: "wx", mode: 0o600 });
  try { fs.linkSync(temporary, published); process.exit(1); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (retained() !== expected) process.exit(1);
}
`;

/**
 * Qualify publication across exited and restarted processes in a validated
 * journal directory. Throws seller_replay_guard_invalid before a journal can
 * be issued if publication, retained bytes or exclusive retry fails.
 */
export function qualifyJournalRestart(directory: string): void {
  const token = randomBytes(16).toString("hex");
  const temporary = join(directory, `tmp-restart-${token}`);
  const published = join(directory, `probe-restart-${token}`);
  let primary: unknown;
  try {
    for (const phase of ["publish", "verify"]) {
      const result = spawnSync(process.execPath, ["--eval", PROBE_PROGRAM, phase, directory, temporary, published, token], {
        encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES,
      });
      if (result.error || result.status !== 0 || result.signal !== null) {
        fail("seller_replay_guard_invalid", 500, "RESTART-NOT-QUALIFIED", result.error ?? new Error(`Restart probe ${phase} failed (${result.status}, ${result.signal}): ${result.stderr.trim()}`));
      }
    }
  } catch (error) { primary = error; throw error; } finally {
    const cleanupErrors: unknown[] = [];
    for (const path of [temporary, published]) {
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      if (primary instanceof Error) Object.defineProperty(primary, "cleanupErrors", { value: cleanupErrors });
      else fail("seller_replay_guard_invalid", 500, "RESTART-NOT-QUALIFIED", new AggregateError(cleanupErrors, "Restart probe cleanup failed"));
    }
  }
}
