// The seller package as a stranger gets it: pack the core and the seller,
// install both tarballs into a temporary application outside this repository,
// then import and host it from a clean `node` process with no test hooks.
import test from 'node:test';
import {sellerPackFiles,staleSetupReason}from'../../../scripts/prepare-seller-consumer.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageDirectory = join(root, 'packages', 'dacs-seller');
// Entry modules that could not be imported without test hooks before the run-time port.
const ENTRY_MODULES = ['src/dacs/seller-transport-auth.mjs', 'src/dacs/seller-context-route.mjs', 'src/dacs/seller-http.mjs', 'src/dacs/seller-agent.mjs',
  'src/dacs/seller-durable-state.mjs', 'src/devnet-demo/artifact-anchor.mjs', 'src/dacs/commit-on-signature.mjs'];
// Shared helpers lower parts added after the package was first cut; each once went unshipped.
const ADDED_HELPERS = ['src/dacs/process-lease.mjs', 'src/devnet-demo/approval-ledger-append.mjs', 'src/util/bounded-resolution.mjs', 'src/dacs/fixture-settlement.mjs'];
// Operator-side sources that need the operator's wallet, journal or custody.
const NOT_SHIPPED = ['src/devnet-demo/operator-custody.mjs', 'src/devnet-demo/seller-issuance.mjs'];
const DOCUMENTS = ['ADMISSION.md', 'LICENSE', 'PROFILE.json', 'README.md', 'SOURCES.md', 'package.json'];
const PUBLIC_API = ['SellerAgentError', 'agreementInput', 'attachIdentityPresentation', 'attachListingSignature', 'buildListingDraft', 'buildUnsignedIdentityBundle',
  'contributionVerifier', 'createDeliverableWalletJournal', 'createOperatorBuyerAccess', 'createPaymentEvidenceWalletJournal', 'createSellerAgentClient', 'createSellerHttpHandler', 'createSellerTransportClientAuth',
  'createSellerTransportServerAuth', 'createSellerTransportStore', 'listingPin', 'listingSigningMessage', 'startSellerHost', 'validateListing'];
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
// Relative specifiers a module loads: static, side-effect, re-export and literal dynamic imports.
function relativeImports(file, source = readFileSync(join(packageDirectory, file), 'utf8')) {
  const patterns = [/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => join(dirname(file), match[1])));
}

test('every executable seller test has one complete CLI and CI entry',()=>{
 const actual=readdirSync(join(packageDirectory,'test')).filter(name=>name.endsWith('.test.mjs')).sort();
 const listed=JSON.parse(execFileSync(process.execPath,['scripts/run-seller-tests.mjs','--list'],{cwd:root,encoding:'utf8'}));
 assert.deepEqual(listed,actual);assert.equal(new Set(listed).size,actual.length);assert.ok(listed.includes('seller-transport-auth.test.mjs'));
 const script=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).scripts['seller:test'];assert.equal(script,'node scripts/run-seller-tests.mjs');
 const ci=readFileSync(join(root,'.github/workflows/ci.yml'),'utf8');assert.equal((ci.match(/run: npm run seller:test/g)??[]).length,1);assert.doesNotMatch(ci,/run: node[^\n]+packages\/dacs-seller\/test\/\*/);
 assert.equal(existsSync(join(root,'test/seller/standalone.test.ts')),false);
});

test('seller manifest declares its pinned native dependency', () => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')), lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['better-sqlite3'], lock.packages['node_modules/better-sqlite3'].version);
  assert.equal(lock.packages['packages/dacs-seller'].dependencies?.['better-sqlite3'], manifest.dependencies['better-sqlite3']);
});

