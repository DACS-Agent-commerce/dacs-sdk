import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = fileURLToPath(new URL('../..', import.meta.url));

/** Modules the package ships that no import reaches: the quiet hook is registered by URL. */
export const LOADING_MODULES = ['src/wallet/demos-quiet-hooks.mjs'];

/** Modules the package ships that no entry point imports. */
const PACKED_UNREACHED_MODULES = ['src/wallet/effect-fence.mjs', 'src/wallet/effect-boundary.mjs', 'src/dacs/seller-https-connector.mjs'];

/** Package-relative paths of every module reachable from the seven entry points, plus the packed unreached modules, sorted. Throws if an import leaves `src/`. */
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
  visit('src/passive-evidence-recorder.mjs');
  visit('src/rpc-endpoint.mjs');
  visit('src/purchase/wallet-bridge.mjs');
  visit('src/wallet/effect-history-public.mjs');
  for (const path of PACKED_UNREACHED_MODULES) files.add(path);
  return [...files].sort();
}
