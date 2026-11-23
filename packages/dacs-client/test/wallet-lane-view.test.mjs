import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as journalEntry from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { agreementRequest } from './helpers/tp1-node-fixture.mjs';

const { createDemosSr2WalletBridge } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { nativeAgreementPaymentConfig } = await import('../src/dacs/native-agreement-payment-consumer.mjs');
const { createWalletLaneView, walletLane, walletLaneKey, openDurableWalletJournal, DurableWalletJournalError } = journalEntry;
const laneInput = { network: 'testnet', chainIdentity: '1'.repeat(64), address: '0x' + '2'.repeat(64) };
const started = { stage: 'broadcast-started', nonce: 1, hash: '3'.repeat(64), signedTransaction: { hash: '3'.repeat(64) } };
const accepted = { ...started, stage: 'broadcast-accepted' };

function durableWorld(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-lane-view-'));
  const path = join(directory, 'wallet.sqlite');
  let journal = openDurableWalletJournal({ path, mode: 'create', lockTimeoutMs: 0, ...options });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get journal() { return journal; }, reopen() {
    journal.close();
    journal = openDurableWalletJournal({ path, mode: 'open', lockTimeoutMs: 0, ...options });
    return createWalletLaneView({ journal });
  } };
}

function bridge(w, walletFactory) {
  return createDemosSr2WalletBridge({ rpcUrl: w.owner.local.endpoint, network: w.session.wallet.getWriteProfile().network,
    journal: w.journal, sourceCapability: w.session.transport, walletFactory, fetchImpl: w.node.fetch, now: w.clock.now });
}

function sessionLane(w) {
  return walletLane({ network: w.session.wallet.getWriteProfile().network,
    chainIdentity: w.session.transport.pins.chainIdentity, address: w.session.wallet.getPublicAccount().address });
}

test("the public wallet-lane view reads the record the client's wallet wrote through the storage-anchor bridge, at the same journal key", async t => {
  const w = await finalizedWorld(t); await w.build();
  const request = await agreementRequest(w, { complete: true }), raw = request.params[0];
  w.node.intercept = row => row.body.params[0].message === 'searchStoragePrograms'
    ? new Response(JSON.stringify({ result: 200, response: [], require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } }) : undefined;
  const anchor = bridge(w, options => {
    const wallet = w.session.walletFactory(options);
    return { ...wallet, request: async input => {
      const answer = await wallet.request(input);
      return answer.success ? { success: false, error: { code: 'outcome_unknown' } } : answer;
    } };
  });
  const result = await anchor.anchor({ writer: raw.owner, artifactKind: 'Agreement', logicalAddress: raw.logicalAddress, artifact: raw.transaction.content.data[1].data });
  assert.equal(result.status, 'indeterminate');
  assert.equal(w.node.broadcasts.length, 1);
  const lane = sessionLane(w), key = walletLaneKey(lane);
  const records = (await w.journal.entries()).filter(([key]) => key.startsWith('sr2/wallet/'));
  assert.equal(records.length, 1);
  assert.equal(records[0][0], key);
  assert.equal(await w.journal.get(lane), undefined);
  const record = await createWalletLaneView({ journal: w.journal }).get(lane);
  assert.deepEqual(record, records[0][1]);
  assert.equal(record.stage, 'sr2-readback-pending');
  assert.equal(record.hash, record.signedTransaction.hash);
});

test("the public wallet-lane view and the anchor journal the storage-anchor bridge gives its wallet share one key, one readback-pending rule and one lane lock", async t => {
  const w = await finalizedWorld(t); await w.build();
  let internal;
  bridge(w, options => { internal = options.anchorJournal; return w.session.walletFactory(options); });
  const lane = sessionLane(w), view = createWalletLaneView({ journal: w.journal });
  await internal.put(lane, started);
  assert.deepEqual(await view.get(lane), started);
  await view.put(lane, accepted);
  assert.deepEqual(await internal.get(lane), { ...accepted, stage: 'sr2-readback-pending' });
  await internal.withWalletLock(lane, async () => {
    assert.deepEqual(w.journal.inspectLocks().map(lock => lock.key), [walletLaneKey(lane)]);
    await assert.rejects(view.withWalletLock(lane, () => assert.fail('must not enter')), { code: 'journal-reentrant' });
  });
});

