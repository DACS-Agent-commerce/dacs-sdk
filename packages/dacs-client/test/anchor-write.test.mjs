// The anchor write record a protocol purchase saves at prepare, and its public read. The purchase service, the protocol
// factory and the wallet bridge are real; the chain, verifier, seller and node are stand-ins as each world says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { agreementRequest } from './helpers/tp1-node-fixture.mjs';

const { compositionWorld } = await import('./helpers/public-composition-world.mjs');
const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
const { readAnchorReservedWriteId, OperationError, createCoordinateStore } = await import('../src/index.mjs');
const { buildAnchorWrite } = await import('../src/dacs/protocol-purchases.mjs');
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createDemosSr2WalletBridge } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { createOperationStore } = await import('./helpers/purchase-integrity-operations.mjs');
const { openDatabase, transaction, isUniqueViolation } = await import('./helpers/purchase-integrity-database.mjs');

const ANCHOR_WRITE_MEMBERS = ['expectedNonce', 'from', 'jobId', 'kind', 'network', 'nonceFence', 'reservedWriteId'];
const WRITE_ID = /^[0-9a-f]{64}$/;
const OTHER_JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const refuses = (code) => (error) => error instanceof OperationError && error.code === code;

async function admittedWorld(t, options) {
  t.mock.method(Date, 'now', () => T0);
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  return compositionWorld(t, options);
}

const savedRecord = (world, operationId) => world.ops.get(world.accountId, operationId).state.protocol.anchorWrite;

test('prepare saves the anchor CREATE\'s write coordinates in the purchase\'s own state before any signature, wallet call or seller request, and the public read returns the id', async (t) => {
  const world = await admittedWorld(t, { shippedAdapters: true });
  const nonce = await world.chain.getAddressNonce(world.wallet.address);
  const { operation } = await world.prepare();
  const lookupsAtPrepare = world.counters.sellerLookups;
  const saved = world.ops.get(world.accountId, operation.id);
  const record = saved.state.protocol.anchorWrite;
  assert.deepEqual(Object.keys(record).sort(), ANCHOR_WRITE_MEMBERS);
  assert.deepEqual({ ...record, reservedWriteId: undefined }, { kind: 'agreement-create', network: saved.terms.network, from: world.wallet.address,
    nonceFence: nonce, expectedNonce: nonce + 1, jobId: saved.terms.protocol.jobId, reservedWriteId: undefined });
  assert.match(record.reservedWriteId, WRITE_ID);
  assert.equal(saved.state.protocol.signatures, undefined, 'nothing is signed yet');
  assert.equal(readAnchorReservedWriteId(saved), record.reservedWriteId);
  const { ops } = world.rebuild();
  assert.equal(readAnchorReservedWriteId(ops.get(world.accountId, operation.id)), record.reservedWriteId, 'the record survives a restart');
  assert.deepEqual([world.native.calls.length, world.native.writes.length, world.chain.broadcasts], [0, 0, 0], 'no wallet call or broadcast');
  assert.equal(world.counters.sellerLookups, lookupsAtPrepare, 'no seller request after prepare');
  assert.equal(world.tableCounts().write_coordinates, 0);
});

test('the anchor write id is already readable when the buyer is first asked for a signature, and it does not change through the identity step', async (t) => {
  const world = await admittedWorld(t);
  const { operation } = await world.prepare();
  const before = world.ops.get(world.accountId, operation.id);
  const id = readAnchorReservedWriteId(before);
  const { delegation } = await world.service.agreementIdentity({ operationId: operation.id, token: world.ops.handoffTokenFor(operation.id), address: world.wallet.address });
  assert.equal(typeof delegation.message, 'string', 'the buyer is asked to sign the delegation message');
  const after = world.ops.get(world.accountId, operation.id);
  assert.equal(readAnchorReservedWriteId(after), id);
  assert.equal(canonicalize(after.state.protocol.anchorWrite), canonicalize(before.state.protocol.anchorWrite));
});

