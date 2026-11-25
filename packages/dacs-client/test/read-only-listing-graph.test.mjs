// The core Listing validation entry, the client's pure Listing validation, the
// read-only Listing verifier entry and the public pinned chain reader load
// from packed archives with no wallet,
// purchase, sqlite or signing module anywhere in their import graph. With
// DACS_READ_ONLY_NODE20=1 (the CI Node 20.19.0 step) the test and its child
// must run on exactly v20.19.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { installPackedPair } from './helpers/packed-install.mjs';

const NODE20 = process.env.DACS_READ_ONLY_NODE20 === '1';
const NODE20_VERSION = 'v20.19.0';
const CORE = '@kynesyslabs/dacs/';
const CLIENT = '@kynesyslabs/dacs-client/';
const CLIENT_PURE = `${CLIENT}src/dacs/listing-read-only.mjs`;

const FORBIDDEN = [
  `${CORE}dist/index.js`, `${CORE}dist/crypto/index.js`, `${CORE}dist/crypto/signing.js`, `${CORE}dist/crypto/ed25519.js`,
  `${CORE}dist/artifacts/index.js`, `${CORE}dist/artifacts/signatures.js`, `${CORE}dist/agent/index.js`,
  `${CORE}dist/seller/index.js`, `${CORE}dist/rails/payDem.js`,
  `${CLIENT}src/index.mjs`, `${CLIENT}src/wallet/`, `${CLIENT}src/purchases.mjs`, `${CLIENT}src/public-admission.mjs`,
  `${CLIENT}src/signatures.mjs`, `${CLIENT}src/dacs/protocol-purchases.mjs`, `${CLIENT}src/dacs/purchase-protocol.mjs`,
  `${CLIENT}src/dacs/listing.mjs`, `${CLIENT}src/dacs/verification.mjs`,
];
const REQUIRED = [
  `${CORE}dist/listing/read-only.js`, `${CORE}dist/artifacts/validators.js`, `${CORE}dist/artifacts/signaturePredicates.js`,
  `${CORE}dist/identity/index.js`, `${CORE}dist/crypto/ed25519Verify.js`, `${CORE}dist/crypto/signedBytes.js`,
  `${CORE}dist/seller/payDemObserverReadOnly.js`, `${CORE}dist/canonical/index.js`,
  `${CLIENT}src/substrate/demos.mjs`, `${CLIENT}src/dacs/chain.mjs`, `${CLIENT}src/client-errors.mjs`,
  `${CLIENT}src/dacs/read-only-address.mjs`, CLIENT_PURE, `${CLIENT}src/dacs/directory.mjs`, `${CLIENT}src/util/http.mjs`,
];
// A module that can create or use a private key names one of these.
const SIGNING = /\b(?:createPrivateKey|privateKeyFromSeed|ed25519Sign|signArtifact|signComponentArtifact|buildComponentSignature)\b|import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*["']node:crypto["']/;
const CORE_KEYS = ['DACS_STANDARD_PIN', 'VERSION', 'canonicalize', 'contentHash', 'ed25519Verify', 'identityBundleHash', 'isIdentityBundle',
  'isListingDraft', 'isRevocationBinding', 'publicKeyFromRaw', 'signedBytes', 'validateListingArtifact'];

// The installed file an import specifier names, or null for a Node builtin.
function resolveImport(modules, from, specifier) {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
  const [scope, name, ...rest] = specifier.split('/');
  const packageDir = join(modules, scope, name);
  assert.ok(existsSync(packageDir), `${relative(modules, from)} imports ${specifier}, a package outside the read-only set`);
  const target = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).exports[['.', ...rest].join('/')];
  assert.ok(target, `${specifier} is not an export`);
  return join(packageDir, typeof target === 'string' ? target : target.import);
}