test('the sr2/wallet/ journal prefix is spelled in one client source file', () => {
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter(path => path.endsWith('.mjs')
    && readFileSync(new URL(path, root), 'utf8').includes('sr2/wallet/')).map(path => 'src/' + path).sort();
  assert.deepEqual(files, ['src/wallet/wallet-lane.mjs']);
});

test("walletLane is the wallet's JSON lane string and walletLaneKey prefixes it with sr2/wallet/, refusing a lane that is not a non-empty string", () => {
  const lane = walletLane(laneInput);
  assert.equal(lane, JSON.stringify(['testnet', '1'.repeat(64), '0x' + '2'.repeat(64)]));
  assert.equal(walletLaneKey(lane), 'sr2/wallet/' + lane);
  const spelledIdentity = { ...laneInput, chainIdentity: '0x' + laneInput.chainIdentity };
  assert.equal(walletLane(spelledIdentity), JSON.stringify([spelledIdentity.network, spelledIdentity.chainIdentity, spelledIdentity.address]));
  for (const invalid of [undefined, '', 5, ['x'], {}]) assert.throws(() => walletLaneKey(invalid), { name: 'TypeError', message: 'wallet_lane_invalid' });
});

test("a put through the view stores a broadcast-accepted record as sr2-readback-pending, stores every other record unchanged, and leaves the caller's record unmodified", async t => {
  const w = durableWorld(t), view = createWalletLaneView({ journal: w.journal }), lane = walletLane(laneInput);
  assert.equal(await view.get(lane), undefined);
  for (const record of [started, accepted]) {
    const before = structuredClone(record);
    const stored = record.stage === 'broadcast-accepted' ? { ...record, stage: 'sr2-readback-pending' } : record;
    assert.equal(await view.put(lane, record), undefined);
    assert.deepEqual(await w.journal.get(walletLaneKey(lane)), stored);
    assert.equal(JSON.stringify(await w.journal.get(walletLaneKey(lane))), JSON.stringify(stored));
    assert.deepEqual(record, before);
  }
  const copy = await view.get(lane);
  copy.signedTransaction.hash = '4'.repeat(64);
  assert.equal((await view.get(lane)).signedTransaction.hash, started.hash);
});

test('a put whose journal does not keep the exact record refuses with journal-error', async () => {
  for (const readback of [{ ...started, nonce: 2 }, undefined]) {
    const view = createWalletLaneView({ journal: { get: async () => readback, put: async () => {}, withWalletLock: () => {} } });
    await assert.rejects(view.put(walletLane(laneInput), started), { code: 'journal-error', message: 'the exact issued stage was not retained' });
  }
  const reordered = Object.fromEntries(Object.entries(started).reverse());
  const view = createWalletLaneView({ journal: { get: async () => reordered, put: async (_key, record) => {
    assert.notEqual(record, started);
    assert.notEqual(record.signedTransaction, started.signedTransaction);
  }, withWalletLock: () => {} } });
  await view.put(walletLane(laneInput), started);
});

test("the view's lane lock is the journal's lock on the sr2/wallet/ key: a second holder gets journal-busy, an unlocked put is fenced, and a put inside the view's own lock is written", async t => {
  const w = durableWorld(t), view = createWalletLaneView({ journal: w.journal }), lane = walletLane(laneInput);
  await view.put(lane, started);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const holding = w.journal.withWalletLock(walletLaneKey(lane), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    await assert.rejects(view.withWalletLock(lane, () => assert.fail('must not enter')),
      error => error instanceof DurableWalletJournalError && error.code === 'journal-busy');
    await assert.rejects(view.put(lane, accepted), { code: 'journal-fenced' });
    assert.deepEqual(await view.get(lane), started);
  } finally { release.resolve(); await holding; }
  const result = {};
  assert.equal(await view.withWalletLock(lane, async owner => {
    assert.ok(owner);
    await view.put(lane, accepted);
    return result;
  }), result);
  assert.equal((await view.get(lane)).stage, 'sr2-readback-pending');
});

