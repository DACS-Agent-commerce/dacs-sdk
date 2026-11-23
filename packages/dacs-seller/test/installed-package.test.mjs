// The seller package as a stranger gets it: pack the core and the seller,
// install both tarballs into a temporary application outside this repository,
// then import and host it from a clean `node` process with no test hooks.
import test, { after } from 'node:test';
import {sellerPackFiles,staleSetupReason}from'../../../scripts/prepare-seller-consumer.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// The unshipped guard loader (K11 fixture bypass); the packed archive never carries it.
const KIT_GUARD_FIXTURE_URL = new URL('./helpers/kit-guard-fixture.mjs', import.meta.url).href;
const packageDirectory = join(root, 'packages', 'dacs-seller');
// Entry modules that could not be imported without test hooks before the run-time port.
const ENTRY_MODULES = ['src/dacs/seller-transport-auth.mjs', 'src/dacs/seller-context-route.mjs', 'src/dacs/seller-http.mjs', 'src/dacs/seller-agent.mjs',
  'src/dacs/seller-durable-state.mjs', 'src/devnet-demo/artifact-anchor.mjs', 'src/dacs/commit-on-signature.mjs'];
// Shared helpers lower parts added after the package was first cut; each once went unshipped.
const ADDED_HELPERS = ['src/dacs/process-lease.mjs', 'src/devnet-demo/approval-ledger-append.mjs', 'src/util/bounded-resolution.mjs', 'src/dacs/fixture-settlement.mjs'];
// Operator-side sources that need the operator's wallet, journal or custody.
const NOT_SHIPPED = ['src/devnet-demo/operator-custody.mjs', 'src/devnet-demo/seller-issuance.mjs'];
const SELLER_BIN = 'bin/dacs-seller.mjs';
const DOCUMENTS = ['ADMISSION.md', 'LICENSE', 'PROFILE.json', 'README.md', 'SOURCES.md', 'package.json'];
const PUBLIC_API = ['SellerAgentError', 'agreementInput', 'attachIdentityPresentation', 'attachListingSignature', 'buildListingDraft', 'buildUnsignedIdentityBundle',
  'contributionVerifier', 'createDeliverableWalletJournal', 'createOperatorBuyerAccess', 'createPaymentEvidenceWalletJournal', 'createSellerAgentClient', 'createSellerAuthorityReader', 'createSellerContextRoute', 'createSellerHttpHandler',
  'createSellerTransportStore', 'createSellerWalletSession', 'createWireSellerContextRoute', 'listingPin', 'listingSigningMessage', 'startSellerHost', 'validateListing'];
// The seller's Node wallet suites.
const NODE_WALLET_TESTS = ['node-wallet-approval.test.mjs', 'node-wallet-balance.test.mjs', 'node-wallet-composition.test.mjs', 'node-wallet-payment-evidence.test.mjs', 'node-wallet-sr2-bounds.test.mjs'];
const INSTALLED_RUN_TIMEOUT_MS = 120000;
const INSTALLED_TEST_TIMEOUT_MS = 600000;

// Every source module in the checkout, package-relative.
function sourceModules() {
  const found = [];
  const walk = (dir) => { for (const entry of readdirSync(join(packageDirectory, dir), { withFileTypes: true })) { const path = dir + '/' + entry.name; if (entry.isDirectory()) walk(path); else if (path.endsWith('.mjs')) found.push(path); } };
  walk('src');
  return found.sort();
}
const shippedModules = () => sourceModules().filter((file) => !NOT_SHIPPED.includes(file));
// Specifiers a module loads: static, side-effect, re-export and literal dynamic imports.
function importSpecifiers(source) {
  const patterns = [/(?:^|[\s;}])(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"\s]+)['"]/g, /(?:^|[\s;])import\s*['"]([^'"\s]+)['"]/g, /\bimport\s*\(\s*['"]([^'"\s]+)['"]\s*\)/g];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}
