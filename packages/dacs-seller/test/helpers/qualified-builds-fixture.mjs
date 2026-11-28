// Unshipped test helper: a second instance of src/devnet-demo/deployment-qualification.mjs whose reviewed build list (or
// packaged record directory) is the test's own. A load hook serves the module's source, with the one statement replaced,
// for one URL carrying a unique query string; every other import of the module, the shipped list included, is unchanged.
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

const MODULE_URL = new URL('../../src/devnet-demo/deployment-qualification.mjs', import.meta.url);
const BUILD_LIST_STATEMENT = /^export const QUALIFIED_NODE_BUILDS = deepFreeze\(\[$[\s\S]*?^\]\);$/gm;
const RECORD_DIRECTORY_STATEMENT = /^const RECORD_DIRECTORY = .*;$/gm;
const LOAD_HOOK = 'data:text/javascript,' + encodeURIComponent(`let served;
export async function initialize(data) { served = data; }
export async function load(url, context, nextLoad) {
  return url === served.url ? { format: 'module', source: served.source, shortCircuit: true } : nextLoad(url, context);
}`);
let instances = 0;

function replaceOnce(source, statement, replacement) {
  const found = source.match(statement) ?? [];
  if (found.length !== 1) throw new Error(`deployment-qualification.mjs must hold the statement ${statement} exactly once, not ${found.length} times`);
  return source.replace(statement, () => replacement);
}

/**
 * Imports a new instance of the qualification module with `builds` as its QUALIFIED_NODE_BUILDS and, given `recordDirectory`
 * (a directory URL), its packaged record files read from there. Rejects with the module's own load error.
 */
export async function importQualificationWith({ builds, recordDirectory } = {}) {
  let source = readFileSync(MODULE_URL, 'utf8');
  if (builds !== undefined) source = replaceOnce(source, BUILD_LIST_STATEMENT, `export const QUALIFIED_NODE_BUILDS = deepFreeze(${JSON.stringify(builds)});`);
  if (recordDirectory !== undefined) source = replaceOnce(source, RECORD_DIRECTORY_STATEMENT, `const RECORD_DIRECTORY = new URL(${JSON.stringify(recordDirectory.href)});`);
  instances += 1;
  const url = `${MODULE_URL.href}?qualified-builds=${instances}`;
  register(LOAD_HOOK, { data: { url, source } });
  return import(url);
}