// Every installed module reachable from `entries` by static import, re-export or literal dynamic import.
function importClosure(modules, entries) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    assert.doesNotMatch(source, /\bimport\s*\(\s*[^'"\s]/, `${relative(modules, file)} has a dynamic import that cannot be followed`);
    const specifiers = source.matchAll(/(?:\b(?:import|export)\b[^'"`;]*?\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g);
    for (const [, specifier] of specifiers) {
      const target = resolveImport(modules, file, specifier);
      if (target) visit(target);
    }
  };
  entries.forEach(visit);
  return new Map([...seen].map(([file, source]) => [relative(modules, file), source]));
}

const CHILD = `
const expected = process.env.DACS_READ_ONLY_NODE20 === '1' ? '${NODE20_VERSION}' : null;
if (expected && process.version !== expected) throw new Error('expected Node ' + expected + ', running ' + process.version);
const core = await import('@kynesyslabs/dacs/listing/read-only');
const substrate = await import('@kynesyslabs/dacs-client/substrate/demos');
const pure = await import(new URL('./node_modules/${CLIENT_PURE}', import.meta.url));
const reader = substrate.createDemosPublicChainReader({ rpcUrl: 'https://rpc.invalid', network: 'testnet', pinnedIdentity: 'a'.repeat(64) });
console.log(JSON.stringify({ version: process.version, core: Object.keys(core).sort(), pure: Object.keys(pure).sort(), pinned: reader.pinnedIdentity }));
`;

// Fails when the import graph from `entries` misses a REQUIRED module or reaches a forbidden, signing or sqlite module.
function assertReadOnlyClosure(modules, entries, required) {
  const closure = importClosure(modules, entries);
  for (const path of required) assert.ok(closure.has(path), `${path} is missing from the read-only import graph`);
  for (const [path, source] of closure) {
    assert.ok(!FORBIDDEN.some((forbidden) => path.startsWith(forbidden)), `${path} is in the read-only import graph`);
    assert.doesNotMatch(source, SIGNING, `${path} in the read-only import graph can sign`);
    assert.doesNotMatch(source, /['"]node:sqlite['"]/, `${path} in the read-only import graph opens sqlite`);
  }
}

test('read-only Listing and pinned reader import graphs contain no purchase wallet signing or sqlite module', (t) => {
  if (NODE20) assert.equal(process.version, NODE20_VERSION);
  const { app } = installPackedPair(t);
  const modules = join(app, 'node_modules');
  const verifierEntry = resolveImport(modules, join(app, 'index.mjs'), `${CLIENT}listing/read-only`);
  assert.equal(relative(modules, verifierEntry), `${CLIENT}src/listing/read-only-verifier.mjs`);
  assertReadOnlyClosure(modules, [verifierEntry], [...REQUIRED, `${CLIENT}src/listing/read-only-verifier.mjs`, `${CLIENT}src/listing/read-only-limits.mjs`]);
  assertReadOnlyClosure(modules, [resolveImport(modules, join(app, 'index.mjs'), `${CLIENT}substrate/demos`)], [`${CLIENT}src/substrate/demos.mjs`, `${CLIENT}src/dacs/chain.mjs`]);
});

test('pure Listing validation and pinned reader load on Node 20.19 without signing modules', (t) => {
  if (NODE20) assert.equal(process.version, NODE20_VERSION);
  const { app } = installPackedPair(t);
  const modules = join(app, 'node_modules');

  const entries = [join(modules, CORE, 'dist/listing/read-only.js'), join(modules, CLIENT, 'src/substrate/demos.mjs'), join(modules, CLIENT_PURE)];
  assertReadOnlyClosure(modules, entries, REQUIRED);

  writeFileSync(join(app, 'load-read-only.mjs'), CHILD);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['load-read-only.mjs'], { cwd: app, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const loaded = JSON.parse(child.stdout);
  if (NODE20) assert.equal(loaded.version, NODE20_VERSION);
  assert.deepEqual(loaded.core, CORE_KEYS);
  assert.deepEqual(loaded.pure, ['DEM_RAIL', 'checkCatalogObservation', 'validateListing', 'verifyComponent']);
  assert.equal(loaded.pinned, 'a'.repeat(64));
});
