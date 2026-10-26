import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { NOW, seller } from './helpers/protocol-fixture.mjs';
import { SDK_WALLET_ADDRESS, sdkSignedCreate, resignedProjection } from './helpers/payment-evidence-wallet-sdk.mjs';

const writer = `did:demos:agent:${SDK_WALLET_ADDRESS.slice(2)}`;
const inputFor = (f, owner = seller.claim) => ({ logicalAddress: f.logicalAddress, artifact: f.artifact,
  writer: owner, artifactKind: 'Deliverable', receiptContentHash: sha256Hex(canonicalize(f.artifact)) });
const firstWrite = (proveLogicalAddressAbsent) => {
  const f = readbackFixture({ adapter: { proveLogicalAddressAbsent } });
  f.state.rows = [];
  return f;
};

async function embeddedFixture(postFork = false) {
  const f = firstWrite(async () => true);
  const input = inputFor(f, writer);
  const plan = await f.adapter.planWrite(input);
  const handoff = await f.adapter.takeStorageAnchorHandoff({ planId: plan.planId, walletAddress: SDK_WALLET_ADDRESS, network: 'test-net' });
  const signedTransaction = await sdkSignedCreate(input, { nonce: plan.nonce, timestamp: NOW, postFork,
    nodeFee: { networkFee: 0, rpcFee: 0 }, prepare: (c) => {
      c.network = handoff.unsignedTransaction.content.network;
      c.chainIdentity = handoff.unsignedTransaction.content.chainIdentity;
    } });
  const walletRecord = { stage: 'broadcast-started', hash: signedTransaction.hash, signedTransaction,
    approved: { owner: writer, logicalAddress: input.logicalAddress, artifactKind: input.artifactKind,
      contentHash: plan.contentHash, envelopeHash: plan.envelopeHash, transaction: handoff.unsignedTransaction } };
  return { ...f, plan, input, walletRecord };
}

for (const postFork of [false, true]) {
  const fork = postFork ? 'post-fork' : 'pre-fork';
  test(`adoption accepts the exact ${fork} SDK transformation and repeats across restart`, async () => {
    const f = await embeddedFixture(postFork);
    const request = { planId: f.plan.planId, walletRecord: f.walletRecord };
    const adopted = await f.adapter.adoptWalletAuthorization(request);
    assert.equal(adopted.stage, 'authorization-issued');
    const journal = createInMemoryDemosSr2Journal(f.journal.records());
    const restarted = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal, fetchImpl: f.fetchImpl });
    assert.deepEqual(await restarted.adoptWalletAuthorization(request), adopted);
    assert.deepEqual(journal.get(f.plan.planId).authorizedTransaction, f.walletRecord.signedTransaction);
  });

  const amount = postFork ? '999999999000000000' : 999999999;
  for (const [label, change] of [
    ...['network_fee', 'rpc_fee', 'additional_fee'].map(key => [`changed ${key}`, c => { c.transaction_fee[key] = amount; }]),
    ['changed RPC fee recipient', c => { c.transaction_fee.rpc_address = seller.address; }],
    ['missing fee', c => { delete c.transaction_fee; }],
    ['missing fee member', c => { delete c.transaction_fee.additional_fee; }],
    ['extra fee member', c => { c.transaction_fee.TEST = 0; }],
    ['wrong fee denomination', c => { c.transaction_fee.network_fee = postFork ? 0 : '0'; }],
    ['negative fee', c => { c.transaction_fee.network_fee = postFork ? '-1' : -1; }],
    ['changed content type', c => { c.type = 'native'; }],
    ['missing content type', c => { delete c.type; }],
    ['extra signed member', c => { c.TEST = true; }],
    ['noncanonical zero amount', c => { c.amount = '00'; }],
    ['changed storage fee', c => { c.gcr_edits[0].amount = amount; }],
    ['changed gas fee', c => { c.gcr_edits[2].amount = amount; }],
    ['changed nonce increment', c => { c.gcr_edits[3].amount = 2; }],
    ['string nonce increment', c => { c.gcr_edits[3].amount = '1'; }],
    ['wrong edit denomination', c => { c.gcr_edits[0].amount = postFork ? 1 : '1000000000'; }],
    ['changed storage target', c => { c.gcr_edits[1].target = `stor-${'a'.repeat(40)}`; }],
    ['changed CREATE sender', c => { c.gcr_edits[1].context.sender = seller.address; }],
    ['changed CREATE operation', c => { c.gcr_edits[1].context.operation = 'DELETE_STORAGE_PROGRAM'; }],
    ['changed CREATE variables', c => { c.gcr_edits[1].context.data.variables.acl = { mode: 'private' }; }],
    ['changed CREATE metadata', c => { c.gcr_edits[1].context.data.metadata.TEST = true; }],
    ['missing edits', c => { delete c.gcr_edits; }],
    ['extra edit', c => { c.gcr_edits.push(structuredClone(c.gcr_edits[0])); }],
    ['missing storage edit', c => { c.gcr_edits.splice(1, 1); }],
    ['reordered edits', c => { c.gcr_edits.reverse(); }],
    ...[0, 2, 3].flatMap(index => [
      [`changed edit ${index} account`, c => { c.gcr_edits[index].account = seller.address; }],
      [`changed edit ${index} operation`, c => { c.gcr_edits[index].operation = index === 3 ? 'remove' : 'add'; }],
    ]),
    ...[0, 1, 2, 3].flatMap(index => [
      [`rollback edit ${index}`, c => { c.gcr_edits[index].isRollback = true; }],
      [`transaction pointer on edit ${index}`, c => { c.gcr_edits[index].txhash = 'a'.repeat(64); }],
      [`extra member on edit ${index}`, c => { c.gcr_edits[index].TEST = true; }],
      [`missing member on edit ${index}`, c => { delete c.gcr_edits[index].type; }],
    ]),
  ]) {
    test(`adoption refuses ${fork} ${label} without changing the retained handoff`, async () => {
      const f = await embeddedFixture(postFork);
      const before = f.journal.records();
      // JSON round-trip breaks the SDK's duplicated metadata references.
      const content = JSON.parse(JSON.stringify(f.walletRecord.signedTransaction.content));
      change(content);
      f.walletRecord.signedTransaction = await resignedProjection(content);
      f.walletRecord.hash = f.walletRecord.signedTransaction.hash;
      await assert.rejects(f.adapter.adoptWalletAuthorization({ planId: f.plan.planId, walletRecord: f.walletRecord }), { code: 'invalid' });
      assert.deepEqual(f.journal.records(), before);
    });
  }
}

