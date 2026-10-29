// The seller package as a stranger gets it: pack the core and the seller,
// install both tarballs into a temporary application outside this repository,
// then import and host it from a clean `node` process with no test hooks.
import test from 'node:test';
import {createHash}from'node:crypto';
import {defaultSellerConsumer,sellerSourceFingerprint}from'../../../scripts/prepare-seller-consumer.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageDirectory = join(root, 'packages', 'dacs-seller');
// Entry modules that could not be imported without test hooks before the run-time port.
const ENTRY_MODULES = ['src/dacs/seller-transport-auth.mjs', 'src/dacs/seller-context-route.mjs', 'src/dacs/seller-http.mjs', 'src/dacs/seller-agent.mjs',
  'src/dacs/seller-durable-state.mjs', 'src/devnet-demo/artifact-anchor.mjs', 'src/dacs/commit-on-signature.mjs'];
// Operator-side sources that need the operator's wallet, journal or custody.
const NOT_SHIPPED = ['src/devnet-demo/operator-custody.mjs', 'src/devnet-demo/seller-issuance.mjs', 'src/devnet-demo/seller-write-batch.mjs'];
const PUBLIC_API = ['SellerAgentError', 'agreementInput', 'attachIdentityPresentation', 'attachListingSignature', 'buildListingDraft', 'buildUnsignedIdentityBundle',
  'contributionVerifier', 'createDeliverableWalletJournal', 'createOperatorBuyerAccess', 'createPaymentEvidenceWalletJournal', 'createSellerAgentClient', 'createSellerHttpHandler', 'createSellerTransportClientAuth',
  'createSellerTransportServerAuth', 'createSellerTransportStore', 'listingPin', 'listingSigningMessage', 'startSellerHost', 'validateListing'];

test('every executable seller test has one complete CLI and CI entry',()=>{
 const actual=readdirSync(join(packageDirectory,'test')).filter(name=>name.endsWith('.test.mjs')).sort();
 const listed=JSON.parse(execFileSync(process.execPath,['scripts/run-seller-tests.mjs','--list'],{cwd:root,encoding:'utf8'}));
 assert.deepEqual(listed,actual);assert.equal(new Set(listed).size,actual.length);assert.ok(listed.includes('seller-transport-auth.test.mjs'));
 const script=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).scripts['seller:test'];assert.equal(script,'node scripts/run-seller-tests.mjs');
 const ci=readFileSync(join(root,'.github/workflows/ci.yml'),'utf8');assert.equal((ci.match(/run: npm run seller:test/g)??[]).length,1);assert.doesNotMatch(ci,/run: node[^\n]+packages\/dacs-seller\/test\/\*/);
 assert.equal(existsSync(join(root,'test/seller/standalone.test.ts')),false);
});
test('seller manifest declares its pinned native dependency and all local runtime imports',()=>{
 const manifest=JSON.parse(readFileSync(join(packageDirectory,'package.json'),'utf8')),lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
 assert.equal(manifest.dependencies?.['better-sqlite3'],lock.packages['node_modules/better-sqlite3'].version);
 assert.equal(lock.packages['packages/dacs-seller'].dependencies?.['better-sqlite3'],manifest.dependencies['better-sqlite3']);
 for(const file of manifest.files.filter(name=>name.endsWith('.mjs'))){const source=readFileSync(join(packageDirectory,file),'utf8');for(const match of source.matchAll(/from ['"](\.[^'"]+\.mjs)['"]/g)){const local=new URL(match[1],pathToFileURL(join(packageDirectory,file)));assert.ok(manifest.files.includes(relative(packageDirectory,fileURLToPath(local))),`${file} dependency ${match[1]} ships`);}}
});

test('the packed seller installs outside the repository and serves one Listing without test hooks', { timeout: 600000 }, async (t) => {
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
  assert.ok(Array.isArray(manifest.files) && manifest.files.every((file) => !file.includes('*')), 'files is an explicit list');
  for (const file of NOT_SHIPPED) assert.ok(!manifest.files.includes(file), `${file} is not part of the package`);
  assert.ok(existsSync(join(root, 'dist', 'index.js')), 'the core is built (npm run build) before it is packed');

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-installed-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.ok(relative(root, work).startsWith('..') && isAbsolute(work), 'the application is outside the repository');
  const preparedPath=process.env.DACS_SELLER_SMOKE_DIR??defaultSellerConsumer;
  assert.ok(existsSync(join(preparedPath,'prepared.json')),'run npm run seller:prepare before the smoke');
  const app=realpathSync(preparedPath);
  assert.ok(relative(root,app).startsWith('..'),'prepared consumer is outside the repository');
  assert.ok(existsSync(join(app,'prepared.json')),'run npm run seller:prepare before the smoke');
  const prepared=JSON.parse(readFileSync(join(app,'prepared.json'),'utf8'));
  assert.equal(prepared.sourceFingerprint,sellerSourceFingerprint(),'setup must provision these exact sources');
  assert.equal(prepared.lockDigest,createHash('sha256').update(readFileSync(join(app,'package-lock.json'))).digest('hex'));
  const {sellerPack}=prepared;
  // The governing profile, admission guidance and source references ship with the source.
  for (const file of ['PROFILE.json', 'ADMISSION.md', 'SOURCES.md']) assert.ok(manifest.files.includes(file));
  assert.equal(manifest.exports['./PROFILE.json'], './PROFILE.json');

  // Exactly the manifest's files, its manifest, README and LICENSE.
  const packed = sellerPack.files.map((entry) => entry.path).sort();
  assert.deepEqual(packed, [...manifest.files, 'LICENSE', 'README.md', 'package.json'].sort());
  for (const path of packed) assert.doesNotMatch(path, /(?:^|\/)(?:wallet|embedded-wallet|test|port-sources)\/|operator-custody|seller-issuance|seller-write-batch/, `${path} is a run-time seller module`);
  for (const file of ENTRY_MODULES) assert.ok(packed.includes(file), `${file} is shipped`);

  assert.ok(!existsSync(join(app,'node_modules','@kynesyslabs','dacs-seller','test')),'test files are not shipped');
  // A clean child: no inherited flags, loaders, hooks or NODE_OPTIONS.
  const env={PATH:process.env.PATH,TMPDIR:work,NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_CACHE:join(work,'empty-npm-cache')};mkdirSync(env.NPM_CONFIG_CACHE);
  const child = spawnSync(process.execPath, ['run.mjs'], { cwd: app, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `installed seller run failed\n${child.stdout}\n${child.stderr}`);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1));

  assert.deepEqual(out.environment, { execArgv: [], nodeOptions: null });
  assert.equal(out.packageRoot, join('node_modules', '@kynesyslabs', 'dacs-seller'));
  assert.deepEqual(out.imports.filter((entry) => !entry.loaded), [], 'every installed module imports');
  assert.deepEqual(out.imports.map((entry) => entry.file).sort(), manifest.files.filter((file) => file.endsWith('.mjs')).sort());
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
