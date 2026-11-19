import { api, mnemonicBytes, scriptedNode, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTp1Authority, assertTp1Binding, bindTp1Profile, signSellerSessionDelegation, TESTNET_PROFILE_TP1, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { createAuthorityReader } from '../src/wallet/authority-reader.mjs';
import { createEffectFence } from '../src/wallet/effect-fence.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../src/public-admission.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { record, ownLocal, shared } from './helpers/chain-identity-fixture.mjs';
import { queuedOwner } from './helpers/queued-owner.mjs';
import { deferred, jsonResponse, MIB, ok, sizedReply } from './helpers/source-read-world.mjs';
import { readOnlyBoundary } from './helpers/read-only-boundary.mjs';

// Reuse the retained, signed public CREATE unchanged. The counterparty's
// endpoint is in its signed metadata; each reader owns a different endpoint.
const f = JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json', import.meta.url)));
function adapterAt(t, endpoint, pinChange = {}) {
  const pins = { ...f.pins, endpoint, transportAuthority: 'TEST-independent-reader', ...pinChange };
  const context = { network: pins.network, endpoint, transportAuthority: pins.transportAuthority, connectionId: 'TEST-reader-connection' };
  const tx = { ...structuredClone(f.valid), status: 'confirmed', blockNumber: 7 }, op = tx.content.data[1];
  const native = { success: true, storageAddress: op.storageAddress, owner: f.owner, programName: op.programName, data: op.data, metadata: op.metadata, createdByTx: tx.hash, interactionTxs: [tx.hash] };
  const block = { number: 7, status: 'confirmed', hash: 'a'.repeat(64), content: { timestamp: 1790000010, ordered_transactions: [tx.hash] }, validation_data: { TEST: 'single-node-observation', chainIdentity: pins.chainIdentity } };
  const source = createDevnetAgreementTransport({ boundary: readOnlyBoundary, expected: pins, now: () => 1790000020000,
    journal: { get: async () => null, put: async () => assert.fail('unexpected write'), entries: async () => [], withWalletLock: (_key, work) => work() },
    transportOwner: { getContext: () => ({ ...context }), acquireConnectionFence: () => ({ context: { ...context }, release() {} }) },
    fetchImpl: async (_url, options) => {
      const body = options.body ? JSON.parse(options.body) : null, call = body?.params[0];
      const responses = { getBlockByNumber: call?.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: pins.chainIdentity } : block,
        searchStoragePrograms: [{ storageAddress: op.storageAddress, programName: op.programName }], getTxByHash: tx };
      if (body) assert.ok(Object.hasOwn(responses, call.message), 'only bounded source reads are allowed');
      return new Response(JSON.stringify(body ? { result: 200, response: responses[call.message] } : native), { headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => source.close());
  const adapter = createDemosSr2Adapter({ rpcUrl: endpoint, sourceCapability: source, journal: createInMemoryDemosSr2Journal(), now: () => 1790000020000 });
  const writer = `did:demos:agent:${f.owner.slice(2)}`;
  return { read: () => adapter.read(f.logical, { expectedWriter: writer, signedProjection: f.valid }),
    verify: receipt => adapter.verifyReceipt({ receipt, logicalAddress: f.logical, artifact: f.artifact, expectedWriter: writer, signedProjection: f.valid }) };
}

test("two RPC endpoints on the same chain both verify, also in the client SR-2 adapter; changing the buyer's own endpoint invalidates only the buyer's authorization", async t => {
  const authority = createAuthorityFixture(), a = ownLocal;
  const b = { ...a, endpoint: 'https://identity-b.invalid/', transportAuthority: 'TEST-other-owner', connectionId: 'TEST-other-connection' };
  const first = await bindTp1Profile({ record, local: a, readAuthority: authority.read });
  const second = await bindTp1Profile({ record, local: b, readAuthority: authority.read });
  await assertTp1Binding(first, a); await assertTp1Binding(second, b);
  await assert.rejects(assertTp1Binding(first, { ...a, endpoint: b.endpoint }), { code: 'tp1_local_binding_changed' });
  await assertTp1Binding(second, b);
  for (const endpoint of [a.endpoint, b.endpoint]) {
    const adapter = adapterAt(t, endpoint), result = await adapter.read();
    assert.equal(result.status, 'present');
    assert.equal(await adapter.verify(result.receipt), 'valid');
  }
  for (const pins of [{ network: 'another-testnet' }, { chainIdentity: 'c'.repeat(64) }, { pinVersion: 'TEST-retired-pin' }]) {
    await assert.rejects(adapterAt(t, b.endpoint, pins).read(), { code: 'invalid' });
  }
});

test("a fresh observation from the buyer's RPC is compared with the record and never authorizes", async () => {
  const authority = createAuthorityFixture();
  const binding = await bindTp1Profile({ record, local: ownLocal, readAuthority: authority.read });
  const observation = await shared().binder.bind();
  assert.equal(observation.chainIdentity, record.chainIdentity);
  await assert.rejects(assertTp1Binding(observation, ownLocal), { code: 'tp1_binding_required' });
  authority.state.chainIdentity = 'c'.repeat(64);
  await assert.rejects(assertTp1Binding(binding, ownLocal), { code: 'tp1_connection_unverified' });
  const wrong = shared({ getBlock: () => ({ number: 0, status: 'confirmed', hash: 'c'.repeat(64) }) });
  await assert.rejects(wrong.binder.bind(), { code: 'identity_mismatch' });
});

const CHAIN = record.chainIdentity, DISCOVERY = 'dacs-seller-discovery/v1';
const claimOf = digit => 'did:demos:agent:' + digit.repeat(64);
const BUYER = claimOf('4'), SELLER = claimOf('5'), OTHER_SELLER = claimOf('6'), OTHER_BUYER = claimOf('7');
const JOB = '01M5YKPJG0248H248H248H248H', SECOND_JOB = '01M5YKPJG0248H248H248H248J', UNKNOWN_JOB = '01M5YKPJG0248H248H248H248K';
const OWN_PROFILE = { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity: CHAIN, pinVersion: record.pinVersion };
// The seam admits no array longer than this; the limit is documented on createNodeAuthorityCapability.
const LIST_LIMIT = 1024;
const RPC_BLOCK = number => ({ method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber: number } }] });
const mismatch = { code: 'tp1_participant_profile_mismatch' };
const causesOf = error => { const causes = []; for (let next = error; next; next = next.cause) causes.push(next); return causes; };
const enrollment = (claim, patch = {}) => ({ claim, profile: { ...OWN_PROFILE }, modules: { ...TESTNET_PROFILE_TP1.tuple }, evidence: 'TEST-enrollment-record', revoked: false, ...patch });
const purchaseRow = (jobId, seller = SELLER) => ({ terms: { protocol: { jobId } }, state: { listing: { seller: { identity: { presentedBy: seller } } } } });
const otherChainBlock = () => jsonResponse(JSON.stringify(ok({ number: 0, status: 'confirmed', hash: 'e'.repeat(64), content: {} })));
const countingSigner = claim => { const signer = { claim, signs: 0, async sign() { signer.signs++; return Buffer.alloc(64, 7); } }; return signer; };
const delegationPayload = (buyer, jobId) => ({ version: '1', kind: 'seller-session-delegation', buyer, sessionPublicKey: '9'.repeat(64), seller: SELLER,
  listingPin: { listingId: 'TEST-listing', version: 1, contentHash: 'c'.repeat(64) }, jobId, notBefore: T0, expiresAt: T0 + 60_000, profile: { ...OWN_PROFILE } });

// A real client reader over a real stage-one capability on a queued owner. Only the node, the Listing registry, the
// purchase rows and the enrollment source are the test's; `reads.enrollment` counts the reader's enrollment lookups.
function readerWorld(t, { fetchImpl } = {}) {
  const node = scriptedNode(), wallet = { claim: BUYER }, registered = new Set([SELLER]), reads = { enrollment: 0 };
  const rows = new Map([[JOB, purchaseRow(JOB)], [SECOND_JOB, purchaseRow(SECOND_JOB)]]);
  const enrolled = new Map([[SELLER, [enrollment(SELLER)]]]);
  const owner = queuedOwner({ fetchImpl: (url, init) => (fetchImpl ?? node.fetch)(url, init) });
  const authority = api.createNodeAuthorityCapability({ owner, claim: () => wallet.claim });
  const sources = { authority, identityRecord: record, claim: authority.claim,
    listings: { isRegistered: seller => registered.has(seller) },
    purchases: { findByJobId: jobId => rows.get(jobId) ?? null },
    participantImplementations: { entriesFor: claim => { reads.enrollment++; return enrolled.get(claim) ?? []; } } };
  const reader = createAuthorityReader(sources);
  const bind = () => bindTp1Profile({ record, local: owner.currentLocal(), readAuthority: reader });
  t.after(() => owner.close());
  return { node, owner, authority, wallet, registered, rows, enrolled, reads, sources, reader, bind };
}

// The client composition from an unopened owner: the test supplies no binding, reader or boundary.
async function compositionWorld(t, { node = scriptedNode(), input = {} } = {}) {
  setPurchaseAdmission('testnet-tp1');
  const directory = mkdtempSync(join(tmpdir(), 'authority-composition-')), touched = [];
  const journal = openDurableWalletJournal({ path: join(directory, 'journal.sqlite'), mode: 'create' });
  const watched = new Proxy(journal, { get: (target, name) => { touched.push(name); return Reflect.get(target, name); } });
  const owner = queuedOwner({ fetchImpl: node.fetch }), key = input.key ?? mnemonicBytes();
  const world = { node, owner, key, touched, composition: undefined,
    input: { owner, journal: watched, approve: async () => true, clock: { now: () => T0 }, identityRecord: record,
      listings: { isRegistered: () => false }, purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] },
      stopped: async () => false, feeCeilingOs: '50000000000', ...input, key },
    async build() { world.composition = await api.composeNodeWalletSession(world.input); return world.composition; } };
  t.after(async () => { setPurchaseAdmission('held'); await world.composition?.close(); await owner.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return world;
}

test('the production reader takes no fence, lock or signature, also while the effect boundary holds the transport fence, and two overlapping initial checks both finish', async t => {
  const w = readerWorld(t);
  const fence = createEffectFence({ acquire: () => w.owner.acquireConnectionFence(), currentLocal: () => 'TEST-digest' });
  const [first, second] = await Promise.all([w.bind(), w.bind()]);
  assert.notEqual(first, second, 'each overlapping initial check finished with its own binding');
  assert.equal(w.owner.acquisitions(), 0, 'the initial checks took no fence');
  await fence.withFence('TEST-operation', async () => {
    assert.equal(w.owner.acquisitions(), 1, 'the effect boundary owns the real transport fence');
    await Promise.all([assertTp1Binding(first, w.owner.currentLocal()), w.bind()]);
    assert.equal(w.owner.acquisitions(), 1, 'the reader added no fence acquisition while the boundary held it');
  });
  assert.deepEqual([...new Set(w.node.calls.map(row => row.body.params[0].message))], ['getBlockByNumber'], 'only identity reads: no execute, so no signature');
  // The composition's own reader, counted at the real owner and the real journal.
  const c = await compositionWorld(t), { binding } = await c.build();
  const before = { fences: c.owner.acquisitions(), journal: c.touched.length };
  await Promise.all([assertTp1Binding(binding, c.owner.currentLocal()), assertTp1Binding(binding, c.owner.currentLocal())]);
  assert.deepEqual({ fences: c.owner.acquisitions(), journal: c.touched.length }, before, 'the composed reader took no fence and touched no journal');
});

test('the production reader serves discovery and job checks from registered Listings, saved purchases and current enrollment; unregistered, changed or unknown scopes refuse and sign nothing; a missing input throws TypeError', async t => {
  const w = readerWorld(t), signer = countingSigner(BUYER);
  const binding = await w.bind(), current = w.owner.currentLocal();
  await assertTp1Authority(binding, current, [SELLER], DISCOVERY);
  for (const jobId of [JOB, SECOND_JOB]) assert.equal((await signSellerSessionDelegation(delegationPayload(BUYER, jobId), signer, binding, current)).payload.jobId, jobId);
  assert.equal(signer.signs, 2);
  const restarted = readerWorld(t);
  await assertTp1Authority(await restarted.bind(), restarted.owner.currentLocal(), [BUYER, SELLER], JOB);
  signer.signs = 0;
  w.registered.delete(SELLER);
  await assert.rejects(assertTp1Authority(binding, current, [SELLER], DISCOVERY), mismatch);
  w.wallet.claim = OTHER_BUYER;
  await assert.rejects(signSellerSessionDelegation(delegationPayload(BUYER, JOB), signer, binding, current), mismatch);
  w.wallet.claim = BUYER;
  await assert.rejects(signSellerSessionDelegation(delegationPayload(BUYER, UNKNOWN_JOB), signer, binding, current), mismatch);
  w.enrolled.set(OTHER_SELLER, [enrollment(OTHER_SELLER)]);
  await assert.rejects(signSellerSessionDelegation({ ...delegationPayload(BUYER, JOB), seller: OTHER_SELLER }, signer, binding, current), mismatch, 'an enrolled claim the row does not name answers nothing');
  w.rows.set(UNKNOWN_JOB, purchaseRow(JOB));
  await assert.rejects(signSellerSessionDelegation(delegationPayload(BUYER, UNKNOWN_JOB), signer, binding, current), mismatch, 'a row saved for another job answers nothing');
  assert.equal(signer.signs, 0, 'no refused case reached the signer');
  for (const name of Object.keys(w.sources)) assert.throws(() => createAuthorityReader({ ...w.sources, [name]: undefined }), TypeError, name);
});

test('while held, every action refuses profile_not_admitted before any read, and direct reader calls sign and send nothing', async t => {
  const c = await compositionWorld(t), w = readerWorld(t), { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  let signs = 0;
  for (const name of ['sign', 'signMessage']) t.mock.method(Demos.prototype, name, async () => { signs++; throw new Error('TEST-held-signer-called'); });
  const composition = await c.build(), address = composition.wallet.getPublicAccount().address;
  const request = { method: 'sendTransaction', params: [buildNativeTransferPayload({ from: address, to: '0x' + '2'.repeat(64), amountOs: '2500000000', nonce: 1, timestamp: T0, encoding: 'os-string' })] };
  setPurchaseAdmission('held');
  const reads = c.node.calls.length;
  await assert.rejects(composition.wallet.request(request), error => error.code === 'profile_not_admitted');
  assert.equal(c.node.calls.length, reads, 'the refusal came before any read');
  const decision = await w.reader({ local: { ...w.owner.currentLocal() }, sessionId: null, participants: [] });
  assert.equal(decision.chainIdentity, CHAIN);
  assert.equal(signs, 0);
  assert.deepEqual([c.node.confirms.length + w.node.confirms.length, c.node.broadcasts.length + w.node.broadcasts.length], [0, 0]);
  assert.deepEqual(Object.keys(w.authority).filter(name => /sign|send|broadcast/i.test(name)), [], 'the stage-one capability has no sign or send');
});

test("a seam reply over the byte bound, a list over its bound, and a stalled or late seam read refuse with their causes inside the caller's deadline", async t => {
  const replies = [], w = readerWorld(t, { fetchImpl: async () => replies.shift() });
  for (const declared of [true, false]) {
    replies.push(sizedReply(4 * MIB + 1, { declared }));
    await assert.rejects(w.authority.authorityRpc(RPC_BLOCK(0)), error => error.kind === 'invalid' && /exceeds byte limit/.test(error.message), `declared ${declared}`);
  }
  replies.push(jsonResponse(JSON.stringify(ok({ rows: new Array(LIST_LIMIT + 1).fill(0) }))));
  await assert.rejects(w.authority.authorityRpc(RPC_BLOCK(0)), { code: 'authority_list_too_large' });
  replies.push(jsonResponse(JSON.stringify(ok({ rows: new Array(LIST_LIMIT).fill(0) }))));
  assert.equal((await w.authority.authorityRpc(RPC_BLOCK(0))).response.rows.length, LIST_LIMIT, 'a list at its bound is admitted');
  // A wide object under the byte bound (300,000 fields) is refused like a long list, not by the stack.
  const wide = JSON.stringify(ok(Object.fromEntries(Array.from({ length: 300000 }, (_, index) => [index, 0]))));
  assert.ok(wide.length < 4 * MIB);
  replies.push(jsonResponse(wide));
  await assert.rejects(w.authority.authorityRpc(RPC_BLOCK(0)), { code: 'authority_list_too_large' });
  replies.push(jsonResponse(JSON.stringify(ok(Object.fromEntries(Array.from({ length: LIST_LIMIT }, (_, index) => [index, 0]))))));
  assert.equal(Object.keys((await w.authority.authorityRpc(RPC_BLOCK(0))).response).length, LIST_LIMIT, 'an object at its bound is admitted');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = deferred();
  replies.push(late.promise);
  const stalled = w.authority.authorityRpc(RPC_BLOCK(0)).then(() => 'authorized', error => error);
  t.mock.timers.tick(AUTHORITY_READ_DEADLINE_MS);
  const refusal = await stalled;
  assert.equal(refusal.code, 'tp1_authority_timeout');
  assert.equal(refusal.cause.kind, 'timeout');
  late.resolve(jsonResponse(JSON.stringify(ok({ rows: [] }))));
  await new Promise(resolve => setImmediate(resolve));
  for (const message of ['getTxByHash', 'getAddressNonce', 'execute', undefined]) {
    await assert.rejects(w.authority.authorityRpc({ method: 'nodeCall', params: [{ message, data: {} }] }), { code: 'readonly_only' }, String(message));
  }
  assert.equal(replies.length, 0, 'every read was one fetch and a refused message made none');
});

test('the seam runs at most four reads at once, starts the next queued read when one finishes, and never starts a read still queued at the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gates = [], flush = () => new Promise(resolve => setImmediate(resolve));
  const w = readerWorld(t, { fetchImpl: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
  const reads = Array.from({ length: 6 }, () => w.authority.authorityRpc(RPC_BLOCK(0)).then(() => 'answered', error => error));
  await flush();
  assert.equal(gates.length, 4, 'only four reads are on the transport');
  gates[0].resolve(jsonResponse(JSON.stringify(ok({ rows: [] }))));
  await flush();
  assert.equal(gates.length, 5, 'a finished read lets the next queued read start');
  t.mock.timers.tick(AUTHORITY_READ_DEADLINE_MS);
  const outcomes = await Promise.all(reads);
  assert.equal(outcomes[0], 'answered');
  assert.deepEqual(outcomes.slice(1).map(error => error.code), Array(5).fill('tp1_authority_timeout'));
  await flush();
  assert.equal(gates.length, 5, 'the read queued at the deadline never started');
});

test('failures injected through fetch, the response body and cancellation keep their identity in the cause chain through the production reader and the composition; late, malformed and oversized replies give distinct failures', async t => {
  const fetchFailure = new Error('TEST-fetch-failure'), bodyFailure = new Error('TEST-body-failure'), cancelled = new Error('TEST-cancel-reason');
  const failingBody = () => new Response(new ReadableStream({ pull() { throw bodyFailure; } }), { headers: { 'content-type': 'application/json' } });
  for (const [cause, fetchImpl] of [[fetchFailure, async () => { throw fetchFailure; }], [bodyFailure, async () => failingBody()]]) {
    const w = readerWorld(t, { fetchImpl });
    await assert.rejects(w.bind(), error => causesOf(error).includes(cause), cause.message + ' through the production reader');
    await assert.rejects(w.reader({ local: { ...w.owner.currentLocal() }, sessionId: null, participants: [] }), error => causesOf(error).includes(cause));
  }
  const node = scriptedNode();
  node.intercept = () => { throw fetchFailure; };
  await assert.rejects((await compositionWorld(t, { node })).build(), error => causesOf(error).includes(fetchFailure), 'through the client composition');
  const started = deferred(), hung = readerWorld(t, { fetchImpl: () => { started.resolve(); return new Promise(() => {}); } }), controller = new AbortController();
  const pending = hung.authority.authorityRpc(RPC_BLOCK(0), { signal: controller.signal });
  await started.promise;
  controller.abort(cancelled);
  await assert.rejects(pending, error => error === cancelled);
  const outcome = async fetchImpl => readerWorld(t, { fetchImpl }).authority.authorityRpc(RPC_BLOCK(0)).then(() => 'authorized', error => error);
  const malformed = await outcome(async () => jsonResponse('{not json')), oversized = await outcome(async () => sizedReply(4 * MIB + 1, { declared: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = outcome(() => new Promise(() => {}));
  t.mock.timers.tick(AUTHORITY_READ_DEADLINE_MS);
  const lateFailure = await stalled;
  assert.equal(lateFailure.code, 'tp1_authority_timeout');
  assert.equal(oversized.kind, 'invalid');
  assert.match(oversized.message, /exceeds byte limit/);
  assert.notEqual(malformed.message, oversized.message, 'a malformed reply is not an oversized one');
  assert.equal(new Set([malformed, oversized, lateFailure].map(error => `${error.code ?? error.kind}:${error.message}`)).size, 3, 'malformed, oversized and late are three distinct failures');
});

test('a removed, revoked, duplicated or changed enrollment refuses with a participant mismatch and no signature, a seller declaration alone never enrolls, a reader with no decision gives tp1_connection_unverified, and a transport failure keeps its original error', async t => {
  const w = readerWorld(t), signer = countingSigner(BUYER), binding = await w.bind(), current = w.owner.currentLocal();
  const ask = () => signSellerSessionDelegation(delegationPayload(BUYER, JOB), signer, binding, current);
  await ask();
  signer.signs = 0;
  const changed = [['removed', []], ['revoked', [enrollment(SELLER, { revoked: true })]], ['duplicated', [enrollment(SELLER), enrollment(SELLER)]],
    ['profile member', [enrollment(SELLER, { profile: { ...OWN_PROFILE, pinVersion: 'TEST-other-pin' } })]],
    ['module member', [enrollment(SELLER, { modules: { ...TESTNET_PROFILE_TP1.tuple, CORE: '9.9' } })]]];
  for (const [name, entries] of changed) {
    w.enrolled.set(SELLER, entries);
    await assert.rejects(ask(), mismatch, name);
  }
  const asked = { local: { ...current }, sessionId: JOB, participants: [BUYER, SELLER] };
  w.enrolled.set(SELLER, changed[3][1]);
  assert.equal((await w.reader(asked)).participants[1].profile.pinVersion, 'TEST-other-pin', 'an enrolled tuple that differs is returned as enrolled');
  w.enrolled.set(SELLER, []);
  w.rows.set(JOB, { ...purchaseRow(JOB), declaredProfile: { ...OWN_PROFILE }, declaredModules: { ...TESTNET_PROFILE_TP1.tuple } });
  await assert.rejects(ask(), mismatch, 'a declaration carried with the row enrolls nobody');
  assert.deepEqual((await w.reader(asked)).participants, [], 'missing evidence returns the connection decision with no participants');
  assert.equal(signer.signs, 0, 'no refused case signed');
  const reads = w.reads.enrollment;
  w.enrolled.set(SELLER, [enrollment(SELLER)]);
  await ask();
  assert.ok(w.reads.enrollment > reads, 'the enrollment is read again on every call');
  const wrongChain = readerWorld(t);
  wrongChain.node.intercept = otherChainBlock;
  await assert.rejects(wrongChain.bind(), { code: 'tp1_connection_unverified' });
  const failure = new Error('TEST-transport-failure'), failing = readerWorld(t, { fetchImpl: async () => { throw failure; } });
  await assert.rejects(failing.bind(), error => causesOf(error).includes(failure));
});

test('the client composition builds in stages with the production reader and the effect boundary: the connection read comes first, nothing effect-capable exists before the last stage, and each failed stage leaves no composition and a consumed key', async t => {
  const hold = deferred(), started = deferred(), ordered = await compositionWorld(t);
  ordered.node.intercept = () => { started.resolve(); return hold.promise; };
  const building = ordered.build().then(value => value, error => error);
  await started.promise;
  assert.equal(ordered.node.calls[0].body.params[0].message, 'getBlockByNumber', "the composition's first act is the reader's connection read");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ordered.composition, undefined, 'nothing effect-capable exists before the binding returns');
  assert.ok(ordered.key.some(byte => byte !== 0), 'the session has not been finalized, so the key is not consumed');
  assert.deepEqual(ordered.touched, [], 'the journal is untouched before finalization');
  hold.resolve();
  const composition = await building;
  assert.equal(typeof composition.effectBoundary.signPass, 'function');
  assert.ok(composition.wallet.getPublicAccount().address, 'finalized');
  assert.ok(ordered.key.every(byte => byte === 0), 'finalization consumed the key');
  const failing = [['stage one', { owner: {} }, TypeError], ['the reader', { listings: undefined }, TypeError],
    ['the binding', {}, { code: 'tp1_connection_unverified' }], ['the boundary', { stopped: undefined }, { name: 'TypeError', message: /needs stopped/ }],
    ['finalization', { key: new Uint8Array([255, 255]) }, { code: 'invalid_mnemonic' }]];
  for (const [stage, input, expected] of failing) {
    const w = await compositionWorld(t, { input });
    if (stage === 'the binding') w.node.intercept = otherChainBlock;
    await assert.rejects(w.build(), expected, stage);
    assert.equal(w.composition, undefined, `${stage}: no effect capability`);
    assert.ok(w.key.every(byte => byte === 0), `${stage}: the key is consumed`);
    assert.deepEqual([w.node.confirms.length, w.node.broadcasts.length], [0, 0]);
    assert.equal(w.owner.currentLocal().endpoint, 'https://rpc.example.invalid/', `${stage}: the host's owner stays open`);
  }
});

// The recorded TP-1 node replies: the four-field block-zero error, then blocks one and two; the string "0" read gets the recorded genesis.
const OBSERVATIONS = new URL('../../../conformance/', import.meta.url);
const recordedBody = file => JSON.parse(JSON.parse(readFileSync(new URL(file, OBSERVATIONS))).body);
const RECORDED_BLOCKS = ['tp1-node-observations/block0-2026-10-20.json', 'tp1-node-observations/block1-2026-10-20.json',
  'tp1-node-observations-2026-11-08/block2-2026-11-08.json'].map(recordedBody);
const RECORDED_GENESIS = recordedBody('tp1-node-observations/genesis-string-zero-2026-10-20.json');
// A node intercept that answers identity reads with the recorded replies, each first changed by `mutate(answer, height)`.
const recordedNode = (mutate = () => {}) => row => {
  const call = row.body.params[0];
  if (call.message !== 'getBlockByNumber') return undefined;
  const height = call.data.blockNumber, answer = structuredClone(height === '0' ? RECORDED_GENESIS : RECORDED_BLOCKS[height]);
  mutate(answer, height);
  return jsonResponse(JSON.stringify(answer));
};

test('the production reader and the composition bind the recorded TP-1 replies with their four-field block-zero error; a reply the reviewed policy refuses still refuses', async t => {
  const w = readerWorld(t);
  w.node.intercept = recordedNode();
  assert.equal((await w.bind()).profile.chainIdentity, record.chainIdentity);
  const c = await compositionWorld(t);
  c.node.intercept = recordedNode();
  assert.equal((await c.build()).binding.profile.chainIdentity, record.chainIdentity);
  // Each change and the cause the binding is refused with.
  const refused = {
    'the two-field block-zero error': [(answer, height) => { if (height === 0) { delete answer.extra; delete answer.require_reply; } }, 'malformed_observation'],
    'another block-zero error': [(answer, height) => { if (height === 0) answer.extra = 'Unknown block'; }, 'malformed_observation'],
    'another block-two hash': [(answer, height) => { if (height === 2) answer.response.hash = 'f'.repeat(64); }, 'identity_mismatch'],
  };
  for (const [label, [mutate, cause]] of Object.entries(refused)) {
    const r = readerWorld(t);
    r.node.intercept = recordedNode(mutate);
    await assert.rejects(r.bind(), error => error.code === 'unavailable' && causesOf(error).some(link => link.code === cause), label);
  }
});

test('the composed reader answers for the finalized wallet: its own claim is the session wallet and a peer comes only from the registered purchase and enrollment', async t => {
  const rows = new Map(), enrolled = new Map();
  const w = await compositionWorld(t, { input: { purchases: { findByJobId: jobId => rows.get(jobId) ?? null }, participantImplementations: { entriesFor: claim => enrolled.get(claim) ?? [] } } });
  const composition = await w.build(), address = composition.wallet.getPublicAccount().address, claim = 'did:demos:agent:' + address.slice(2);
  rows.set(JOB, purchaseRow(JOB));
  enrolled.set(SELLER, [enrollment(SELLER)]);
  const { binding } = composition;
  assert.equal(binding.profile.chainIdentity, CHAIN);
  await assertTp1Authority(binding, w.owner.currentLocal(), [claim, SELLER], JOB);
  enrolled.delete(SELLER);
  await assert.rejects(assertTp1Authority(binding, w.owner.currentLocal(), [claim, SELLER], JOB), mismatch);
});