// Relative specifiers a module loads, package-relative.
function relativeImports(file, source = readFileSync(join(packageDirectory, file), 'utf8')) {
  return importSpecifiers(source).filter((specifier) => /^\.{1,2}\//.test(specifier)).map((specifier) => join(dirname(file), specifier));
}
// The packages a module loads by bare specifier (Node builtins excluded).
function bareImportPackages(file) {
  return importSpecifiers(readFileSync(join(packageDirectory, file), 'utf8')).filter((specifier) => !specifier.startsWith('.') && !isBuiltin(specifier))
    .map((specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
}
// The prepared seller consumer (npm run seller:prepare), outside the repository and current for these sources.
function preparedConsumer() {
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const app = realpathSync(preparedPath);
  assert.ok(relative(root, app).startsWith('..') && isAbsolute(app), 'prepared consumer is outside the repository');
  assert.equal(staleSetupReason(app), null, 'setup must provision these exact sources, lock and runtime');
  return app;
}
// NODE_OPTIONS that load the unshipped guard loader, told where the installed guard module of `app` is; the register file goes in `work`.
function kitGuardLoaderOptions(app, work) {
  const installedGuard = pathToFileURL(realpathSync(join(app, 'node_modules', '@kynesyslabs', 'dacs-seller', 'src', 'kit-operation-guard.mjs'))).href;
  const registerLoader = join(work, 'register-kit-guard-fixture.mjs');
  writeFileSync(registerLoader, `import { registerKitGuardFixture } from ${JSON.stringify(KIT_GUARD_FIXTURE_URL)};\nregisterKitGuardFixture([${JSON.stringify(installedGuard)}]);\n`);
  return `--import=${pathToFileURL(registerLoader).href}`;
}

test('every executable seller test has one complete CLI and CI entry',()=>{
 const actual=readdirSync(join(packageDirectory,'test')).filter(name=>name.endsWith('.test.mjs')).sort();
 const listed=JSON.parse(execFileSync(process.execPath,['scripts/run-seller-tests.mjs','--list'],{cwd:root,encoding:'utf8'}));
 assert.deepEqual(listed,actual);assert.equal(new Set(listed).size,actual.length);assert.ok(listed.includes('seller-wire-client-auth.test.mjs'));
 const script=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).scripts['seller:test'];assert.equal(script,'node scripts/run-seller-tests.mjs');
 const ci=readFileSync(join(root,'.github/workflows/ci.yml'),'utf8');assert.equal((ci.match(/run: npm run seller:test/g)??[]).length,1);assert.doesNotMatch(ci,/run: node[^\n]+packages\/dacs-seller\/test\/\*/);
 assert.equal(existsSync(join(root,'test/seller/standalone.test.ts')),false);
});

test('seller manifest declares its pinned native dependency', () => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')), lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['better-sqlite3'], lock.packages['node_modules/better-sqlite3'].version);
  assert.equal(lock.packages['packages/dacs-seller'].dependencies?.['better-sqlite3'], manifest.dependencies['better-sqlite3']);
});

test('seller manifest declares @kynesyslabs/dacs-client and every bare runtime import of its shipped files', () => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')), lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const { version } = JSON.parse(readFileSync(join(root, 'packages', 'dacs-client', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@kynesyslabs/dacs-client'], version, 'the client at its exact release version');
  assert.equal(lock.packages['packages/dacs-seller'].dependencies['@kynesyslabs/dacs-client'], version);
  const declared = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)];
  for (const file of sellerPackFiles().filter((path) => path.endsWith('.mjs'))) {
    for (const name of bareImportPackages(file)) assert.ok(declared.includes(name), `${file} imports ${name}, which the manifest declares`);
  }
});

test('the Node wallet test files are in the seller:test list and in exactly one CI shard each', async () => {
  const listed = JSON.parse(execFileSync(process.execPath, ['scripts/run-seller-tests.mjs', '--list'], { cwd: root, encoding: 'utf8' }));
  const { assign } = await import('../../../scripts/ci-shards.mjs');
  const sharded = assign('seller', listed).flat();
  for (const file of NODE_WALLET_TESTS) {
    assert.ok(listed.includes(file), `${file} is in the seller:test list`);
    assert.equal(sharded.filter((name) => name === file).length, 1, `${file} runs in one CI shard`);
  }
});

test('seller manifest and lock depend on dacs-node at the release version, for the key loader', () => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')), lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const { version } = JSON.parse(readFileSync(join(root, 'packages', 'dacs-node', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@kynesyslabs/dacs-node'], version);
  assert.equal(lock.packages['packages/dacs-seller'].dependencies['@kynesyslabs/dacs-node'], version);
});

test('operator-custody.mjs stays out of the packed files and no shipped module imports it', () => {
  const packed = sellerPackFiles();
  assert.ok(!packed.includes('src/devnet-demo/operator-custody.mjs'), 'operator-custody.mjs is not packed');
  for (const file of packed.filter((path) => path.endsWith('.mjs'))) {
    assert.deepEqual(relativeImports(file).filter((target) => target.endsWith('operator-custody.mjs')), [], `${file} imports operator-custody.mjs`);
  }
});

test('the seller pack ships every source module but the operator ones, and everything each shipped module imports', () => {
  const packed = sellerPackFiles().sort();
  assert.deepEqual(packed.filter((path) => path.startsWith('src/')), shippedModules());
  assert.deepEqual(packed.filter((path) => !path.startsWith('src/')), [SELLER_BIN, ...DOCUMENTS].sort());
  for (const file of ADDED_HELPERS) assert.ok(packed.includes(file), `${file} ships`);
  for (const file of NOT_SHIPPED) assert.ok(!packed.includes(file), `${file} is not part of the package`);
  for (const path of packed) assert.doesNotMatch(path, /(?:^|\/)(?:wallet|embedded-wallet|test|port-sources)\/|operator-custody|seller-issuance/, `${path} is a run-time seller module`);
  for (const file of packed.filter((path) => path.endsWith('.mjs'))) {
    for (const target of relativeImports(file)) {
      assert.ok(existsSync(join(packageDirectory, target)), `${file} imports ${target}, which exists`);
      assert.ok(packed.includes(target), `${file} imports ${target}, which ships`);
    }
  }
});