for (const [label, rows] of [
  ['empty', () => []],
  ['stale empty with an earlier CREATE', () => []],
  ['only another writer', f => f.rows],
  ['only another logical name', f => [{ ...f.rows[0], programName: 'TEST-other-name' }]],
]) {
  test(`first-write planning keeps an unqualified ${label} index indeterminate`, async () => {
    const f = firstWrite(undefined);
    f.state.rows = rows(f);
    if (label.includes('earlier')) {
      const fetchImpl = f.fetchImpl;
      f.adapter = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal: f.journal,
        fetchImpl: (url, init) => JSON.parse(init.body ?? '{}')?.params?.[0]?.message === 'getAddressNonce'
          ? new Response(JSON.stringify({ result: 200, response: 1 }), { headers: { 'x-dacs-simulation': 'fixture' } }) : fetchImpl(url, init) });
    }
    const owner = label === 'only another writer' ? writer : seller.claim;
    await assert.rejects(f.adapter.planWrite(inputFor(f, owner)), { code: 'indeterminate' });
    assert.deepEqual(f.journal.records(), []);
  });
}

for (const [label, decision] of [['refused', false], ['missing', undefined], ['scalar', 'absent'], ['unqualified object', { absent: true }]]) {
  test(`first-write planning refuses a ${label} absence decision`, async () => {
    const f = firstWrite(async () => decision);
    await assert.rejects(f.adapter.planWrite(inputFor(f)), { code: 'indeterminate' });
    assert.deepEqual(f.journal.records(), []);
  });
}

test('an unavailable absence policy keeps its cause and retains no plan', async () => {
  const cause = new Error('TEST complete history unavailable');
  const f = firstWrite(async () => { throw cause; });
  await assert.rejects(f.adapter.planWrite(inputFor(f)), error => error.code === 'indeterminate' && error.cause === cause);
  assert.deepEqual(f.journal.records(), []);
});

test('an absence policy that ignores abort cannot exceed the aggregate deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = firstWrite(() => new Promise(() => {}));
  const work = assert.rejects(f.adapter.planWrite(inputFor(f)), error => error.code === 'indeterminate' && error.cause?.name === 'TimeoutError');
  await new Promise(setImmediate);
  t.mock.timers.tick(10001);
  await work;
  assert.deepEqual(f.journal.records(), []);
});

test('qualified absence binds the exact chain, writer, name and account nonce once across concurrent plans and restart', async () => {
  const decisions = [];
  const f = firstWrite(async request => { decisions.push(request); return true; });
  const other = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal: f.journal, fetchImpl: f.fetchImpl, now: () => NOW });
  const plans = await Promise.all([f.adapter.planWrite(inputFor(f)), other.planWrite(inputFor(f))]);
  assert.deepEqual(plans[0], plans[1]);
  assert.equal(plans[0].stage, 'prepared');
  assert.equal(decisions.length, 1);
  const { signal, ...decision } = decisions[0];
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(decision, { rpcOrigin: 'http://127.0.0.1:9922', chainIdentity: f.block.validation_data.chainIdentity,
    logicalAddress: f.logicalAddress, writer: seller.claim, owner: seller.address, programName: f.native.programName, accountNonce: 0 });
  const journal = createInMemoryDemosSr2Journal(f.journal.records());
  const restarted = readbackFixture({ journal });
  assert.deepEqual(await restarted.adapter.planWrite(inputFor(f)), plans[0]);
  assert.equal(journal.records().length, 1);
});

test('a dropped prepared journal write issues no plan after qualified absence', async () => {
  let decisions = 0;
  const f = firstWrite(async () => { decisions += 1; return true; });
  f.journal.put = () => {};
  await assert.rejects(f.adapter.planWrite(inputFor(f)), { code: 'journal-error' });
  assert.equal(decisions, 1);
  assert.deepEqual(f.journal.records(), []);
});
