import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = fileURLToPath(new URL('../..', import.meta.url));

/** Modules the package ships that no import reaches: the quiet hook is registered by URL. */
export const LOADING_MODULES = ['src/wallet/demos-quiet-hooks.mjs'];

/** Package-relative paths of every module reachable from the four entry points, sorted. Throws if an import leaves `src/`. */
export function entryPointClosure() {
  const files = new Set();
  function visit(path) {
    if (files.has(path)) return;
    assert.ok(path.startsWith('src/') && path.endsWith('.mjs'), path);
    files.add(path);
    const source = readFileSync(join(packageDir, path), 'utf8');
    for (const [, specifier] of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g)) {
      visit(relative(packageDir, resolve(packageDir, dirname(path), specifier)));
    }
  }
  visit('src/index.mjs');
  visit('src/wallet/durable-journal.mjs');
  visit('src/wallet/node-wallet-session.mjs');
  visit('src/substrate/demos.mjs');
  return [...files].sort();
}
