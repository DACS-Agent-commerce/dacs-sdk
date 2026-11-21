// The seller's Node wallet, built through the client's held Node composition: the kit guard and the state lock come first,
// the key copy and every derived copy are zeroed, the custody claim must match, the client's lock recovery runs on the
// journals the wallet opens, and the kit builders that need the devnet source accept only the client's own capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNoEgress } from '../../dacs-client/test/helpers/no-egress.mjs';
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';
import { api, ARTIFACT_JOURNAL, COMPOSITION_JOURNAL, createSellerNodeWallet, evidenceInput, FIXTURE_MNEMONIC, inWalletPass, keyRecordBytes, nodeConnection,
  privateDataDirectory, restartedWorld, runWalletChild, sellerWalletWorld, setPurchaseAdmission, walletOptions } from './helpers/seller-node-wallet-world.mjs';

const egress = installNoEgress();
const { acquireSellerStateLock } = await import('../src/devnet-demo/seller-state-lock.mjs');
const guard = await import('../src/kit-operation-guard.mjs');
const devnetSource = await import('../src/dacs/devnet-source.mjs');
const { createDevnetDemoArtifactAnchor } = await import('../src/devnet-demo/artifact-anchor.mjs');
const { createNativePaymentEvidenceConsumer } = await import('../src/dacs/native-payment-evidence-consumer.mjs');
const { createDemosSr2Adapter, createInMemoryDemosSr2Journal } = await import('../src/dacs/demos-sr2-adapter.mjs');

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const WALLET_MODULE = join(packageDirectory, 'src/devnet-demo/seller-node-wallet.mjs');
const zeroed = bytes => bytes.every(byte => byte === 0);
const anchor = world => inWalletPass(world, () => world.wallet.paymentEvidence.anchorEvidence(evidenceInput(world)));
// A world's connection, a fresh private directory and its held lock, without building the wallet.
async function unbuilt(t) {
  setPurchaseAdmission('testnet-tp1');
  const connection = await nodeConnection(), directory = privateDataDirectory(t), stateLock = await acquireSellerStateLock(directory);
  t.after(async () => { setPurchaseAdmission('held'); await connection.owner.close(); stateLock.release(); });
  return { connection, directory, stateLock, entries: () => readdirSync(directory).sort() };
}
// The refusal `options` meets, with the key record and the directory entries the call added.
async function refusalOf(t, overrides = {}, before = () => {}) {
  const world = await unbuilt(t), options = await walletOptions({ ...world, ...overrides });
  before(world, options);
  const existing = world.entries();
  const error = await createSellerNodeWallet({ ...options, ...overrides }).then(() => null, refused => refused);
  return { error, keyRecord: options.keyRecord, entries: world.entries().filter(name => !existing.includes(name)), calls: world.connection.node.calls.length };
}

test('guard off, constructing the composition throws kit_operation_guard_off before any journal or file opens', async t => {
  guard.setKitOperationGuardForTest('off');
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const { error, keyRecord, entries, calls } = await refusalOf(t);
  assert.deepEqual({ name: error?.name, code: error?.code, entry: error?.entry }, { name: 'KitOperationGuardError', code: 'kit_operation_guard_off', entry: 'createSellerNodeWallet' });
  assert.deepEqual(entries, [], 'no journal or file was made in the data directory');
  assert.equal(calls, 0, 'nothing reached the node');
  assert.ok(zeroed(keyRecord), 'the key record is zeroed even so');
});

test('an environment variable or seller.json key cannot turn the guard or the client hold on', async t => {
  const probe = `const { createSellerNodeWallet } = await import(${JSON.stringify(pathToFileURL(WALLET_MODULE).href)});
    try { await createSellerNodeWallet({ kitOperationGuard: 'testnet-tp1', purchaseAdmission: 'testnet-tp1', keyRecord: new Uint8Array(1) }); console.log('built'); }
    catch (error) { console.log(error.code); }`;
  const nodeOptions = (process.env.NODE_OPTIONS ?? '').split(' ').filter(option => option && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: packageDirectory, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: nodeOptions, DACS_KIT_GUARD: 'testnet-tp1', DACS_KIT_OPERATION_GUARD: 'testnet-tp1', DACS_PURCHASE_ADMISSION: 'testnet-tp1' } });
  assert.equal(child.stdout.trim(), 'kit_operation_guard_off', child.stderr);
  process.env.DACS_PURCHASE_ADMISSION = 'testnet-tp1';
  t.after(() => { delete process.env.DACS_PURCHASE_ADMISSION; });
  const world = await sellerWalletWorld(t, { held: true, options: { purchaseAdmission: 'testnet-tp1' } });
  await assert.rejects(world.wallet.walletFactory().request({ method: 'sign', params: ['TEST-message'] }), { code: 'profile_not_admitted' }, 'the client hold still refuses');
  const refused = await inWalletPass(world, () => world.wallet.paymentEvidence.anchorEvidence(evidenceInput(world))).then(() => null, error => error);
  const codes = [];
  for (let link = refused; link instanceof Error; link = link.cause) codes.push(link.code);
  assert.ok(codes.includes('profile_not_admitted'), `the evidence CREATE is refused by the hold: ${codes}`);
  assert.equal(world.node.confirms.length + world.node.broadcasts.length, 0);
});