test('the seller-effect-routes module ships: the manifest lists every local runtime import and a clean packed install imports seller-http with no source-tree fallback', () => {
  const effectRoutes = 'src/dacs/seller-effect-routes.mjs', packed = sellerPackFiles();
  assert.ok(packed.includes(effectRoutes), `${effectRoutes} ships`);
  for (const file of ['src/dacs/seller-http.mjs', 'src/dacs/seller-wire-requests.mjs', effectRoutes]) {
    for (const target of relativeImports(file)) assert.ok(packed.includes(target), `${file} imports ${target}, which ships`);
  }
  assert.ok(relativeImports('src/dacs/seller-http.mjs').includes(effectRoutes), 'seller-http imports the module');
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const installed = join(realpathSync(preparedPath), 'node_modules', '@kynesyslabs', 'dacs-seller');
  assert.ok(existsSync(join(installed, effectRoutes)), 'the installed package holds the module');
  const probe = `const http = await import(${JSON.stringify(pathToFileURL(join(installed, 'src/dacs/seller-http.mjs')).href)});
    const routes = await import(${JSON.stringify(pathToFileURL(join(installed, effectRoutes)).href)});
    console.log(JSON.stringify({ handler: typeof http.createSellerHttpHandler, rows: Object.keys(routes.SELLER_EFFECT_ROUTES).length }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: realpathSync(preparedPath), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { handler: 'function', rows: 6 });
});

test('the packed seller ships the dacs-seller bin, the CLI modules and durable-file.mjs, and the installed bin prints usage', () => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { 'dacs-seller': './' + SELLER_BIN });
  const packed = sellerPackFiles();
  for (const file of [SELLER_BIN, 'src/cli/main.mjs', 'src/cli/config.mjs', 'src/cli/init.mjs', 'src/devnet-demo/durable-file.mjs']) assert.ok(packed.includes(file), file);
  const app = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(app, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  assert.equal(staleSetupReason(app), null, 'setup must provision these exact sources, lock and runtime');
  const child = spawnSync(join(app, 'node_modules', '.bin', 'dacs-seller'), ['--help'], {
    cwd: app, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, env: { PATH: process.env.PATH },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /Usage: dacs-seller/);
  assert.match(child.stdout, /--data-dir/);
});

test('the packed bin runs init on the running Node, and the identity entry it imports loads no SQLite', t => {
  const app = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(app, 'prepare a locked installed consumer');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-installed-init-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [join(app, 'node_modules', '.bin', 'dacs-seller'), 'init', '--data-dir', join(work, 'seller')], {
    cwd: app, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^claim: did:demos:agent:[0-9a-f]{64}\naddress: (?:0x)?[0-9a-f]{64}\n$/);
  assert.equal(child.stderr, '');
  assert.deepEqual(readdirSync(join(work, 'seller')).sort(), ['seller-key.json', 'seller.json']);
  const probe = `import { createRequire } from 'node:module';
    const { generateWalletMnemonic, deriveWalletIdentity } = await import('@kynesyslabs/dacs-seller/src/cli/node-identity.mjs');
    await deriveWalletIdentity(await generateWalletMnemonic());
    process.stdout.write(JSON.stringify(Object.keys(createRequire(import.meta.url).cache).filter(path => /sqlite/i.test(path))));`;
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: app, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, env: { PATH: process.env.PATH } });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, '[]');
});

test('P10-T15 the packed archive contains no authority fixture', () => {
  const packed = sellerPackFiles().sort();
  assert.deepEqual(packed.filter((path) => /authority-fixture/.test(path)), []);
  for (const file of ['src/dacs/bounded-call.mjs', 'src/dacs/kit-data-format.mjs', 'src/dacs/seller-wire-requests.mjs']) assert.ok(packed.includes(file), `${file} ships`);
});

test('no EB test double or authority fixture ships in the packed kit', () => {
  const packed = sellerPackFiles().sort();
  const effectModules = ['src/dacs/effect-boundary.mjs', 'src/dacs/effect-history.mjs', 'src/devnet-demo/durable-file.mjs'];
  for (const file of effectModules) assert.ok(packed.includes(file), `${file} ships`);
  assert.deepEqual(packed.filter((path) => /authority-fixture|effect-boundary-fixture|kit-guard-fixture|(?:^|\/)test\//.test(path)), []);
  for (const file of effectModules) {
    assert.deepEqual(relativeImports(file).filter((target) => /(?:^|\/)test\//.test(target)), [], `${file} imports no test module`);
    assert.doesNotMatch(readFileSync(join(packageDirectory, file), 'utf8'), /setKitOperationGuardForTest|authority-fixture|effect-boundary-fixture/, `${file} names no test setter or fixture`);
  }
});

test('the import scan sees static, side-effect, re-export and literal dynamic imports', () => {
  const probe = "import { a } from './dacs/a.mjs';\nimport './dacs/b.mjs';\nexport { c } from \"../c.mjs\";\nconst d = await import('./util/d.mjs');\n";
  assert.deepEqual(relativeImports('src/probe.mjs', probe).sort(), ['c.mjs', 'src/dacs/a.mjs', 'src/dacs/b.mjs', 'src/util/d.mjs']);
});

test('the packed host test passes with the wire buyer helper; the packed seller installs outside the repository, refuses to start while its guard is off, and serves one Listing only under the unshipped fixture loader', { timeout: INSTALLED_TEST_TIMEOUT_MS }, () => {
  const manifestPath = join(packageDirectory, 'package.json');
  assert.ok(existsSync(manifestPath), 'packages/dacs-seller/package.json is the package manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const core = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@kynesyslabs/dacs-seller');
  assert.equal(manifest.private, true, 'the fixture kit cannot be published independently of its unreleased core peer');
  assert.equal(manifest.version, core.version);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.exports, { '.': './src/index.mjs', './src/*': './src/*', './package.json': './package.json', './PROFILE.json': './PROFILE.json' });
  assert.equal(manifest.engines.node,core.engines.node);
  assert.equal(manifest.peerDependencies['@kynesyslabs/dacs'], core.version);
  assert.ok(existsSync(join(root, 'dist', 'index.js')), 'the core is built (npm run build) before it is packed');
  assert.equal(manifest.exports['./PROFILE.json'], './PROFILE.json');
  const { app, sellerPack, refused, out, loaderOptions } = packedHostRun();

  // Exactly the shipped modules, the bin, the governing documents, the manifest, README and LICENSE.
  const packed = sellerPack.files.map((entry) => entry.path).sort();
  assert.deepEqual(packed, [...shippedModules(), SELLER_BIN, ...DOCUMENTS].sort());
  for (const file of ENTRY_MODULES) assert.ok(packed.includes(file), `${file} is shipped`);

  assert.ok(!existsSync(join(app,'node_modules','@kynesyslabs','dacs-seller','test')),'test files are not shipped');
  assert.deepEqual(refused.environment, { execArgv: [], nodeOptions: null });
  assert.deepEqual(refused.guardOff, { guard: 'off', start: { name: 'KitOperationGuardError', code: 'kit_operation_guard_off', entry: 'startSellerHost' } }, 'the packed host refuses to start while its guard is off');
  assert.equal(refused.imports, undefined, 'a refused start goes no further');
  assertInstalledRun(out, loaderOptions);
});

// The packed host test, run once in the prepared consumer outside the repository and shared by the tests that read it: first
// in a clean child with the kit guard off, then the same install under the unshipped fixture loader. Returns
// `{ app, sellerPack, refused, out, loaderOptions }`, `refused` and `out` being the two runs' reports.
let packedHostResult = null, packedHostWork = null;
after(() => { if (packedHostWork !== null) rmSync(packedHostWork, { recursive: true, force: true }); });
function packedHostRun() {
  if (packedHostResult !== null) return packedHostResult;
  const work = packedHostWork = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-installed-')));
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const app = realpathSync(preparedPath);
  assert.ok(relative(root, app).startsWith('..') && isAbsolute(app), 'prepared consumer is outside the repository');
  assert.equal(staleSetupReason(app), null, 'setup must provision these exact sources, lock and runtime');
  for (const helper of ['wire-buyer.mjs', 'wire-authority-fixture.mjs', 'signed-buyer-driver.mjs']) {
    writeFileSync(join(app, helper), readFileSync(new URL(`./helpers/${helper}`, import.meta.url)));
  }
  const { sellerPack } = JSON.parse(readFileSync(join(app, 'prepared.json'), 'utf8'));
  // A clean child: no inherited flags, loaders, hooks or NODE_OPTIONS.
  const env={PATH:process.env.PATH,TMPDIR:work,NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_CACHE:join(work,'empty-npm-cache')};mkdirSync(env.NPM_CONFIG_CACHE);
  const runInstalled = (environment) => {
    const result = spawnSync(process.execPath, ['run.mjs'], { cwd: app, env: environment, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `installed seller run failed\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const refused = runInstalled(env);
  // The same install under the unshipped loader, told where the installed guard module is.
  const loaderOptions = kitGuardLoaderOptions(app, work);
  const out = runInstalled({ ...env, NODE_OPTIONS: loaderOptions });
  packedHostResult = { app, sellerPack, refused, out, loaderOptions };
  return packedHostResult;
}

// What the packed host run under the fixture loader reported, checked as the packed host test always has.
function assertInstalledRun(out, loaderOptions) {
  assert.deepEqual(out.environment, { execArgv: [], nodeOptions: loaderOptions });
  assert.equal(out.guardOff, undefined, 'under the loader the installed guard admits');
  assert.equal(out.packageRoot, join('node_modules', '@kynesyslabs', 'dacs-seller'));
  assert.deepEqual(out.imports.filter((entry) => !entry.loaded), [], 'every installed module imports');
  assert.deepEqual(out.imports.map((entry) => entry.file).sort(), shippedModules());
  for (const file of ENTRY_MODULES) assert.ok(out.imports.some((entry) => entry.file === file && entry.loaded), `${file} loads`);
  assert.deepEqual(out.exports, PUBLIC_API);
  assert.deepEqual(out.subpath, { artifactAnchor: 'function', contextRoute: 'function' }, 'kit modules resolve by package subpath');

  assert.match(out.refusedConfigurations.missingAgreementAnchor, /^TypeError: .*agreementAnchor/);
  assert.match(out.refusedConfigurations.missingDelivery, /^TypeError: .*requires nativeDemDelivery$/, 'the host starts only with the whole chain to delivery');
  assert.match(out.refusedConfigurations.missingRailAuthority, /^TypeError: .*requires railAuthority$/, 'the host selects its rail only from the steward-signed definition');
  assert.match(out.refusedConfigurations.missingSessionAdmission, /^TypeError: .*requires sessionAdmission$/, 'the host opens sessions only under the seller\'s session admission');
  assert.match(out.refusedConfigurations.missingJournal, /^TypeError: .*requires reconcilePaymentEvidence$/, 'the host takes payment only with the wallet journal\'s question, so a paid order always has a way on');
  assert.match(out.refusedConfigurations.missingReadCommitmentReceipt, /requires readCommitmentReceipt/);
  assert.match(out.refusedConfigurations.invalidReadCommitmentReceipt, /readCommitmentReceipt must be a function/);
  assert.match(out.refusedConfigurations.publicInterface, /^TypeError: .*loopback/);
  assert.match(out.refusedConfigurations.unknownOption, /^TypeError: .*anchors/);
  assert.match(out.refusedConfigurations.relativeDirectory, /^TypeError: .*dataDirectory/);
  assert.match(out.refusedConfigurations.otherSigner, /does not control this Listing/);
  assert.equal(out.deliverableJournal.guarded, null, 'the packed host starts with the Deliverable journal\'s guarded submit and its resume');
  assert.match(out.deliverableJournal.unguarded, /^TypeError: resumeDeliverableCreate/, 'and refuses its resume beside a capability with no guarded submit');
  assert.match(out.refusedConfigurations.scriptedJournal, /^TypeError: .*only from one createPaymentEvidenceWalletJournal/, 'the answers that allow a second evidence signature come only from the package wallet journal');
  assert.match(out.refusedConfigurations.scriptedAgent, /^TypeError: .*only from one createPaymentEvidenceWalletJournal/, 'an agent the operator composes takes them only from the package wallet journal too');

  assert.equal(out.host.origin.startsWith('http://127.0.0.1:'), true);
  assert.deepEqual(out.host.timeouts, { headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 });
  assert.deepEqual(out.proposal, { disposition: 'complete', role: 'seller', signer: out.sellerClaim });
  assert.equal(out.agreement.hash, out.agreement.expected, 'the buyer finalizes the Agreement with the seller contribution');
  assert.deepEqual(out.agreement.listingRef, out.host.listingPin, 'the Agreement names the served Listing');
  assert.equal(out.repeatSameContribution, true);
  assert.equal(out.stateSameContribution, true);
  // A request for another Listing opens no bootstrap scope, so the wire refuses it at its participant check, unsigned.
  assert.deepEqual(out.refusals.otherListingPin, { name: 'SellerUnavailableError', code: 'seller_unavailable', status: null });
  assert.deepEqual(out.refusals.unsigned, { status: 401, body: { error: 'peer_envelope_invalid', message: 'peer_envelope_invalid' } });
  assert.notEqual(out.refusals.unvettedProposal.disposition, 'complete', 'a proposal over synthetic Vet references is not signed');
  assert.equal(out.refusals.unvettedProposal.contribution, null);
  assert.notEqual(out.refusals.fabricatedVetProposal.disposition, 'complete', 'a Vet reference no record backs is not signed');
  assert.equal(out.refusals.fabricatedVetProposal.contribution, null);
  assert.deepEqual(out.refusals.replayedPresentation, { name: 'SellerRefusedError', code: 'context_admission_closed', status: 409 }, 'a proposal is taken only for a job whose context request was admitted');
  assert.equal(out.refusals.bareNoNonce, true);
  assert.deepEqual(out.refusals.missingNonce, { status: 409, body: { error: 'context_challenge_mismatch', message: 'context_challenge_mismatch' } }, 'DACS-1 §6.3.2: a context request whose presentation carries no session nonce is refused');
  assert.deepEqual(out.issuedChallenge, { nonce: true, lifetimeMs: 600000 }, 'the installed host issues a fresh 256-bit challenge on its wire route, with its lifetime');
  assert.equal(out.presentsIssuedChallenge, true, 'the buyer presents the random challenge the host issued through the public builder');
  assert.deepEqual(out.refusals.contextChallenge, { status: 401, body: { error: 'peer_envelope_invalid', message: 'peer_envelope_invalid' } }, 'the challenge route is mounted and refuses an unsigned request');
  for (const attempt of [out.refusals.secondHostSameDirectory, out.refusals.secondProcessSameDirectory]) {
    assert.match(attempt, /^Error: seller state directory is in use by another live operator process/, 'one live host owns the state');
  }
  assert.deepEqual(out.restart, { stateSameContribution: true, repeatSameContribution: true });
  assert.deepEqual(out.reached, [], 'negotiation reached no operator capability but the Vet context');
  assert.deepEqual(out.vetContextJobs, ['vetted', 'unvetted', 'fabricated'], 'every admitted proposal takes its Agreement input from the Vet context');
  assert.deepEqual(out.admittedJobs, ['vetted', 'unvetted', 'fabricated'], 'every context request over an issued challenge asks the session admission; the replayed job has none, so the seller refuses its proposal before asking');
}

test('packed and installed outside the checkout, the kit contains src/dacs/authority-reader.mjs and every helper it imports, ships no enrollment fixture or test loader, and its installed host composition runs the installed reader against a bounded offline transport', { timeout: INSTALLED_TEST_TIMEOUT_MS }, () => {
  const packed = sellerPackFiles();
  // The reader, the stages that compose it and every module either reaches, followed through relative imports.
  const reached = new Set(), pending = ['src/dacs/authority-reader.mjs', 'src/dacs/host-stages.mjs'];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...relativeImports(file));
  }
  for (const file of ['src/dacs/authority-reader.mjs', 'src/dacs/bootstrap-scope.mjs', 'src/dacs/host-stages.mjs']) assert.ok(reached.has(file), `${file} is reached`);
  for (const file of reached) assert.ok(packed.includes(file), `${file} ships`);
  assert.deepEqual(packed.filter((path) => /kit-wallet-session|authority-fixture|kit-guard-fixture|(?:^|\/)test\//.test(path)), [], 'no enrollment fixture, authority fixture or test loader ships');
  const { app, out } = packedHostRun();
  const installed = join(app, 'node_modules', '@kynesyslabs', 'dacs-seller');
  for (const file of reached) assert.ok(existsSync(join(installed, file)), `${file} is installed`);
  assert.equal(out.hostError, undefined, JSON.stringify(out.hostError));
  assert.deepEqual(out.authority, { readBuyer: true, withdrawn: { status: 500, body: { error: 'tp1_participant_profile_mismatch', message: 'tp1_participant_profile_mismatch' } } },
    'the installed host read the buyer\'s enrollment, and refuses its signed request once that enrollment is withdrawn');
});

test('from the packed archive with no hooks, a key opened while off yields its claim, and its returned sign refuses kit_operation_guard_off with zero cryptographic signer calls. (Round 4.) Its read-only role, given no current binding, signs nothing', { timeout: INSTALLED_TEST_TIMEOUT_MS }, (t) => {
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const app = realpathSync(preparedPath);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-key-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const script = `
    import crypto from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    // Custody refuses Node outside ^22.22.2 || ^24.15.0; on another Node, report a supported version.
    const [major, minor, patch] = process.version.slice(1).split('.').map(Number);
    if (!((major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15))) Object.defineProperty(process, 'version', { value: 'v22.22.2', configurable: true });
    let signs = 0;
    const realSign = crypto.sign;
    crypto.sign = (...args) => { signs += 1; return realSign(...args); };
    syncBuiltinESMExports();
    const { openSellerKey } = await import('@kynesyslabs/dacs-seller/src/seller-key.mjs');
    const { KIT_OPERATION_GUARD } = await import('@kynesyslabs/dacs-seller/src/kit-operation-guard.mjs');
    const seed = Buffer.alloc(32, 2);
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    const claim = 'did:demos:agent:' + publicKey.toString('hex');
    const dataDirectory = process.argv[1];
    const filePath = join(dataDirectory, 'seller.key');
    writeFileSync(filePath, JSON.stringify({ format: 'dacs-seller-key/v1', algorithm: 'ed25519', mnemonic: 'TEST mnemonic' }), { mode: 0o600 });
    const key = await openSellerKey({ filePath, dataDirectory, keyFormat: 'dacs-seller-key/v1', listingSeller: claim, validateMnemonic: (value) => value === 'TEST mnemonic',
      derive: async () => ({ claim, ed25519PrivateKey: new Uint8Array(Buffer.concat([seed, publicKey])), cleanup() {} }) });
    const codeOf = async (run) => { try { await run(); return null; } catch (error) { return error.code; } };
    const effect = await codeOf(() => key.sign(Buffer.from('bytes')));
    const readOnly = await codeOf(() => key.readOnlyAnswerSigner({ purpose: 'discovery', binding: undefined, local: undefined }));
    key.close();
    process.stdout.write(JSON.stringify({ claim: key.claim === claim, effect, readOnly, signs, guard: KIT_OPERATION_GUARD, nodeOptions: process.env.NODE_OPTIONS ?? null }) + '\\n');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, work], { cwd: app, env: { PATH: process.env.PATH, TMPDIR: work }, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `the packed key custody run failed\n${child.stdout}\n${child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { claim: true, effect: 'kit_operation_guard_off', readOnly: 'seller_key_role_refused', signs: 0, guard: 'off', nodeOptions: null });
});

test('importing every ./src/* path from the packed archive yields no guard bypass', { timeout: INSTALLED_TEST_TIMEOUT_MS }, (t) => {
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const app = realpathSync(preparedPath);
  const { sellerPack } = JSON.parse(readFileSync(join(app, 'prepared.json'), 'utf8'));
  const packed = sellerPack.files.map((entry) => entry.path).sort();
  assert.ok(packed.includes('src/kit-operation-guard.mjs'), 'the guard ships');
  assert.deepEqual(packed.filter((path) => /fixture|loader|hook/i.test(path) && path.startsWith('test')), [], 'no loader ships');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-guard-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const script = `
    const bypasses = [];
    for (const file of ${JSON.stringify(packed.filter((path) => path.startsWith('src/') && path.endsWith('.mjs')))}) {
      const namespace = await import('@kynesyslabs/dacs-seller/' + file);
      for (const name of Object.keys(namespace)) if (/kitoperation|operationguard|fortest|bypass/i.test(name) && !file.endsWith('kit-operation-guard.mjs')) bypasses.push(file + ':' + name);
    }
    const guard = await import('@kynesyslabs/dacs-seller/src/kit-operation-guard.mjs');
    process.stdout.write(JSON.stringify({ bypasses, exports: Object.keys(guard).sort(), guard: guard.KIT_OPERATION_GUARD, admitted: guard.kitOperationAdmitted(), nodeOptions: process.env.NODE_OPTIONS ?? null }) + '\\n');`;
  const env = { PATH: process.env.PATH, TMPDIR: work };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: app, env, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `importing the packed modules failed\n${child.stdout}\n${child.stderr}`);
  const answer = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(answer, { bypasses: [], exports: ['KIT_OPERATION_GUARD', 'KitOperationGuardError', 'assertKitOperationAdmitted', 'kitOperationAdmitted'], guard: 'off', admitted: false, nodeOptions: null });
});

