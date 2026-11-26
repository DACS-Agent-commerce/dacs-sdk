// The passive stage reader: one stage of one purchase answered verified, unused or
// unavailable from authenticated retained rows and pinned passive chain reads,
// with no effect. It runs on the composed public service over the package's own
// adapters; chain reads are TEST doubles or the native source over a fake node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';
import { installPackedPair } from './helpers/packed-install.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { compositionWorld } = await import('./helpers/public-composition-world.mjs');
const { passiveNativeWorld, HASH, IDENTITY } = await import('./helpers/passive-native-world.mjs');
const { verifyDealPassive, OperationError } = await import('../src/index.mjs');

const admitted = (t) => { setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held')); };
const NATIVE_TERMS = { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' };
const PRICE_OS = '2500000000', NONCE = 7, BLOCK = 7;
const TAKER = '9'.repeat(64), OTHER_HASH = '8'.repeat(64), OTHER_ADDRESS = '0x' + '6'.repeat(64);
const READS = ['networkIdentity', 'observePassiveTransfer', 'getTransaction', 'getAddressNonce', 'findTransferAtNonce'];
const NO_READS = Object.fromEntries(READS.map((name) => [name, 0]));
const typeError = (message) => (error) => error instanceof TypeError && error.message === message;
const notFound = (error) => error instanceof OperationError && error.code === 'not_found';
const unavailable = (operation, stage = 'payment') => ({ status: 'unavailable', stage, operationId: operation.id });
const verified = (operation) => ({ status: 'verified', stage: 'payment', operationId: operation.id, evidence: { txHash: HASH, nonce: NONCE, chainIdentity: IDENTITY } });

// Counts every chain read the service makes, on the chain object it holds, and keeps the options each read received.
function countReads(chain) {
  const counts = { ...NO_READS }, options = {};
  for (const name of READS) {
    const read = chain[name];
    if (typeof read !== 'function') continue;
    chain[name] = function countedRead(...args) { counts[name]++; options[name] = args.at(-1); return read.apply(this, args); };
  }
  return { counts, options };
}

// One included transfer from the buyer wallet whose passive observation and canonical body agree member for member.
// `observation`, `body` and `content` override single members; `omit` removes observation members.
function transfer(world, operation, { hash = HASH, payee = operation.terms.seller.payee, amountOs = PRICE_OS, observation = {}, body = {}, content = {}, omit = [] } = {}) {
  const payer = world.wallet.address;
  const seen = { status: 'included', txHash: hash, payer, payee, amountOs, blockNumber: BLOCK, sourceDisposition: 'included', ...observation };
  for (const name of omit) delete seen[name];
  return { hash, observation: seen,
    body: { hash, status: 'confirmed', blockNumber: BLOCK, ...body, content: { type: 'native', from: payer, from_ed25519_address: payer, to: payee, amount: amountOs, nonce: NONCE, ...content } } };
}

// A complete set of agreeing passive reads on the world's chain: each transfer answers by its own hash. Returns the read counter.
function decisiveReads(world, transfers, { accountNonce = NONCE, slot = { status: 'not-found' } } = {}) {
  const byHash = new Map(transfers.map((entry) => [entry.hash, entry]));
  Object.assign(world.chain, {
    observePassiveTransfer: async (hash) => byHash.get(hash)?.observation ?? { status: 'not-found' },
    getTransaction: async (hash) => byHash.get(hash)?.body ?? null,
    getAddressNonce: async () => accountNonce,
    findTransferAtNonce: async () => slot,
  });
  return countReads(world.chain);
}

// A composed world with one saved purchase: a native payment with a reported transfer unless `reported` is null (then only
// the reserved write). `ask(extra)` calls the service's passive reader for its payment stage.
async function paidWorld(t, { reported = HASH, status = 'broadcast_reported', nonceSlotProof, seed = {}, ...options } = {}) {
  const world = await compositionWorld(t, { shippedAdapters: true, ...(nonceSlotProof ? { nonceSlotProof } : {}), ...options });
  const { operation } = world.seed({ status, key: 'TEST-paid', protocolTerms: NATIVE_TERMS, ...(reported ? { reportedTxHash: reported } : { handoff: true }), ...seed });
  const request = { accountId: world.accountId, operationId: operation.id, stage: 'payment' };
  return { world, operation, request, ask: (extra = {}) => world.service.verifyDealPassive({ ...request, ...extra }) };
}
const assertNoEffects = (world) => assert.deepEqual({ broadcasts: world.chain.broadcasts, sellerLookups: world.counters.sellerLookups, challenges: world.counters.challengesIssued },
  { broadcasts: 0, sellerLookups: 0, challenges: 0 });
// The slot taker of the reserved nonce: a confirmed transfer from the buyer wallet to another payee.
const takerReads = (world, operation, overrides = {}, options = {}) => decisiveReads(world, [transfer(world, operation, { hash: TAKER, payee: OTHER_ADDRESS, amountOs: '1000000000', ...overrides })],
  { accountNonce: NONCE + 1, slot: { status: 'found', hash: TAKER }, ...options });

test('a foreign service, a malformed request and an unknown operation are refused before any chain read', async (t) => {
  admitted(t);
  const { world, operation, request } = await paidWorld(t);
  const { counts } = decisiveReads(world, [transfer(world, operation)]);
  let foreignCalls = 0;
  const foreign = { verifyDealPassive: async () => { foreignCalls++; return verified(operation); } };
  for (const service of [foreign, { ...world.service }, null, 'TEST-service', undefined]) {
    await assert.rejects(verifyDealPassive({ ...request, service }), typeError('passive_service_invalid'), String(service));
  }
  assert.equal(foreignCalls, 0);
  for (const malformed of [undefined, null, 'TEST-request', [request]]) await assert.rejects(verifyDealPassive(malformed), typeError('passive_request_invalid'));
  const service = world.service;
  // Shape and members first, then the ids, then the stage and signal.
  for (const malformed of [null, 'TEST-request', [request], { ...request, token: 'TEST-token' }, { stage: 'TEST-stage', txHash: HASH }]) {
    await assert.rejects(service.verifyDealPassive(malformed), typeError('passive_request_invalid'), JSON.stringify(malformed));
  }
  for (const ids of [{ accountId: undefined }, { accountId: '' }, { accountId: 7 }, { operationId: '' }, { operationId: null }]) {
    await assert.rejects(service.verifyDealPassive({ ...request, stage: 'TEST-stage', ...ids }), notFound, JSON.stringify(ids));
  }
  for (const stage of [undefined, '', 'Payment', 'settlement']) await assert.rejects(service.verifyDealPassive({ ...request, stage }), typeError('passive_request_invalid'), String(stage));
  for (const signal of [null, {}, 'TEST-signal']) await assert.rejects(service.verifyDealPassive({ ...request, signal }), typeError('passive_request_invalid'), String(signal));
  // A plugin-style purchase id is not the SDK operation id, and another account owns nothing here.
  for (const other of [{ operationId: 'TEST-plugin-purchase-1' }, { accountId: `local:${OTHER_ADDRESS}` }]) {
    await assert.rejects(verifyDealPassive({ service, ...request, ...other }), notFound, JSON.stringify(other));
  }
  assert.deepEqual(counts, NO_READS);
  assert.deepEqual(await verifyDealPassive({ service, ...request }), verified(operation), 'the same request through the real service is decisive');
});

test('passive payment verification authenticates the reserved write and the pinned included transfer without an effect', async (t) => {
  admitted(t);
  // The real source reader over a retained signed transfer of this purchase's own payer, payee, price, nonce and hash.
  const sourced = await paidWorld(t, { native: ({ payer, payee }) => passiveNativeWorld({ payer, payee, amount: PRICE_OS }) });
  const { native } = sourced.world;
  t.after(() => native.source.close());
  await native.seed();
  const reader = native.source.chainReader();
  assert.equal((await reader.observePassiveTransfer(HASH, {})).sourceDisposition, 'included');
  for (const name of READS) sourced.world.chain[name] = reader[name].bind(reader);
  // The source's purchase and plain observers record what they read; the passive reader must never call them.
  const recordingReads = { observePurchaseTransfer: 0, observeTransfer: 0 };
  for (const name of Object.keys(recordingReads)) sourced.world.chain[name] = (...args) => { recordingReads[name]++; return reader[name](...args); };
  const { counts } = countReads(sourced.world.chain);
  let steps = 0;
  native.source.onPurchaseStep(() => { steps++; });
  const records = JSON.stringify([...native.records]), callsBefore = native.calls.length;
  assert.deepEqual(await sourced.ask(), verified(sourced.operation));
  assert.deepEqual(counts, { networkIdentity: 1, observePassiveTransfer: 1, getTransaction: 1, getAddressNonce: 0, findTransferAtNonce: 0 });
  assert.deepEqual(recordingReads, { observePurchaseTransfer: 0, observeTransfer: 0 });
  assert.deepEqual(native.writes, []);
  assert.equal(JSON.stringify([...native.records]), records);
  assert.equal(steps, 0);
  assert.ok(native.calls.slice(callsBefore).every((message) => ['getBlockByNumber', 'getTransactionStatus', 'getTxByHash'].includes(message)), native.calls.join());
  assertNoEffects(sourced.world);

  // The source refuses a body that differs from the retained signed transfer, and a native hash with no retained intent.
  for (const retained of [true, false]) {
    const refused = await paidWorld(t, { native: ({ payer, payee }) => passiveNativeWorld({ payer, payee, amount: PRICE_OS }) });
    t.after(() => refused.world.native.source.close());
    if (retained) { await refused.world.native.seed(); refused.world.native.transaction.content = { ...refused.world.native.transaction.content, timestamp: 1 }; }
    const source = refused.world.native.source.chainReader();
    for (const name of READS) refused.world.chain[name] = source[name].bind(source);
    assert.deepEqual(await refused.ask(), unavailable(refused.operation), retained ? 'a body that differs from the retained transfer' : 'no retained intent');
  }

  // Every other member agrees; one disagreement each answers unavailable.
  const cases = [
    ['a body paying another address under the same hash, payer and nonce', { content: { to: OTHER_ADDRESS } }],
    ['a native observation with no source disposition', { omit: ['sourceDisposition'] }],
    ['a native observation whose source disposition is failed', { observation: { sourceDisposition: 'failed' } }],
  ];
  for (const [label, overrides] of [['the agreeing control', {}], ...cases]) {
    const { world, operation, ask } = await paidWorld(t);
    const { counts: reads } = decisiveReads(world, [transfer(world, operation, overrides)]);
    assert.deepEqual(await ask(), label === 'the agreeing control' ? verified(operation) : unavailable(operation), label);
    assert.deepEqual([reads.observePassiveTransfer, reads.getTransaction], [1, 1], label);
  }
  const unread = await paidWorld(t);
  decisiveReads(unread.world, [transfer(unread.world, unread.operation)]);
  delete unread.world.chain.observePassiveTransfer;
  assert.deepEqual(await unread.ask(), unavailable(unread.operation), 'a chain with no passive reader');
});

test('passive verification leaves operation rows, coordinates, suspensions and expiry bytes unchanged', async (t) => {
  admitted(t);
  const suspended = { protocol: { sellerSuspension: { suspensionId: 'TEST-suspension', reason: 'writes_stopped' } } };
  const cases = [
    ['verified', {}, (world, operation) => decisiveReads(world, [transfer(world, operation)]), verified],
    ['verified while suspended', { seed: { state: suspended } }, (world, operation) => decisiveReads(world, [transfer(world, operation)]), verified],
    ['unused', { reported: null, nonceSlotProof: 'account' }, (world, operation) => takerReads(world, operation), (operation) => ({ status: 'unused', stage: 'payment', operationId: operation.id,
      evidence: { reservedNonce: NONCE, consumingTxHash: TAKER, chainIdentity: IDENTITY } })],
    ['unavailable', {}, () => {}, unavailable],
    ['an expired approval', { reported: null, status: 'awaiting_approval', seed: { expiresAt: new Date(Date.now() - 60_000).toISOString() } }, () => {}, unavailable],
  ];
  for (const [label, options, reads, expected] of cases) {
    const { world, operation, ask } = await paidWorld(t, options);
    reads(world, operation);
    const before = world.rows();
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await ask(), expected(operation), label);
    assert.equal(world.rows(), before, label);
    assertNoEffects(world);
  }
});

test('a diagnostic projection, a foreign stage proof and a mismatched chain identity are unavailable', async (t) => {
  admitted(t);
  const otherIdentity = await paidWorld(t);
  decisiveReads(otherIdentity.world, [transfer(otherIdentity.world, otherIdentity.operation)]);
  otherIdentity.world.chain.networkIdentity = async () => ({ identity: 'e'.repeat(64), mode: 'public-chain-read' });
  assert.deepEqual(await otherIdentity.ask(), unavailable(otherIdentity.operation), 'another chain identity');
  const coarse = [
    ['an observation of another purchase\'s hash', {}, { observation: { txHash: OTHER_HASH } }],
    ['a stored settled status with a mismatched canonical body', { status: 'settled_verified' }, { body: { hash: OTHER_HASH } }],
    ['an included flag with a body from another payer', {}, { content: { from: OTHER_ADDRESS, from_ed25519_address: OTHER_ADDRESS } }],
  ];
  for (const [label, options, overrides] of coarse) {
    const { world, operation, ask } = await paidWorld(t, options);
    decisiveReads(world, [transfer(world, operation, overrides)]);
    assert.deepEqual(await ask(), unavailable(operation), label);
  }
  // Each proof member changed alone, from a set that alone answers verified, so the verifier's own comparison answers.
  const members = [
    ['the agreeing control', {}],
    ['the observed payer', { observation: { payer: OTHER_ADDRESS } }],
    ['the body nonce', { content: { nonce: NONCE + 1 } }],
    ['the observed amount', { observation: { amountOs: '2500000001' } }],
    ['the observed and body payee', { payee: OTHER_ADDRESS }],
    ['the body hash', { body: { hash: OTHER_HASH } }],
    ['the body status', { body: { status: 'pending' } }],
    ['the body block', { body: { blockNumber: BLOCK + 1 } }],
  ];
  for (const [label, overrides] of members) {
    const { world, operation, ask } = await paidWorld(t);
    const { counts } = decisiveReads(world, [transfer(world, operation, overrides)]);
    assert.deepEqual(await ask(), label === 'the agreeing control' ? verified(operation) : unavailable(operation), label);
    assert.deepEqual([counts.observePassiveTransfer, counts.getTransaction], [1, 1], label);
  }
});

test('unused needs a confirmed other transaction at the reserved nonce with account nonce-slot proof and never fits this purchase\'s own payment', async (t) => {
  admitted(t);
  const proven = { reported: null, nonceSlotProof: 'account' };
  const taken = await paidWorld(t, proven);
  const { counts } = takerReads(taken.world, taken.operation);
  assert.deepEqual(await taken.ask(), { status: 'unused', stage: 'payment', operationId: taken.operation.id, evidence: { reservedNonce: NONCE, consumingTxHash: TAKER, chainIdentity: IDENTITY } });
  assert.deepEqual(counts, { networkIdentity: 1, observePassiveTransfer: 1, getTransaction: 1, getAddressNonce: 1, findTransferAtNonce: 1 });
  const cases = [
    ['the purchase\'s own payment under another hash', proven, (world, operation) => takerReads(world, operation, { payee: operation.terms.seller.payee, amountOs: PRICE_OS })],
    ['an unreadable taker', proven, (world, operation) => takerReads(world, operation, { observation: { status: 'unavailable', reason: 'TEST-unreadable' } })],
    ['a taker whose read rejects', proven, (world, operation) => { takerReads(world, operation); world.chain.observePassiveTransfer = async () => { throw new Error('TEST-read-failed'); }; }],
    ['a taker whose body did not execute', proven, (world, operation) => takerReads(world, operation, { body: { status: 'failed' } })],
    ['a taker whose body pays another address than its observation', proven, (world, operation) => takerReads(world, operation, { content: { to: world.wallet.address } })],
    ['a merely advanced nonce', proven, (world, operation) => takerReads(world, operation, {}, { slot: { status: 'not-found' } })],
    ['the default setting', { reported: null }, (world, operation) => takerReads(world, operation)],
  ];
  for (const [label, options, reads] of cases) {
    const { world, operation, ask } = await paidWorld(t, options);
    reads(world, operation);
    assert.deepEqual(await ask(), unavailable(operation), label);
  }
});

test('the anchor stage answers unavailable after authentication with no chain read', async (t) => {
  admitted(t);
  const { world, operation, request } = await paidWorld(t, { nonceSlotProof: 'account' });
  // The payment would be decisive: the reported transfer verifies and a confirmed other transaction took the reserved nonce.
  const { counts } = decisiveReads(world, [transfer(world, operation), transfer(world, operation, { hash: TAKER, payee: OTHER_ADDRESS, amountOs: '1000000000' })],
    { accountNonce: NONCE + 1, slot: { status: 'found', hash: TAKER } });
  const before = world.rows(), calls = world.native.calls.length;
  await assert.rejects(verifyDealPassive({ ...request, stage: 'anchor', service: { verifyDealPassive: world.service.verifyDealPassive } }), typeError('passive_service_invalid'));
  await assert.rejects(world.service.verifyDealPassive({ ...request, stage: 'anchor', accountId: `local:${OTHER_ADDRESS}` }), notFound);
  for (const ask of [() => world.service.verifyDealPassive({ ...request, stage: 'anchor' }), () => verifyDealPassive({ service: world.service, ...request, stage: 'anchor' })]) {
    assert.deepEqual(await ask(), unavailable(operation, 'anchor'));
  }
  assert.deepEqual(counts, NO_READS);
  assert.equal(world.native.calls.length, calls, 'no retained-anchor read reaches the source');
  assert.equal(world.rows(), before);
  assert.equal((await world.service.verifyDealPassive(request)).status, 'verified', 'the payment stage of the same purchase is decisive');
});

test('a read failure, an abort and a changed retained row cannot produce a decisive answer', async (t) => {
  admitted(t);
  // Each read rejecting. The two nonce reads run only with account nonce-slot proof, after a reported transfer that does not verify.
  for (const name of READS) {
    const nonceRead = name === 'getAddressNonce' || name === 'findTransferAtNonce';
    const { world, operation, ask } = await paidWorld(t, nonceRead ? { nonceSlotProof: 'account' } : {});
    const reads = nonceRead ? takerReads(world, operation) : decisiveReads(world, [transfer(world, operation)]);
    const read = world.chain[name];
    world.chain[name] = async (...args) => { await read(...args); throw new Error(`TEST-${name}-failed`); };
    assert.deepEqual(await ask(), unavailable(operation), name);
    assert.equal(reads.counts[name], 1, `${name} was reached`);
  }

  // A read that never settles: the caller's abort and the deadline each abort the signal it received.
  const hanging = (world, name) => {
    let reached;
    const called = new Promise((resolve) => { reached = resolve; });
    world.chain[name] = (...args) => { reached(args.at(-1)?.signal); return new Promise(() => {}); };
    return called;
  };
  for (const name of ['observePassiveTransfer', 'getTransaction', 'findTransferAtNonce']) {
    for (const ending of ['abort', 'deadline']) {
      const { world, operation, ask } = await paidWorld(t, name === 'findTransferAtNonce' ? { nonceSlotProof: 'account', reported: null } : {});
      if (name === 'findTransferAtNonce') takerReads(world, operation); else decisiveReads(world, [transfer(world, operation)]);
      const signalOf = hanging(world, name);
      if (ending === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
      const controller = new AbortController();
      const answer = ask({ signal: controller.signal });
      const signal = await signalOf;
      assert.ok(signal instanceof AbortSignal && !signal.aborted, `${name} received a live signal`);
      if (ending === 'abort') controller.abort(new Error('TEST-caller-abort')); else t.mock.timers.tick(8000);
      assert.deepEqual(await answer, unavailable(operation), `${name} ${ending}`);
      assert.equal(signal.aborted, true, `${name} ${ending} aborted the read's signal`);
      if (ending === 'deadline') t.mock.timers.reset();
    }
  }

  // The account nonce read takes no signal: one that settles after the deadline starts no further read.
  const late = await paidWorld(t, { nonceSlotProof: 'account' });
  const lateReads = takerReads(late.world, late.operation);
  let settle;
  late.world.chain.getAddressNonce = () => new Promise((resolve) => { settle = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lateAnswer = late.ask();
  while (!settle) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.deepEqual(await lateAnswer, unavailable(late.operation), 'the deadline');
  t.mock.timers.reset();
  settle(NONCE + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateReads.counts.findTransferAtNonce, 0, 'a late nonce answer starts no slot read');

  // A row moved, a coordinate changed or the hold landing while a read is in flight.
  const changes = [
    ['a status move', (world, operation) => world.ops.transition(operation.id, operation.status, 'payment_uncertain', { data: { reason: 'TEST-moved' } }), true],
    ['a coordinate change', (world, operation) => world.coordinates.recordObservation(operation.id, { status: 'pending', txHash: HASH }, false, HASH), true],
    ['a hold landing', () => setPurchaseAdmission('held'), false],
  ];
  for (const [label, change, rowChanged] of changes) {
    const { world, operation, ask } = await paidWorld(t);
    decisiveReads(world, [transfer(world, operation)]);
    const read = world.chain.getTransaction, before = world.rows();
    let changed = false;
    world.chain.getTransaction = async (...args) => { change(world, operation); changed = true; return read(...args); };
    assert.deepEqual(await ask(), unavailable(operation), label);
    assert.equal(changed, true, `${label} landed during the read`);
    assert.equal(world.rows() !== before, rowChanged, `${label} ${rowChanged ? 'changed' : 'left'} the retained rows`);
    setPurchaseAdmission('testnet-tp1');
  }
});

test('a provider that mimics the local account answers is refused for a package-created service', async (t) => {
  admitted(t);
  let provider = 'mimic';
  const accountsFor = (accounts) => ({ mimic: { accountId: accounts.accountId, listWallets: (id) => accounts.listWallets(id) }, spread: { ...accounts }, real: accounts })[provider];
  const { world, operation, request } = await paidWorld(t, { accountsFor });
  const { counts } = decisiveReads(world, [transfer(world, operation)]);
  await assert.rejects(world.service.verifyDealPassive(request), notFound, 'a provider with the same answers');
  provider = 'spread';
  await assert.rejects(world.rebuild().service.verifyDealPassive(request), notFound, 'a spread copy of the real account');
  assert.deepEqual(counts, NO_READS);
  provider = 'real';
  assert.deepEqual(await world.rebuild().service.verifyDealPassive(request), verified(operation), 'the same purchase through the real local account');
});

test('held, passive-only and admitted services answer unavailable, unavailable and decisive after authentication', async (t) => {
  t.after(() => setPurchaseAdmission('held'));
  const answers = async (world, operation, request) => {
    await assert.rejects(world.service.verifyDealPassive({ ...request, accountId: `local:${OTHER_ADDRESS}` }), notFound);
    return [await world.service.verifyDealPassive(request), await verifyDealPassive({ service: world.service, ...request })];
  };
  for (const stopped of [undefined, () => true]) {
    const label = stopped ? 'stopped' : 'running';
    const held = await paidWorld(t, { stopped }), passiveOnly = await paidWorld(t, { stopped, passiveOnly: true });
    const heldReads = decisiveReads(held.world, [transfer(held.world, held.operation)]), passiveReads = decisiveReads(passiveOnly.world, [transfer(passiveOnly.world, passiveOnly.operation)]);
    assert.deepEqual(await answers(held.world, held.operation, held.request), [unavailable(held.operation), unavailable(held.operation)], `held ${label}`);
    assert.deepEqual(await answers(passiveOnly.world, passiveOnly.operation, passiveOnly.request), [unavailable(passiveOnly.operation), unavailable(passiveOnly.operation)], `passive-only ${label}`);
    setPurchaseAdmission('testnet-tp1');
    const open = await paidWorld(t, { stopped });
    decisiveReads(open.world, [transfer(open.world, open.operation)]);
    assert.deepEqual(await answers(open.world, open.operation, open.request), [verified(open.operation), verified(open.operation)], `admitted ${label}`);
    assert.deepEqual(await passiveOnly.world.service.verifyDealPassive(passiveOnly.request), unavailable(passiveOnly.operation), `passive-only stays unavailable once admitted, ${label}`);
    setPurchaseAdmission('held');
    assert.deepEqual([heldReads.counts, passiveReads.counts], [NO_READS, NO_READS], label);
  }

  // The protocol's buyer-access refusal is the answer, before any read.
  admitted(t);
  const refusal = new OperationError('buyer_access_closed', 'TEST buyer access refused');
  let refusing = true;
  const { world, operation, request } = await paidWorld(t, { buyerAccess: { assertWallet() { if (refusing) throw refusal; } } });
  const { counts } = decisiveReads(world, [transfer(world, operation)]);
  const rows = world.rows(), tables = world.tableCounts();
  await assert.rejects(world.service.verifyDealPassive(request), (error) => error === refusal);
  assert.deepEqual(counts, NO_READS);
  assert.equal(world.rows(), rows);
  assert.deepEqual(world.tableCounts(), tables);
  refusing = false;
  assert.deepEqual(await world.service.verifyDealPassive(request), verified(operation), 'the same world without the refusal');
});

test('the installed package binds the passive stage reader to a held service', (t) => {
  const { app, run } = installPackedPair(t);
  writeFileSync(join(app, 'passive.mjs'), `
    import { DatabaseSync } from 'node:sqlite';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
    const client = await import('@kynesyslabs/dacs-client');
    const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'TEST-authority', connectionId: 'TEST-connection' };
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async (scope) => ({ local: { ...scope.local },
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const admission = { binding, currentLocal: () => ({ ...local }) };
    const db = new DatabaseSync(':memory:');
    db.exec(client.PURCHASE_STATE_SCHEMA);
    const store = client.createSqlitePurchaseStore(), identity = 'f'.repeat(64);
    const accounts = client.createLocalPurchaseAccount({ db, store, wallet: '0x' + 'b'.repeat(64) });
    const wallet = accounts.listWallets(accounts.accountId)[0].address, payee = '0x' + 'c'.repeat(64);
    const ops = client.createPurchaseOperations({ db, store, handoffSecret: 'TEST-'.repeat(8), handoffTtlMs: 86400000 });
    const coordinates = client.createCoordinateStore({ db });
    const domain = { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: identity };
    const { operation } = ops.createIdempotent({ accountId: accounts.accountId, kind: 'purchase', idempotencyKey: 'TEST-paid', request: {}, status: 'broadcast_reported',
      terms: { buyer: { accountId: accounts.accountId, wallet }, seller: { claim: 'TEST-seller', payee }, price: { amount: '2.5', amountOs: '2500000000' }, network: 'testnet',
        rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: identity }, domain },
      termsHash: identity, state: { protocol: {} }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: wallet, nonceFence: 6, expectedNonce: 7, target: payee, amountOs: '2500000000', payload: {} });
    coordinates.reportHash(operation.id, 'a'.repeat(64));
    let reads = 0;
    const read = async () => { reads++; throw new Error('TEST no chain read'); };
    const chain = { network: 'testnet', pinnedIdentity: identity, getTransactionFees: async () => 1n, networkIdentity: read, observePassiveTransfer: read, getTransaction: read, getAddressNonce: read, findTransferAtNonce: read };
    const request = { accountId: accounts.accountId, operationId: operation.id, stage: 'payment' };
    const answers = {};
    for (const stopped of [undefined, () => true]) {
      for (const passiveOnly of [false, true]) {
        const service = client.createPurchaseService({ db, ops, coordinates, accounts, chain, store, config: {}, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, admission,
          feeCeilingOs: client.PAID_WRITE_FEE_CEILING_OS, ...(stopped ? { stopped } : {}), ...(passiveOnly ? { passiveOnly } : {}) });
        const label = (passiveOnly ? 'passive-only' : 'held') + (stopped ? ' stopped' : '');
        answers[label] = [await client.verifyDealPassive({ service, ...request }), await service.verifyDealPassive(request)];
      }
    }
    const foreign = await client.verifyDealPassive({ service: { verifyDealPassive: async () => ({ status: 'verified' }) }, ...request }).catch((error) => error.constructor.name + ':' + error.message);
    console.log(JSON.stringify({ answers, foreign, reads, operationId: operation.id }));
  `);
  const { answers, foreign, reads, operationId } = JSON.parse(run(process.execPath, ['passive.mjs'], app));
  const held = { status: 'unavailable', stage: 'payment', operationId };
  assert.deepEqual(answers, { held: [held, held], 'passive-only': [held, held], 'held stopped': [held, held], 'passive-only stopped': [held, held] });
  assert.equal(foreign, 'TypeError:passive_service_invalid');
  assert.equal(reads, 0);
});