test('under the unshipped test loader, the artifact anchor, payment evidence and SR-2 source mode are built from the client\'s public entry only', async t => {
  const world = await sellerWalletWorld(t), { sourceCapability } = world.wallet;
  const artifacts = createDevnetDemoArtifactAnchor({ sourceCapability, journal: world.wallet.artifactJournal, walletFactory: world.wallet.walletFactory,
    network: sourceCapability.pins.network, signer: { claim: `did:demos:agent:${world.wallet.address.slice(2)}` } });
  assert.equal(typeof artifacts.publish, 'function');
  const evidence = createNativePaymentEvidenceConsumer({ rpcUrl: sourceCapability.pins.endpoint, sourceCapability, anchorEvidence: world.wallet.paymentEvidence.anchorEvidence,
    readSignedProjection: world.wallet.paymentEvidence.readSignedProjection });
  assert.equal(evidence.anchorEvidence, world.wallet.paymentEvidence.anchorEvidence, 'source mode takes the wallet journal\'s own anchor');
  assert.equal(typeof createDemosSr2Adapter({ rpcUrl: sourceCapability.pins.endpoint, journal: createInMemoryDemosSr2Journal(), sourceCapability }).read, 'function');
  const clientExports = Object.keys(JSON.parse(readFileSync(join(packageDirectory, '../dacs-client/package.json'), 'utf8')).exports);
  const specifiers = [...readFileSync(WALLET_MODULE, 'utf8').matchAll(/from '(@kynesyslabs\/dacs-client[^']*)'/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0 && specifiers.every(specifier => clientExports.includes(specifier.replace('@kynesyslabs/dacs-client', '.'))), `public entries only: ${specifiers}`);
});

test('devnet-source predicates accept the client\'s registered facade and genuine transport, and refuse a copy, an unregistered object and null', async t => {
  const world = await sellerWalletWorld(t), facade = world.wallet.sourceCapability;
  for (const name of ['isDevnetAgreementTransport', 'isDevnetSettlementTransport', 'isDevnetDemoTransport']) {
    assert.equal(devnetSource[name], api[name], `${name} is the client's own check`);
    assert.equal(devnetSource[name](facade), true, `${name} accepts the held facade`);
    for (const value of [{ ...facade }, Object.freeze({ pins: facade.pins }), null]) assert.equal(devnetSource[name](value), false, `${name} refuses a copy, an unregistered object and null`);
  }
  assert.equal(devnetSource.DEVNET_DEMO_ARTIFACT_POLICY, api.DEVNET_DEMO_ARTIFACT_POLICY);
  assert.throws(() => createDevnetDemoArtifactAnchor({ sourceCapability: { ...facade } }), /source capability is required/);
});

test('the session address must equal the custody signer\'s claim, else seller_key_claim_mismatch with every copy zeroed', async t => {
  const { error, keyRecord, entries } = await refusalOf(t, { signer: { claim: `did:demos:agent:${'1'.repeat(64)}` } });
  assert.equal(error?.code, 'seller_key_claim_mismatch');
  assert.ok(zeroed(keyRecord), 'the key record is zeroed');
  assert.deepEqual(entries, [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL].sort(), 'no payment-evidence journal was made');
  const world = await sellerWalletWorld(t);
  assert.equal(`did:demos:agent:${world.wallet.address.slice(2)}`, world.options.signer.claim, 'a matching claim builds');
});

test('the key copy is zero-filled on success and every failure path, and session errors reach only the closed diagnostic projection', async t => {
  const world = await sellerWalletWorld(t);
  assert.ok(zeroed(world.options.keyRecord), 'zeroed on success');
  const failures = [
    [{ keyRecord: new TextEncoder().encode('{"format":"dacs-seller-key/v1"}') }, 'seller_key_format_invalid'],
    [{ signer: { claim: 'did:demos:agent:TEST' } }, 'seller_key_claim_mismatch'],
    [{ feeCeilingOs: 'TEST-not-an-amount' }, undefined],
    [{ publications: {} }, undefined],
    [{ journalMode: 'open' }, 'journal-absent'],
  ];
  for (const [overrides, code] of failures) {
    const diagnostics = [];
    const { error, keyRecord } = await refusalOf(t, { ...overrides, diagnostics: entry => diagnostics.push(entry) });
    assert.ok(error, JSON.stringify(Object.keys(overrides)));
    if (code) assert.equal(error.code, code);
    assert.ok(zeroed(keyRecord), `zeroed when ${Object.keys(overrides)} fails`);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(Object.keys(diagnostics[0]), ['code'], 'only the closed projection, never the error text or cause');
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(FIXTURE_MNEMONIC.split(' ')[0]));
  }
});

