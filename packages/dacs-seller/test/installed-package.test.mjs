// The seller package as a stranger gets it: pack the core and the seller,
// install both tarballs into a temporary application outside this repository,
// then import and host it from a clean `node` process with no test hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageDirectory = join(root, 'packages', 'dacs-seller');
const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
// Entry modules that could not be imported without test hooks before the run-time port.
const ENTRY_MODULES = ['src/dacs/seller-transport-auth.mjs', 'src/dacs/seller-context-route.mjs', 'src/dacs/seller-http.mjs', 'src/dacs/seller-agent.mjs',
  'src/dacs/seller-durable-state.mjs', 'src/devnet-demo/artifact-anchor.mjs', 'src/dacs/commit-on-signature.mjs'];
// Operator-side sources that need the operator's wallet, journal or custody.
const NOT_SHIPPED = ['src/devnet-demo/operator-custody.mjs', 'src/devnet-demo/seller-issuance.mjs', 'src/devnet-demo/seller-write-batch.mjs'];
const PUBLIC_API = ['SellerAgentError', 'agreementInput', 'attachIdentityPresentation', 'attachListingSignature', 'buildListingDraft', 'buildUnsignedIdentityBundle',
  'contributionVerifier', 'createOperatorBuyerAccess', 'createPaymentEvidenceWalletJournal', 'createSellerAgent', 'createSellerAgentClient', 'createSellerHttpHandler', 'createSellerTransportClientAuth',
  'createSellerTransportServerAuth', 'createSellerTransportStore', 'listingPin', 'listingSigningMessage', 'startSellerHost', 'validateListing'];

test('every executable seller test runs through both supported entry points',()=>{
 const actual=readdirSync(join(root,'packages/dacs-seller/test')).filter(name=>name.endsWith('.test.mjs')).sort();
 const script=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).scripts['seller:test'];
 const cli=[...script.matchAll(/packages\/dacs-seller\/test\/([^ ]+\.test\.mjs)/g)].map(match=>match[1]).sort();
 const wrapper=readFileSync(join(root,'test/seller/standalone.test.ts'),'utf8');
 const list=/const files\s*=\s*\[([\s\S]*?)\];/.exec(wrapper)?.[1];
 assert.ok(list,'the CI wrapper must declare its executable file list');
 const ci=[...list.matchAll(/'([^']+\.test\.mjs)'/g)].map(match=>match[1]).sort();
 assert.deepEqual(cli,actual,'seller:test must execute every test file exactly once');
 assert.deepEqual(ci,actual,'the core CI wrapper must execute the same complete set');
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
  assert.match(manifest.engines.node, /^>=22\./);
  assert.equal(manifest.peerDependencies['@kynesyslabs/dacs'], core.version);
  assert.ok(Array.isArray(manifest.files) && manifest.files.every((file) => !file.includes('*')), 'files is an explicit list');
  for (const file of NOT_SHIPPED) assert.ok(!manifest.files.includes(file), `${file} is not part of the package`);
  assert.ok(existsSync(join(root, 'dist', 'index.js')), 'the core is built (npm run build) before it is packed');

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-installed-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.ok(relative(root, work).startsWith('..') && isAbsolute(work), 'the application is outside the repository');
  const packs = join(work, 'packs'), app = join(work, 'app');
  mkdirSync(packs); mkdirSync(app);
  const [corePack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packs], root));
  const [sellerPack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packs, '--workspace', '@kynesyslabs/dacs-seller'], root));

  // The governing profile, admission guidance and source references ship with the source.
  for (const file of ['PROFILE.json', 'ADMISSION.md', 'SOURCES.md']) assert.ok(manifest.files.includes(file));
  assert.equal(manifest.exports['./PROFILE.json'], './PROFILE.json');

  // Exactly the manifest's files, its manifest, README and LICENSE.
  const packed = sellerPack.files.map((entry) => entry.path).sort();
  assert.deepEqual(packed, [...manifest.files, 'LICENSE', 'README.md', 'package.json'].sort());
  for (const path of packed) assert.doesNotMatch(path, /(?:^|\/)(?:wallet|embedded-wallet|test|port-sources)\/|operator-custody|seller-issuance|seller-write-batch/, `${path} is a run-time seller module`);
  for (const file of ENTRY_MODULES) assert.ok(packed.includes(file), `${file} is shipped`);

  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'installed-seller-app', private: true, type: 'module' })}\n`);
  npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=optional', '--no-package-lock', '--prefer-offline',
    join(packs, corePack.filename), join(packs, sellerPack.filename)], app);
  assert.ok(!existsSync(join(app, 'node_modules', '@kynesyslabs', 'dacs-seller', 'test')), 'tests are not installed');
  copyFileSync(new URL('./helpers/installed-seller-host.mjs', import.meta.url), join(app, 'run.mjs'));

  // A clean child: no inherited flags, loaders, hooks or NODE_OPTIONS.
  const env = { PATH: process.env.PATH, HOME: work, TMPDIR: work };
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
  assert.deepEqual(out.host.timeouts, { headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000, maxHeaderSize: 16384 });
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