test('the seller pack ships every source module but the operator ones, and everything each shipped module imports', () => {
  const packed = sellerPackFiles().sort();
  assert.deepEqual(packed, [...shippedModules(), ...DOCUMENTS].sort());
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

test('the import scan sees static, side-effect, re-export and literal dynamic imports', () => {
  const probe = "import { a } from './dacs/a.mjs';\nimport './dacs/b.mjs';\nexport { c } from \"../c.mjs\";\nconst d = await import('./util/d.mjs');\n";
  assert.deepEqual(relativeImports('src/probe.mjs', probe).sort(), ['c.mjs', 'src/dacs/a.mjs', 'src/dacs/b.mjs', 'src/util/d.mjs']);
});

test('the packed seller installs outside the repository and serves one Listing without test hooks', { timeout: INSTALLED_TEST_TIMEOUT_MS }, async (t) => {
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

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-installed-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const preparedPath = process.env.DACS_SELLER_SMOKE_DIR;
  assert.ok(preparedPath, 'set DACS_SELLER_SMOKE_DIR to a directory made by npm run seller:prepare -- <dir>');
  const app = realpathSync(preparedPath);
  assert.ok(relative(root, app).startsWith('..') && isAbsolute(app), 'prepared consumer is outside the repository');
  assert.equal(staleSetupReason(app), null, 'setup must provision these exact sources, lock and runtime');
  const { sellerPack } = JSON.parse(readFileSync(join(app, 'prepared.json'), 'utf8'));
  assert.equal(manifest.exports['./PROFILE.json'], './PROFILE.json');

  // Exactly the shipped modules, the governing documents, the manifest, README and LICENSE.
  const packed = sellerPack.files.map((entry) => entry.path).sort();
  assert.deepEqual(packed, [...shippedModules(), ...DOCUMENTS].sort());
  for (const file of ENTRY_MODULES) assert.ok(packed.includes(file), `${file} is shipped`);

  assert.ok(!existsSync(join(app,'node_modules','@kynesyslabs','dacs-seller','test')),'test files are not shipped');
  // A clean child: no inherited flags, loaders, hooks or NODE_OPTIONS.
  const env={PATH:process.env.PATH,TMPDIR:work,NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_CACHE:join(work,'empty-npm-cache')};mkdirSync(env.NPM_CONFIG_CACHE);
  const child = spawnSync(process.execPath, ['run.mjs'], { cwd: app, env, encoding: 'utf8', timeout: INSTALLED_RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `installed seller run failed\n${child.stdout}\n${child.stderr}`);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1));

  assert.deepEqual(out.environment, { execArgv: [], nodeOptions: null });
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
  assert.deepEqual(out.refusals.otherListingPin, { name: 'SellerRefusedError', code: 'peer_listing_mismatch', status: 409 });
  assert.deepEqual(out.refusals.unsigned, { status: 401, body: { error: 'peer_envelope_invalid', message: 'peer_envelope_invalid' } });
  assert.notEqual(out.refusals.unvettedProposal.disposition, 'complete', 'a proposal over synthetic Vet references is not signed');
  assert.equal(out.refusals.unvettedProposal.contribution, null);
  assert.notEqual(out.refusals.fabricatedVetProposal.disposition, 'complete', 'a Vet reference no record backs is not signed');
  assert.equal(out.refusals.fabricatedVetProposal.contribution, null);
  assert.deepEqual(out.refusals.replayedPresentation, { name: 'SellerRefusedError', code: 'session_not_admitted', status: 409 }, 'a presentation is admitted only on the job its challenge was issued for');
  assert.equal(out.refusals.bareNoNonce, true);
  assert.deepEqual(out.refusals.missingNonce, { name: 'SellerRefusedError', code: 'session_not_admitted', status: 409 }, 'DACS-1 §6.3.2: a presentation that carries no session nonce is refused');
  assert.deepEqual(out.issuedChallenge, { nonce: true, lifetimeMs: 600000 }, 'the installed host issues a fresh 256-bit challenge with its lifetime');
  assert.equal(out.presentsIssuedChallenge, true, 'the buyer presents the random challenge the host issued through the public builder');
  assert.deepEqual(out.refusals.contextChallenge, { status: 404, body: { error: 'not_found' } });
  for (const attempt of [out.refusals.secondHostSameDirectory, out.refusals.secondProcessSameDirectory]) {
    assert.match(attempt, /^Error: seller state directory is in use by another live operator process/, 'one live host owns the state');
  }
  assert.deepEqual(out.restart, { stateSameContribution: true, repeatSameContribution: true });
  assert.deepEqual(out.reached, [], 'negotiation reached no operator capability but the Vet context');
  assert.deepEqual(out.vetContextJobs, ['vetted', 'unvetted', 'fabricated'], 'every admitted proposal takes its Agreement input from the Vet context');
  assert.deepEqual(out.admittedJobs, ['vetted', 'unvetted', 'fabricated'], 'every session with an issued challenge asks the session admission; the replayed job has none, so the seller refuses it before asking');
});