test('the anchor write record is unchanged when the wallet bridge is asked for the Agreement CREATE', async (t) => {
  let flow, saved;
  const bridgeCalls = [];
  const observe = (operation) => ({ id: readAnchorReservedWriteId(operation), bytes: canonicalize(operation.state.protocol.anchorWrite) });
  // A bridge that records each call and what the purchase row holds at that moment; a throw here would be caught by the anchor step.
  const bridge = {
    anchor: async () => { bridgeCalls.push({ call: 'anchor', seen: observe(flow.p.get()) }); return { status: 'indeterminate' }; },
    resume: async () => { bridgeCalls.push({ call: 'resume' }); return { status: 'indeterminate' }; },
  };
  let atStart;
  const outcome = await sellerFlow(t, 'agreement', (s, state) => {
    flow = s;
    const { terms } = s.p.get();
    saved = buildAnchorWrite({ network: terms.network, from: terms.buyer.wallet, nonceFence: 6, jobId: terms.protocol.jobId });
    s.patch({ anchorWrite: saved });
    atStart = observe(s.p.get());
    // No CREATE intent is kept, so the anchor step asks the bridge for a first CREATE.
    state.exchange = async ({ anchorAdapter }) => {
      await anchorAdapter.anchorAgreement({ artifact: s.made.agreement, agreementHash: s.made.agreementHash, logicalAddress: fixedPriceAgreementLogicalAddress(terms.protocol.jobId) });
      return { disposition: 'indeterminate', stage: 'agreement-anchor', reason: 'TEST-anchor-asked' };
    };
  }, { walletAgreement: { bridgeFor: () => bridge } }, {}, { network: 'testnet' }).then(() => ({}), (error) => ({ error }));
  assert.equal(outcome.error, undefined);
  assert.deepEqual(bridgeCalls.map(({ call }) => call), ['anchor'], 'the first CREATE is asked through anchor, once');
  const expected = { id: saved.reservedWriteId, bytes: canonicalize(saved) };
  assert.deepEqual(atStart, expected, 'before the anchor step');
  assert.deepEqual(bridgeCalls[0].seen, expected, 'when the bridge is asked');
  assert.deepEqual(observe(flow.p.get()), expected, 'after the flow returns');
  assert.ok(flow.p.get().state.protocol.walletAnchor, 'the anchor step kept its own CREATE intent beside the record');
});

test('a purchase with no saved anchor write makes the public read refuse anchor_write_unsaved, and so does an absent or non-protocol operation', async (t) => {
  const world = await admittedWorld(t);
  const protocolTerms = { jobId: OTHER_JOB_ID };
  const unsaved = world.seed({ status: 'agreement_pending', key: 'TEST-no-record', protocolTerms }).operation;
  const nulled = world.seed({ status: 'agreement_pending', key: 'TEST-null-record', protocolTerms, state: { protocol: { anchorWrite: null } } }).operation;
  const plain = world.seed({ status: 'awaiting_approval', key: 'TEST-plain' }).operation;
  const read = (operation) => world.ops.get(world.accountId, operation.id);
  for (const [label, value] of [['a protocol purchase without a record', read(unsaved)], ['a protocol purchase whose record is null', read(nulled)],
    ['a purchase without protocol terms', read(plain)], ['undefined', undefined], ['null', null], ['a string', 'TEST-operation']]) {
    assert.throws(() => readAnchorReservedWriteId(value), refuses('anchor_write_unsaved'), label);
  }
});

test('a changed or inconsistent saved anchor write makes the public read refuse anchor_write_invalid, and a consumer\'s edited copy does not change the stored record', async (t) => {
  const world = await admittedWorld(t);
  const { operation } = await world.prepare();
  const storedState = () => world.db.prepare('SELECT state FROM operations WHERE id = ?').get(operation.id).state;
  const original = JSON.parse(storedState());
  const record = original.protocol.anchorWrite;
  const missingJobId = Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'jobId'));
  const consistent = (change) => ({ ...buildAnchorWrite({ ...record, ...change }) });
  const cases = [
    ['an array', [record]], ['a string', 'TEST-record'], ['a missing member', missingJobId], ['an extra member', { ...record, note: 'TEST' }],
    ['another kind', { ...record, kind: 'dem-transfer' }], ['a numeric network', { ...record, network: 1 }], ['a numeric job id', { ...record, jobId: 1 }],
    ['a nonce fence as text', { ...record, nonceFence: String(record.nonceFence) }], ['a negative nonce fence', { ...record, nonceFence: -1, expectedNonce: 0 }],
    ['an unsafe nonce fence', { ...record, nonceFence: 2 ** 53, expectedNonce: 2 ** 53 + 1 }],
    ['another wallet', consistent({ from: '0x' + 'f'.repeat(64) })], ['another network', consistent({ network: 'mainnet' })],
    ['another job id', consistent({ jobId: OTHER_JOB_ID })], ['an expected nonce that is not the fence plus one', { ...record, expectedNonce: record.nonceFence + 2 }],
    ['an upper-case id', { ...record, reservedWriteId: record.reservedWriteId.toUpperCase() }], ['an id that does not recompute', { ...record, reservedWriteId: 'a'.repeat(64) }],
  ];
  const update = world.db.prepare('UPDATE operations SET state = ? WHERE id = ?');
  for (const [label, anchorWrite] of cases) {
    update.run(JSON.stringify({ ...original, protocol: { ...original.protocol, anchorWrite } }), operation.id);
    assert.throws(() => readAnchorReservedWriteId(world.ops.get(world.accountId, operation.id)), refuses('anchor_write_invalid'), label);
  }
  update.run(JSON.stringify(original), operation.id);
  const stored = storedState();
  const copy = world.ops.get(world.accountId, operation.id);
  copy.state.protocol.anchorWrite.expectedNonce += 1;
  assert.throws(() => readAnchorReservedWriteId(copy), refuses('anchor_write_invalid'));
  assert.equal(storedState(), stored);
  assert.equal(readAnchorReservedWriteId(world.ops.get(world.accountId, operation.id)), record.reservedWriteId);
});

