import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
const PACKAGE = '@kynesyslabs/dacs-seller';
const SELLER_AGENT = '@kynesyslabs/dacs-seller/src/dacs/seller-agent.mjs';

const namesIn = (list) => [...list.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
const documentedBacktickNames = (text) => [...text.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((match) => match[1]);
const isSellerSpecifier = (specifier) => specifier === PACKAGE
  || (specifier.startsWith(`${PACKAGE}/src/`)
    && !specifier.split('/').some((part) => part === '.' || part === '..'));

test('every import shown in the README resolves through the package and exports its names', async () => {
  const imports = [...readme.matchAll(/^import \{([^}]*)\} from '([^']+)';$/gm)];
  assert.ok(imports.length > 0, 'the README shows at least one import');

  for (const [, list, specifier] of imports) {
    assert.ok(isSellerSpecifier(specifier), `${specifier} is a seller package root or contained src specifier`);
    const exported = await import(specifier);
    for (const name of namesIn(list)) {
      assert.ok(name in exported, `${specifier} does not export ${name}`);
    }
  }
});

test('every package module path shown in the README resolves through package exports', async () => {
  const paths = [...readme.matchAll(/`(@kynesyslabs\/dacs-seller\/src\/[^`]+\.mjs)`/g)]
    .map((match) => match[1]);
  assert.ok(paths.length > 0, 'the README names at least one package module path');

  for (const specifier of paths) {
    assert.ok(isSellerSpecifier(specifier), `${specifier} is a contained seller src specifier`);
    const resolved = import.meta.resolve(specifier);
    assert.ok(resolved.startsWith('file:'), `${specifier} resolves to a package file`);
    const resolvedPath = fileURLToPath(resolved);
    assert.equal(statSync(resolvedPath).isFile(), true, `${specifier} resolves to an existing file`);
    assert.doesNotThrow(() => readFileSync(resolvedPath), `${specifier} is readable`);
  }
});

test('the README documents the complete set of public package root exports', async () => {
  const exported = Object.keys(await import(PACKAGE)).sort();
  const candidates = readme.split(/\n\s*\n/).map(documentedBacktickNames);
  const exportList = candidates.filter((names) =>
    names.includes('startSellerHost') && names.includes('createOperatorBuyerAccess'));
  assert.equal(exportList.length, 1, 'one README paragraph identifies the root export list by its host and buyer access exports');
  assert.deepEqual([...exportList[0]].sort(), exported);
});

test('the root exposes both host context routes and the buyer wire signer', async () => {
  const exported = await import(PACKAGE);
  for (const name of ['createSellerContextRoute', 'createWireSellerContextRoute', 'createSellerWireClientAuth']) {
    assert.equal(typeof exported[name], 'function', `the package root exports ${name}`);
  }
});

test('the seller-agent module exports createSellerAgent outside the root API', async () => {
  assert.ok(readme.includes('(`' + SELLER_AGENT + '`)'), 'the README documents the seller-agent submodule');
  const resolved = import.meta.resolve(SELLER_AGENT);
  assert.ok(resolved.startsWith('file:'), 'the documented seller-agent submodule resolves through package exports');
  assert.equal(statSync(fileURLToPath(resolved)).isFile(), true, 'the seller-agent submodule resolves to a file');
  const sellerAgent = await import(SELLER_AGENT);
  const root = await import(PACKAGE);
  assert.equal(typeof sellerAgent.createSellerAgent, 'function');
  assert.equal('createSellerAgent' in root, false);
});
