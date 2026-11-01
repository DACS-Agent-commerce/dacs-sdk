import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
const PACKAGE = '@kynesyslabs/dacs-seller';

const namesIn = (list) => [...list.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
// The package root maps to src/index.mjs and `./src/*` to the file of that path (package.json exports).
function moduleFor(specifier) {
  if (specifier === PACKAGE) return new URL('src/index.mjs', packageUrl);
  assert.ok(specifier.startsWith(PACKAGE + '/src/'), `${specifier} must be the package or one of its src/ subpaths`);
  return new URL(specifier.slice(PACKAGE.length + 1), packageUrl);
}

test('every import in the README names an export of the module it imports from', async () => {
  const imports = [...readme.matchAll(/^import \{([^}]*)\} from '([^']+)';$/gm)];
  assert.ok(imports.length > 0, 'the README shows at least one import');
  for (const [, list, specifier] of imports) {
    const exported = await import(moduleFor(specifier));
    for (const name of namesIn(list)) assert.ok(name in exported, `${specifier} does not export ${name}`);
  }
});

test('every package path the README names is a module of the package', () => {
  const paths = [...readme.matchAll(/`(@kynesyslabs\/dacs-seller\/src\/[^`]+\.mjs)`/g)].map((match) => match[1]);
  assert.ok(paths.length > 0, 'the README names at least one package path');
  for (const path of paths) assert.doesNotThrow(() => readFileSync(moduleFor(path)), `${path} exists`);
});

test('the README lists exactly the exports of the package root', async () => {
  const sentence = readme.match(/The package root exports ([^.]*)\./)?.[1];
  assert.ok(sentence, 'the README states what the root exports');
  const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
  const exported = Object.keys(await import(new URL('src/index.mjs', packageUrl))).sort();
  assert.deepEqual(listed, exported);
});

test('the package root exports the context route and its buyer-side client a host mounts and calls', async () => {
  const exported = await import(new URL('src/index.mjs', packageUrl));
  for (const name of ['createSellerContextRoute', 'createSellerContextClient']) assert.equal(typeof exported[name], 'function', `the root exports ${name}`);
});

test('the README names the module the handler agent comes from; it exports createSellerAgent and the root does not', async () => {
  assert.ok(readme.includes(`\`${PACKAGE}/src/dacs/seller-agent.mjs\``), 'the README names the seller agent module path');
  assert.equal(typeof (await import(moduleFor(`${PACKAGE}/src/dacs/seller-agent.mjs`))).createSellerAgent, 'function');
  assert.equal('createSellerAgent' in (await import(new URL('src/index.mjs', packageUrl))), false);
});

test('the README and ADMISSION.md name the context route and how a host mounts it', () => {
  const admission = readFileSync(new URL('ADMISSION.md', packageUrl), 'utf8');
  assert.match(readme, /does not mount the Vet and Agreement context route \(`createSellerContextRoute`/);
  assert.match(readme, /`context` option of\s+`createSellerHttpHandler\(agent, \{ authentication, context \}\)`/);
  assert.match(admission, /passes `createSellerContextRoute` \(a root\s+export\) as the `context` of `createSellerHttpHandler`/);
});