test('the BIP-39 validation and mnemonic derivation the composition injects into the seller key parser are the real ones, and every derived copy is zero-filled on success and on each failure path', async t => {
  // A copy of the 24 words with one word swapped keeps the word list but breaks the checksum.
  const words = FIXTURE_MNEMONIC.split(' '), checksumBroken = [...words.slice(0, -1), words.at(-1) === 'zoo' ? 'abandon' : 'zoo'].join(' ');
  for (const mnemonic of [checksumBroken, 'TEST not a mnemonic']) {
    const { error, keyRecord } = await refusalOf(t, { keyRecord: keyRecordBytes(mnemonic) });
    assert.equal(error?.code, 'seller_key_format_invalid', 'the real BIP-39 check refuses a bad checksum and other text');
    assert.ok(zeroed(keyRecord));
  }
  // Every UTF-8 copy of the mnemonic the wallet module makes while a wallet is built: the detached copy handed to the client.
  const copies = [], encode = TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype, 'encode', function recordCopy(text) {
    const bytes = Reflect.apply(encode, this, [text]);
    const caller = new Error().stack.split('\n').slice(1).find(line => !line.includes('recordCopy') && !line.includes('node:internal'));
    if (text === FIXTURE_MNEMONIC && caller?.includes('seller-node-wallet.mjs')) copies.push(bytes);
    return bytes;
  });
  for (const overrides of [{ signer: { claim: `did:demos:agent:${'1'.repeat(64)}` } }, { feeCeilingOs: 'TEST-not-an-amount' }]) {
    const before = copies.length, { error } = await refusalOf(t, overrides);
    assert.ok(error && copies.length > before, `a copy was handed over before ${Object.keys(overrides)} failed`);
    assert.ok(copies.every(zeroed), `every derived copy is zeroed after ${Object.keys(overrides)} fails`);
  }
  const world = await sellerWalletWorld(t), before = copies.length;
  assert.ok(copies.length >= before && copies.every(zeroed), 'every derived copy is zeroed after a build');
  assert.equal(`did:demos:agent:${world.wallet.address.slice(2)}`, world.options.signer.claim, 'the client\'s derivation gives the claim the kit\'s own derivation gives');
});

test('no module loads the browser bundle; globalThis window, document and location stay undefined', async t => {
  const world = await sellerWalletWorld(t);
  assert.equal(typeof world.wallet.walletFactory, 'function');
  for (const name of ['window', 'document', 'location']) assert.equal(globalThis[name], undefined, `${name} stays undefined`);
  const require = createRequire(join(packageDirectory, '../dacs-client/package.json'));
  const loaded = Object.keys(require.cache);
  assert.deepEqual(loaded.filter(path => /demosdk[\\/].*(?:browser|bundle|\.min\.js)/i.test(path)), [], 'no browser bundle of demosdk was loaded');
});

test('on Node 22.12.0 or 23.3.0 the composition refuses runtime_unsupported before custody, journal or signing', async t => {
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  t.after(() => Object.defineProperty(process, 'version', original));
  for (const version of ['v22.12.0', 'v23.3.0']) {
    const { error, keyRecord, entries, calls } = await refusalOf(t, {}, () => Object.defineProperty(process, 'version', { value: version, configurable: true }));
    Object.defineProperty(process, 'version', original);
    assert.equal(error?.code, 'runtime_unsupported', version);
    assert.deepEqual(entries, [], `${version}: no journal was opened`);
    assert.equal(calls, 0, `${version}: nothing reached the node`);
    assert.ok(zeroed(keyRecord));
  }
});

test('without the seller state lock, or with a released one, createSellerNodeWallet refuses state_ownership_required before any journal opens', async t => {
  const other = privateDataDirectory(t), otherLock = await acquireSellerStateLock(other);
  t.after(() => otherLock.release());
  const cases = { missing: () => undefined, released: world => { world.stateLock.release(); return world.stateLock; }, 'of another directory': () => otherLock,
    'replaced on disk': world => ({ path: world.stateLock.path, held: () => false }) };
  for (const [label, lockOf] of Object.entries(cases)) {
    let lock;
    const { error, keyRecord, entries } = await refusalOf(t, {}, (world, options) => { lock = lockOf(world); options.stateLock = lock; });
    assert.equal(error?.code, 'state_ownership_required', label);
    assert.deepEqual(entries, [], `${label}: no journal opened`);
    assert.ok(zeroed(keyRecord), label);
  }
});