test('prepare refuses anchor_nonce_unavailable and creates nothing when the buyer\'s nonce cannot be read, and a replayed prepare does not read it again', async (t) => {
  const world = await admittedWorld(t);
  const failure = new Error('TEST-nonce-read-failed');
  const answers = [['a failed read', () => { throw failure; }], ['text', () => '7'], ['a negative number', () => -1], ['NaN', () => NaN], ['a fraction', () => 1.5],
    ['a nonce with no safe successor', () => Number.MAX_SAFE_INTEGER], ['no answer', () => undefined]];
  for (const [label, answer] of answers) {
    world.chain.getAddressNonce = async () => answer();
    await assert.rejects(world.prepare('TEST-nonce'), (error) => refuses('anchor_nonce_unavailable')(error) && error.cause === (answer === answers[0][1] ? failure : undefined), label);
    assert.deepEqual(world.tableCounts(), { operations: 0, operation_events: 0, write_coordinates: 0 }, label);
  }
  let reads = 0;
  world.chain.getAddressNonce = async () => { reads += 1; return 6; };
  const first = await world.prepare('TEST-nonce');
  assert.deepEqual([first.created, reads], [true, 1]);
  const replay = await world.prepare('TEST-nonce');
  assert.deepEqual([replay.created, replay.operation.id, reads], [false, first.operation.id, 1]);
  assert.equal(readAnchorReservedWriteId(replay.operation), readAnchorReservedWriteId(first.operation));
});

test('the anchor write never touches the payment\'s write coordinates', async (t) => {
  const world = await admittedWorld(t);
  const { operation } = await world.prepare();
  assert.equal(world.coordinates.get(operation.id), null);
  assert.equal(world.tableCounts().write_coordinates, 0);
  // The payment handoff still saves and offers its own transfer.
  const purchase = world.seed({ status: 'approved', key: 'TEST-payment', currentListing: true });
  const handoff = await world.service.prepareHandoff({ operationId: purchase.operation.id, token: purchase.token });
  assert.ok(handoff.payload, 'the payment is offered');
  const coordinates = world.coordinates.get(purchase.operation.id);
  assert.equal(coordinates.kind, 'dem-transfer');
  assert.deepEqual(coordinates.payload, handoff.payload);
  assert.equal(world.tableCounts().write_coordinates, 1);
  assert.equal(world.coordinates.get(operation.id), null);
});

test('two purchases prepared for the same wallet and nonce get different anchor write ids, and a replayed prepare returns the saved id unchanged', async (t) => {
  const world = await admittedWorld(t);
  const first = (await world.prepare('TEST-first')).operation;
  // The account may hold one unpaid purchase, so the first is cancelled before the second is prepared; the chain nonce is unchanged.
  world.ops.transition(first.id, first.status, 'cancelled', { event: 'TEST-cancelled', data: {} });
  const second = (await world.prepare('TEST-second')).operation;
  const [a, b] = [savedRecord(world, first.id), savedRecord(world, second.id)];
  assert.equal(a.expectedNonce, b.expectedNonce);
  assert.notEqual(a.jobId, b.jobId);
  assert.notEqual(a.reservedWriteId, b.reservedWriteId);
  const replay = (await world.prepare('TEST-first')).operation;
  assert.equal(readAnchorReservedWriteId(replay), a.reservedWriteId);
});