// Runs `script` as a module in a child in `app` with only PATH, TMPDIR and `nodeOptions`, and returns the JSON of its last stdout line.
function runInConsumer(app, work, script, { nodeOptions, args = [] } = {}) {
  const env = { PATH: process.env.PATH, TMPDIR: work, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: app, env, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `the consumer child failed\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

// The start of a consumer child's script: the client's documented hold seam (its hook and double, copied beside the child) lifts
// the hold, the client is imported where the installed seller resolves it, and the client fixture's own scripted node (its source
// copied in) answers an owner bound through the installed wire.
function consumerWalletPrelude(app) {
  for (const name of ['purchase-admission-hook.mjs', 'purchase-admission-double.mjs', 'payment-evidence-approval-double.mjs']) {
    cpSync(new URL(`../../dacs-client/test/helpers/${name}`, import.meta.url), join(app, name));
  }
  const fixture = readFileSync(new URL('../../dacs-client/test/helpers/tp1-node-fixture.mjs', import.meta.url), 'utf8');
  const scriptedNode = fixture.slice(fixture.indexOf('export function scriptedNode()'), fixture.indexOf('export async function world')).replace('export ', '');
  return `import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    import { installPurchaseAdmissionHook, loadAdmissionDouble } from './purchase-admission-hook.mjs';
    installPurchaseAdmissionHook(); (await loadAdmissionDouble()).setPurchaseAdmission('testnet-tp1');
    const fromSeller = createRequire(realpathSync('node_modules/@kynesyslabs/dacs-seller/package.json'));
    const clientEntry = realpathSync(fromSeller.resolve('@kynesyslabs/dacs-client/node-wallet'));
    const client = await import(pathToFileURL(clientEntry).href);
    const { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } = await import('@kynesyslabs/dacs/wire');
    const T0 = 1793102400000, ok = response => ({ result: 200, response, require_reply: false, extra: null });
    ${scriptedNode}
    const node = scriptedNode(), owner = client.createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: node.fetch });
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: async scope => ({ local: scope.local,
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-installed-authority', sessionId: scope.sessionId, participants: [] }) });
    const admission = { binding, currentLocal: owner.currentLocal };
  `;
}

test('the packed seller, client and dacs-node install outside the repository and import the Node composition without test hooks', { timeout: INSTALLED_TEST_TIMEOUT_MS }, (t) => {
  const app = preparedConsumer(), work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-wallet-import-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const { clientPack } = JSON.parse(readFileSync(join(app, 'prepared.json'), 'utf8'));
  assert.ok(clientPack.files.some((entry) => entry.path === 'src/wallet/node-wallet-session.mjs'), 'the packed client holds the Node composition');
  for (const name of ['dacs-seller', 'dacs-client', 'dacs-node']) {
    assert.ok(realpathSync(join(app, 'node_modules', '@kynesyslabs', name)).startsWith(join(app, 'node_modules') + '/'), `${name} is installed in the consumer, not linked to the repository`);
  }
  const answer = runInConsumer(app, work, `import { createRequire } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const wallet = await import('@kynesyslabs/dacs-seller/src/devnet-demo/seller-node-wallet.mjs');
    const clientEntry = realpathSync(createRequire(realpathSync('node_modules/@kynesyslabs/dacs-seller/package.json')).resolve('@kynesyslabs/dacs-client/node-wallet'));
    const client = await import(pathToFileURL(clientEntry).href);
    console.log(JSON.stringify({ factory: typeof wallet.createSellerNodeWallet, composition: typeof client.createNodeSellerComposition, clientEntry,
      hooks: process.execArgv.filter(arg => /^--(?:import|loader|experimental-loader|require)\\b/.test(arg)), nodeOptions: process.env.NODE_OPTIONS ?? null }));`);
  assert.deepEqual({ ...answer, clientEntry: relative(app, answer.clientEntry) }, { factory: 'function', composition: 'function',
    clientEntry: join('node_modules', '@kynesyslabs', 'dacs-client', 'src', 'wallet', 'node-wallet-session.mjs'), hooks: [], nodeOptions: null });
});

test('in a fresh child in the seller consumer, the client entry resolved through the kit\'s dependency graph completes the offline control, and the kit factory refuses kit_operation_guard_off before importing demosdk', { timeout: INSTALLED_TEST_TIMEOUT_MS }, (t) => {
  const app = preparedConsumer(), work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-wallet-control-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const answer = runInConsumer(app, work, `import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
    const demosdkModules = () => loaded.filter(url => url.includes('/@kynesyslabs/demosdk/')).length;
    ${consumerWalletPrelude(app)}
    const { createSellerNodeWallet } = await import('@kynesyslabs/dacs-seller/src/devnet-demo/seller-node-wallet.mjs');
    const factory = await createSellerNodeWallet({}).then(() => 'built', error => error.code);
    const demosdkAtRefusal = demosdkModules();
    // The offline native-send control of the client's own packed test, through the client the seller resolves.
    const { generateWalletMnemonic } = await import('@kynesyslabs/dacs-seller/src/cli/node-identity.mjs');
    const rows = new Map(), journal = { get: async key => rows.get(key) ?? null, put: async (key, value) => rows.set(key, structuredClone(value)), entries: async () => [...rows],
      withWalletLock: async (key, work) => work(), withOwnedOrAcquiredLane: async (key, work) => work(),
      appendUnderLock: async (lane, key, value) => { if (rows.has(key)) throw Object.assign(new Error('exists'), { code: 'journal-key-exists' }); rows.set(key, structuredClone(value)); } };
    const session = await client.createNodeWalletSession({ admission, owner, journal, key: new TextEncoder().encode(await generateWalletMnemonic()), approve: async () => true,
      clock: { now: () => T0 }, stopped: async () => false, feeCeilingOs: '50000000000' });
    const from = session.wallet.getPublicAccount().address, to = '0x' + '2'.repeat(64), amount = '2500000000';
    const content = { type: 'native', from, to, amount, data: ['native', { nativeOperation: 'send', args: [to, amount] }], nonce: 1, timestamp: T0,
      transaction_fee: { network_fee: '0', rpc_fee: '0', additional_fee: '0', rpc_address: null } };
    const sent = await session.wallet.request({ method: 'sendTransaction', params: [{ content, signature: null, hash: '', status: '', blockNumber: null }] });
    await session.close(); owner.close();
    console.log(JSON.stringify({ factory, demosdkAtRefusal, demosdkAfterControl: demosdkModules() > 0, sent: sent.success, broadcasts: node.broadcasts.length,
      clientEntry: clientEntry.startsWith(realpathSync('node_modules') + '/') }));`);
  assert.deepEqual(answer, { factory: 'kit_operation_guard_off', demosdkAtRefusal: 0, demosdkAfterControl: true, sent: true, broadcasts: 1, clientEntry: true });
});

test('in the installed consumer, through the documented test seams, a payment-evidence signCreate inside a pass made with composition.effectPass reaches the inner gate through public entries only: the pass\'s fresh authority callback, stop check and each synchronous check run in order and the inner signature once; a stopped pass signs 0; no pass refuses effect_pass_required', { timeout: INSTALLED_TEST_TIMEOUT_MS }, (t) => {
  const app = preparedConsumer(), work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-wallet-pass-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dataDirectory = join(work, 'seller'), loaderOptions = kitGuardLoaderOptions(app, work);
  mkdirSync(dataDirectory);
  chmodSync(dataDirectory, 0o700);
  const answer = runInConsumer(app, work, `${consumerWalletPrelude(app)}
    const { createSellerNodeWallet } = await import('@kynesyslabs/dacs-seller/src/devnet-demo/seller-node-wallet.mjs');
    const { acquireSellerStateLock } = await import('@kynesyslabs/dacs-seller/src/devnet-demo/seller-state-lock.mjs');
    const { generateWalletMnemonic, deriveWalletIdentity } = await import('@kynesyslabs/dacs-seller/src/cli/node-identity.mjs');
    const { recordingApproval } = await import('./payment-evidence-approval-double.mjs');
    // The serving node's signed answer to a valid confirmTx, and a broadcast it applies.
    const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    node.intercept = async row => {
      const call = row.body?.params[0];
      if (call?.extra === 'confirmTx') { node.confirms.push(structuredClone(call.data)); return reply(ok({ data: { valid: true, reference_block: 1, message: 'TEST-valid', gas_operation: null,
        transaction: call.data }, signature: { type: 'ed25519', data: '0x' + '5'.repeat(128) }, rpc_public_key: { type: 'ed25519', data: '0x' + '6'.repeat(64) } })); }
      if (call?.extra === 'broadcastTx') { const tx = call.data.response.data.transaction; node.broadcasts.push(structuredClone(tx)); node.applied.set(tx.hash, structuredClone(tx)); return reply(ok({ hash: tx.hash })); }
      return undefined;
    };
    const dataDirectory = process.argv[1], mnemonic = await generateWalletMnemonic(), identity = await deriveWalletIdentity(mnemonic);
    identity.privateKey.fill(0);
    const stateLock = await acquireSellerStateLock(dataDirectory);
    const approve = Object.assign(async () => true, { confirm: async () => true, retained: recordingApproval() });
    const publications = {
      settlementPublication: { artifactKind: 'SettlementEvidence', authority: 'TEST-seller-settlement', phase: 'pay-dem', phaseIndex: 2, policy: client.DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' },
      deliveryPublication: { artifactKind: 'Deliverable', authority: 'TEST-seller-delivery', phase: 'deliver-storage-program', phaseIndex: 3, policy: client.DEVNET_DELIVERY_POLICY },
      demoArtifactPublication: { authority: 'TEST-RUN-installed-wallet-0001', policy: client.DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds: [...client.DEVNET_DEMO_ARTIFACT_TYPES] } };
    const wallet = await createSellerNodeWallet({ admission, owner, dataDirectory, journalMode: 'create', stateLock, signer: { claim: identity.claim },
      keyRecord: new TextEncoder().encode(JSON.stringify({ format: 'dacs-seller-key/v1', algorithm: 'ed25519', mnemonic })), approve, approvalMode: 'policy',
      clock: { now: () => T0 }, publications, stopped: async () => false, feeCeilingOs: '50000000000' });
    const steps = [], codes = error => { const found = []; for (let link = error; link instanceof Error; link = link.cause) found.push(link.code); return found; };
    const evidence = label => ({ logicalAddress: 'dacs4:payment:TEST-job-' + label + ':demos-native:DEM:2', artifact: { TEST: label }, writer: 'did:demos:agent:' + wallet.address.slice(2),
      artifactKind: 'SettlementEvidence', jobId: 'TEST-job-' + label, receiptContentHash: 'e1'.repeat(32) });
    async function inPass(work, stop = false) {
      const fence = await owner.acquireConnectionFence();
      try {
        const pass = wallet.effectPass({ fence, deadline: T0 + 10000, feeCeilingOs: '50000000000',
          refreshAuthority: ({ phase }) => { steps.push('authority:' + phase); },
          finalStop: ({ phase }) => { steps.push('stop:' + phase); if (stop) throw Object.assign(new Error('TEST-stopped'), { code: 'TEST-stopped' }); },
          synchronousChecks: [({ phase }) => { steps.push('check-1:' + phase); }, ({ phase }) => { steps.push('check-2:' + phase); }],
          context: client.passContext({ operationClass: 'payment-evidence', currentAuthorization: () => true }) });
        return await wallet.runInEffectPass(pass, work);
      } finally { fence.release(); }
    }
    const sent = await inPass(() => wallet.paymentEvidence.anchorEvidence(evidence('a')));
    const passed = steps.splice(0);
    const stopped = await inPass(() => wallet.paymentEvidence.anchorEvidence(evidence('b')), true).then(() => [], codes);
    const stoppedSteps = steps.splice(0);
    const unpassed = await wallet.paymentEvidence.anchorEvidence(evidence('c')).then(() => [], codes);
    const kept = await Promise.all(['a', 'b', 'c'].map(label => wallet.paymentEvidence.readSignedProjection({ logicalAddress: evidence(label).logicalAddress })));
    await wallet.close(); owner.close(); stateLock.release();
    console.log(JSON.stringify({ sent: sent.status, signPhase: passed.filter(step => step.endsWith(':sign')), stopped: stopped.includes('TEST-stopped'), stoppedSteps,
      unpassed: unpassed.includes('effect_pass_required'), kept: kept.map(row => row !== null), confirms: node.confirms.length, broadcasts: node.broadcasts.length,
      nodeOptions: process.env.NODE_OPTIONS ?? null }));`, { nodeOptions: loaderOptions, args: [dataDirectory] });
  assert.deepEqual(answer, { sent: 'submitted', signPhase: ['authority:sign', 'stop:sign', 'check-1:sign', 'check-2:sign'], stopped: true, stoppedSteps: ['authority:sign', 'stop:sign'],
    unpassed: true, kept: [true, false, false], confirms: 1, broadcasts: 1, nodeOptions: loaderOptions });
});