test('the wallet-lane view refuses a journal without get, put and withWalletLock', () => {
  for (const options of [undefined, {}, { journal: { get() {}, put() {} } }, { journal: { get() {}, withWalletLock() {} } }, { journal: { put() {}, withWalletLock() {} } }]) {
    assert.throws(() => createWalletLaneView(options), { name: 'TypeError', message: 'wallet_lane_journal_required' });
  }
});

test("the native payment lane read accepts only this purchase's wallet lane string, compared exactly", async t => {
  const w = await finalizedWorld(t); await w.build();
  const capability = w.session.transport, lane = sessionLane(w);
  const config = nativeAgreementPaymentConfig(capability, { walletConfig: { rpcUrl: capability.pins.endpoint, sourceCapability: capability, journal: w.journal },
    sellerSr2Commitment: { publicProjection: true }, coordinates: { unresolvedForSender: () => [] }, fetchImpl: w.node.fetch, now: w.clock.now });
  const op = { id: 'TEST-purchase', terms: { network: w.session.wallet.getWriteProfile().network, buyer: { wallet: w.session.wallet.getPublicAccount().address },
    domain: { mode: 'public-chain-read', chainIdentity: capability.pins.chainIdentity }, protocol: { transportBinding: capability.transportBinding } } };
  for (const wrong of [walletLane({ ...laneInput, address: '0x' + '5'.repeat(64) }), [lane]]) {
    await assert.rejects(config.readLane(op, wrong), { code: 'wallet_lane_mismatch', message: 'only this purchase wallet lane may be read' });
  }
  await w.journal.put(walletLaneKey(lane), started);
  await assert.rejects(config.readLane(op, lane), { code: 'wallet_fenced' });
  await config.withPaymentLane(op, () => assert.deepEqual(w.journal.inspectLocks().map(lock => lock.key), [walletLaneKey(lane)]));
});

test('journal errors pass through the view with their original identity', async () => {
  const error = new Error('TEST-journal-refused'), lane = walletLane(laneInput);
  const view = createWalletLaneView({ journal: { get: async () => { throw error; }, put: async () => { throw error; }, withWalletLock: async () => { throw error; } } });
  await assert.rejects(view.get(lane), caught => caught === error);
  await assert.rejects(view.put(lane, started), caught => caught === error);
  await assert.rejects(view.withWalletLock(lane, () => {}), caught => caught === error);
});

test('a failed journal put preserves the previous lane record after reopen', async t => {
  const w = durableWorld(t, { maxValueBytes: 512 }), lane = walletLane(laneInput);
  const view = createWalletLaneView({ journal: w.journal });
  await view.put(lane, started);
  await assert.rejects(view.withWalletLock(lane, () => view.put(lane, { ...accepted, padding: 'x'.repeat(513) })), { code: 'journal-capacity' });
  assert.deepEqual(await w.reopen().get(lane), started);
});

test('a failed readback after put leaves the pending lane fenced after reopen', async t => {
  const w = durableWorld(t), lane = walletLane(laneInput), error = new Error('TEST-readback-refused');
  const view = createWalletLaneView({ journal: { ...w.journal, get: async () => { throw error; } } });
  await assert.rejects(view.withWalletLock(lane, () => view.put(lane, accepted)), caught => caught === error);
  const reopened = w.reopen();
  assert.deepEqual(await reopened.get(lane), { ...accepted, stage: 'sr2-readback-pending' });
  assert.notEqual((await reopened.get(lane)).stage, 'broadcast-accepted');
});

test('a failed lane callback keeps its record after reopen and permits the next owner', async t => {
  const w = durableWorld(t), lane = walletLane(laneInput), error = new Error('TEST-work-refused');
  const view = createWalletLaneView({ journal: w.journal });
  await assert.rejects(view.withWalletLock(lane, async () => { await view.put(lane, accepted); throw error; }), caught => caught === error);
  const reopened = w.reopen();
  assert.equal((await reopened.get(lane)).stage, 'sr2-readback-pending');
  assert.deepEqual(w.journal.inspectLocks(), []);
  await reopened.withWalletLock(lane, () => reopened.put(lane, started));
  assert.deepEqual(await reopened.get(lane), started);
});