// A real prepare for `address`, with a stand-in protocol and verifier, whose chain reads the account nonce `nodeNonce` reports.
function preparedFor(t, { address, nodeNonce, jobId }) {
  const db = openDatabase(':memory:'), identity = 'c'.repeat(64);
  t.after(() => db.close());
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(T0).toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) });
  const chain = { network: 'testnet', pinnedIdentity: identity, networkIdentity: async () => ({ identity, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 15n, getTransactionFees: async () => 1n, getAddressNonce: async (wallet) => { assert.equal(wallet, address); return nodeNonce(); } };
  const protocol = { supportsMode: () => true, assertSellerAdmission: async () => {}, prepareTerms: () => ({ terms: { profile: 'TEST-profile' }, state: { stage: 'identity' } }) };
  const verifier = { verify: async () => ({ transactable: true, anchor: { kind: 'storage-program', locator: 'TEST-locator' }, checks: [], contentHash: identity,
    price: { amount: '1', amountOs: '1000000000' }, payee: '0x' + 'b'.repeat(64), evidence: {}, listing: { seller: {} } }) };
  const service = createPurchaseService({ db, ops, coordinates: createCoordinateStore({ db }), store: { transaction, isUniqueViolation }, chain, verifier, protocol,
    purposes: { APPROVE_PURCHASE: 'TEST-approve' }, challenges: {}, accounts: { listWallets: () => [{ address }] }, generateJobId: () => jobId,
    config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.invalid' } });
  const prepare = () => service.prepare({ accountId: 'TEST-buyer', listingId: 'TEST-listing', version: 1, seller: 'TEST-seller', idempotencyKey: 'TEST-key',
    walletAddress: address, protocol: 'dacs-sr2-wallet-agreement' });
  return { prepare, read: (id) => ops.get('TEST-buyer', id) };
}

test('the saved anchor intent id does not change when the buyer\'s nonce moves between prepare and the wallet plan', async (t) => {
  const w = await finalizedWorld(t);
  await w.build();
  const raw = (await agreementRequest(w, { complete: true })).params[0];
  const address = w.session.wallet.getPublicAccount().address;
  w.node.intercept = (row) => row.body.params[0].message === 'searchStoragePrograms'
    ? new Response(JSON.stringify({ result: 200, response: [], require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } }) : undefined;
  const buyer = preparedFor(t, { address, nodeNonce: () => w.node.nonce, jobId: raw.jobId });
  const { operation } = await buyer.prepare();
  const saved = buyer.read(operation.id).state.protocol.anchorWrite;
  assert.equal(saved.expectedNonce, w.node.nonce + 1);
  // The wallet is used elsewhere before its Agreement CREATE is planned.
  w.node.nonce += 2;
  const atWallet = [];
  const walletFactory = (options) => {
    const wallet = w.session.walletFactory(options);
    return { ...wallet, request: async (input) => {
      atWallet.push({ planned: input.params[0].transaction.content.nonce, nodeNonce: w.node.nonce, id: readAnchorReservedWriteId(buyer.read(operation.id)) });
      return { success: false, error: { code: 'outcome_unknown' } };
    } };
  };
  const bridge = createDemosSr2WalletBridge({ rpcUrl: w.owner.local.endpoint, network: w.session.wallet.getWriteProfile().network,
    journal: w.journal, sourceCapability: w.session.transport, walletFactory, fetchImpl: w.node.fetch, now: w.clock.now });
  const result = await bridge.anchor({ writer: raw.owner, artifactKind: 'Agreement', logicalAddress: raw.logicalAddress, artifact: raw.transaction.content.data[1].data });
  assert.equal(result.status, 'indeterminate', 'the anchor step is not refused');
  assert.equal(atWallet.length, 1, 'the wallet is asked once, after a real plan');
  assert.equal(atWallet[0].planned, atWallet[0].nodeNonce + 1, 'the plan uses the nonce the node reports at plan time');
  assert.notEqual(atWallet[0].planned, saved.expectedNonce);
  assert.equal(atWallet[0].id, saved.reservedWriteId);
  const after = buyer.read(operation.id);
  assert.equal(readAnchorReservedWriteId(after), saved.reservedWriteId);
  assert.equal(after.state.protocol.anchorWrite.expectedNonce, saved.expectedNonce);
});
