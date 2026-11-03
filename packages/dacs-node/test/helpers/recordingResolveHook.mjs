import { appendFileSync } from "node:fs";
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

/**
 * Test-only module hook. Load it with `node --import <this file>` and set
 * `DACS_RESOLVE_LOG` to a file path. Every import resolution is appended as
 * `resolve <specifier>` and as one JSON line `{"specifier","parentURL"}`;
 * every module actually loaded is appended as `load <url>`. Resolving
 * `better-sqlite3` throws `ERR_MODULE_NOT_FOUND`, as in an install that
 * omitted optional dependencies, so a test can prove which specifiers an
 * import requests and that the optional SQLite driver is never needed.
 */
const REFUSED_SPECIFIER = "better-sqlite3";

function record(line) {
  appendFileSync(process.env.DACS_RESOLVE_LOG, `${line}\n`);
}

export async function resolve(specifier, context, nextResolve) {
  record(`resolve ${specifier}`);
  record(JSON.stringify({ specifier, parentURL: context.parentURL ?? null }));
  if (specifier === REFUSED_SPECIFIER) {
    const error = new Error(`Cannot find package '${REFUSED_SPECIFIER}'`);
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  record(`load ${url}`);
  return nextLoad(url, context);
}

if (isMainThread) register(import.meta.url);
