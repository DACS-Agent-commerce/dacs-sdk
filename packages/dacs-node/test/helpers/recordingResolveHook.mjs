// Test-only `node --import` hook. It appends one JSON line per module
// resolution to the file named by DACS_RESOLVE_LOG and refuses `better-sqlite3`
// with ERR_MODULE_NOT_FOUND, so a test can prove which specifiers an import
// requests and that the optional SQLite driver is never needed.
import { appendFileSync } from "node:fs";
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

const REFUSED_SPECIFIER = "better-sqlite3";

if (isMainThread) {
  register(import.meta.url, {
    data: { logPath: process.env.DACS_RESOLVE_LOG },
  });
}

let logPath;

export function initialize(data) {
  logPath = data.logPath;
}

export async function resolve(specifier, context, nextResolve) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ specifier, parentURL: context.parentURL ?? null })}\n`,
  );
  if (specifier === REFUSED_SPECIFIER) {
    throw Object.assign(
      new Error(`Cannot find package '${REFUSED_SPECIFIER}' (refused by test hook)`),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  }
  return nextResolve(specifier, context);
}