test('SIGKILL while the signer lock is held, then a restart under the real seller state lock: the composition and the anchor journal recover their lock rows and reconcile; a second live kit process is refused by the state lock', async t => {
  const directory = privateDataDirectory(t), stateDirectory = privateDataDirectory(t);
  const killed = await runWalletChild('hold-locks', directory, stateDirectory, { killWhenReady: true });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const world = await restartedWorld(t, directory, stateDirectory);
  assert.equal(await world.wallet.artifactJournal.withWalletLock('TEST-artifact-lane', async () => 'free'), 'free', 'the anchor journal\'s dead lock row was released');
  const sent = await anchor(world);
  assert.equal(sent.status, 'submitted', 'the signer lock is free: the composition signs');
  assert.deepEqual(await inWalletPass(world, () => world.wallet.paymentEvidence.reconcilePaymentEvidence(evidenceInput(world))), { status: 'applied', txHash: sent.txHash });
  const second = await runWalletChild('second-lock', directory, stateDirectory);
  assert.deepEqual(JSON.parse(second.stdout), { code: 'seller_state_locked', reason: 'held' }, 'a second live kit process is refused');
});

test('kill between recovery of each issuance journal and resume under the real state lock', async t => {
  for (const check of [2, 3]) {
    const directory = privateDataDirectory(t), stateDirectory = privateDataDirectory(t);
    assert.equal((await runWalletChild('hold-locks', directory, stateDirectory, { killWhenReady: true })).signal, 'SIGKILL');
    const cut = await runWalletChild(`recovery:${check}`, directory, stateDirectory, { journalMode: 'open' });
    assert.equal(cut.signal, 'SIGKILL', `killed at state-lock check ${check}: ${cut.stderr}`);
    const world = await restartedWorld(t, directory, stateDirectory);
    assert.equal(await world.wallet.artifactJournal.withWalletLock('TEST-artifact-lane', async () => 'free'), 'free', `check ${check}: the anchor journal recovered`);
    assert.equal((await anchor(world)).status, 'submitted', `check ${check}: the composition journal recovered`);
    await world.wallet.close();
  }
});

test('a storage CREATE for an artifact and for payment evidence signs under the installed demosdk version with the journal\'s exact projection', async t => {
  const resolved = createRequire(join(packageDirectory, '../dacs-client/package.json')).resolve('@kynesyslabs/demosdk/websdk');
  const version = JSON.parse(readFileSync(join(resolved.slice(0, resolved.lastIndexOf('/build/')), 'package.json'), 'utf8')).version;
  assert.match(version, /^4\.0\.(1[6-9]|[2-9][0-9])$/, `the client's installed demosdk ${version} is in its declared range`);
  for (const approvalMode of ['policy', 'manual']) {
    const world = await sellerWalletWorld(t, { options: { approvalMode } });
    const sent = await anchor(world);
    const kept = await world.wallet.paymentEvidence.readSignedProjection({ logicalAddress: evidenceInput(world).logicalAddress });
    assert.equal(JSON.stringify(world.node.broadcasts[0]), JSON.stringify(kept), 'the evidence CREATE sent is the projection the journal kept');
    assert.equal(kept.hash, sent.txHash);
    assert.equal(world.approval.confirmations.length, 1, 'payment evidence is confirmed through approve.retained');
    const wallet = world.wallet.walletFactory({ anchorJournal: world.wallet.artifactJournal });
    const request = await agreementRequest({ session: { wallet }, node: world.node });
    const answer = await inWalletPass(world, () => wallet.request(request), { context: api.passContext({ operationClass: 'job-create', currentAuthorization: () => true }) });
    assert.equal(answer.success, true, JSON.stringify(answer));
    assert.equal(world.node.broadcasts.length, 2);
    assert.deepEqual(world.node.broadcasts[1], world.node.confirms.at(-1), 'the artifact CREATE sent is the one confirmed');
    assert.equal(world.approve.confirmed.length, approvalMode === 'policy' ? 1 : 0, `${approvalMode}: the confirmed-write policy runs only in policy mode`);
  }
});

test('SOURCES.md names the source path and commit of the approval helper this composition moves, and its diagnostics change', () => {
  const sources = readFileSync(join(packageDirectory, 'SOURCES.md'), 'utf8');
  const entry = sources.split('\n').find(line => line.includes('createOperatorApprovalAttempt'));
  assert.ok(entry, 'the moved function has an entry');
  assert.match(entry, /http-mcp\/src\/devnet-demo\/operator-custody\.mjs/, 'its source path');
  assert.match(entry, /\b80e5162\b/, 'its source commit');
  assert.match(entry, /sellerDiagnostic/, 'the diagnostics change');
});

test('no socket or DNS lookup leaves the process in the kit composition suite', () => {
  assert.deepEqual(egress.attempts, []);
  egress.restore();
});
