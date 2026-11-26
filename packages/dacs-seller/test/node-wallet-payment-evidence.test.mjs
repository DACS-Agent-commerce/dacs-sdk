// The payment-evidence journal the seller's Node wallet builds over the client's payment-evidence adapter: the journal's
// replay rules hold through the composition, with the adapter's readback (which never answers `absent`, so nothing is
// superseded) and the reservation's settlement of the retained authorization by id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, createSellerNodeWallet, evidenceInput, inWalletPass, jsonResponse, keyRecordBytes, nodeConnection, ok, privateDataDirectory, replayNode,
  replyTo, restartedWorld, runWalletChild, sellerWalletWorld, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { evidenceInput as chainEvidenceInput, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';
import { journalOverAdapter } from './helpers/payment-evidence-test-journals.mjs';

const { createPaymentEvidenceWalletJournal, isPaymentEvidenceWalletJournalPair } = await import('../src/dacs/payment-evidence-wallet-journal.mjs');

const JOURNAL_READ_TIMEOUT_MS = 10_000;
const anchor = (world, input = evidenceInput(world)) => inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(input));
const reconcile = (world, input = evidenceInput(world)) => inWalletPass(world, () => journalOverAdapter(world).reconcilePaymentEvidence(input));
const spentIds = world => [...world.approval.settled].filter(([, outcome]) => outcome === 'spent').map(([id]) => id);
const sentBytes = world => world.node.broadcasts.map(tx => JSON.stringify(tx));
// A broadcast the node acknowledges but never includes.
const dropBroadcasts = world => replyTo(world.node, 'broadcastTx', row => jsonResponse(ok({ hash: row.body.params[0].data.response.data.transaction.hash })));

test('an address is signed once and the kept CREATE is rebroadcast as the same bytes through the composition\'s adapter, also after reopen', async t => {
  const world = await sellerWalletWorld(t);
  assert.deepEqual(await reconcile(world), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' });
  replyTo(world.node, 'broadcastTx', () => { throw new Error('TEST-node-unreachable'); });
  await assert.rejects(anchor(world), 'a broadcast whose answer is lost after signing throws');
  world.node.reply = null;
  await world.restart();
  const replayed = await reconcile(world);
  assert.equal(replayed.status, 'rebroadcast', JSON.stringify(replayed));
  assert.deepEqual(await anchor(world), { status: 'applied', txHash: replayed.txHash }, 'a second anchor reports the applied CREATE');
  assert.equal(world.approval.prepared.length, 1, 'one authorization: signed once');
  assert.equal(new Set(sentBytes(world)).size, 1, 'every broadcast is the same signed bytes');
  assert.deepEqual(spentIds(world), ['TEST-ledger-1'], 'the readback settled the authorization spent, by id');
});

test('killed after the binding, after keeping or after broadcast, restart recovers one live signed CREATE that is never signed twice; killed before the binding completes, it is signed once more at the same nonce and the unbound bytes never left the process', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  for (const cut of ['signed', 'bound', 'kept', 'sent']) {
    const directory = privateDataDirectory(t), stateDirectory = privateDataDirectory(t);
    const child = await runWalletChild(`anchor:${cut}`, directory, stateDirectory);
    assert.equal(child.signal, 'SIGKILL', `${cut}: ${child.stderr}`);
    const before = signatures.length, childSent = replayNode(join(stateDirectory, 'chain.json')).broadcasts.length;
    const world = await restartedWorld(t, directory, stateDirectory);
    const answer = await anchor(world);
    assert.ok(['submitted', 'rebroadcast', 'applied'].includes(answer.status), `${cut}: ${JSON.stringify(answer)}`);
    assert.equal(new Set(sentBytes(world)).size, 1, `${cut}: one signed CREATE ever reached the node`);
    if (cut === 'signed') {
      assert.equal(childSent, 0, 'the unbound bytes never left the killed process');
      assert.deepEqual(signatures.slice(before), [JSON.parse(readFileSync(join(stateDirectory, 'signed.json'), 'utf8')).nonce], 'signed once more, at the same nonce');
    } else {
      assert.deepEqual(signatures.slice(before), [], `${cut}: the restart signs nothing`);
      assert.equal(world.node.broadcasts[0].hash, answer.txHash, `${cut}: the restart answers for the CREATE the killed process signed`);
    }
    assert.deepEqual(await anchor(world), { status: 'applied', txHash: answer.txHash });
    await world.wallet.close();
  }
});

test('with no complete authenticated index a dropped CREATE stays live and is replayed; a pending or unreadable one stays live', async t => {
  const world = await sellerWalletWorld(t);
  dropBroadcasts(world);
  const sent = await anchor(world);
  assert.equal(sent.status, 'submitted');
  world.node.nonce = 7;
  assert.deepEqual(await reconcile(world), { status: 'rebroadcast', txHash: sent.txHash }, 'the account nonce passed the CREATE, but no index proves it was not executed: replayed');
  const drop = world.node.reply;
  world.node.reply = row => (row.body.params[0].message === 'getAddressNonce' ? jsonResponse({ result: 500, response: 'TEST-unreadable', require_reply: false, extra: null }) : drop(row));
  const unreadable = await reconcile(world);
  assert.equal(unreadable.txHash, sent.txHash, `an unreadable nonce keeps the same CREATE: ${JSON.stringify(unreadable)}`);
  assert.notEqual(unreadable.status, 'unsigned');
  world.node.reply = drop;
  await world.restart();
  const replayed = await anchor(world);
  assert.ok(['submitted', 'rebroadcast'].includes(replayed.status) && replayed.txHash === sent.txHash, `still pending after a restart: the same bytes again (${JSON.stringify(replayed)})`);
  assert.equal(world.approval.prepared.length, 1, 'never signed anew');
  assert.equal(new Set(sentBytes(world)).size, 1);
  assert.deepEqual(spentIds(world), [], 'nothing settled while the CREATE is not executed');
});

test('with a duplicate-rejecting broadcaster, an applied kept CREATE is broadcast once in total across anchorEvidence and reconcilePaymentEvidence, in each of {anchorEvidence, reconcilePaymentEvidence} with the account-nonce answer lagging (0), stale, unreadable and current; the result is applied/consumed; the nonce is read before the transaction state, and an absent state with a nonce that reached the CREATE\'s nonce but whose snapshot is not covered by the index supersedes nothing', async t => {
  const nonceAnswers = { lagging: () => ok(0), stale: () => ok(1), unreadable: () => ({ result: 500, response: 'TEST-unreadable', require_reply: false, extra: null }), current: null };
  for (const entry of [anchor, reconcile]) {
    for (const [label, nonceAnswer] of Object.entries(nonceAnswers)) {
      const world = await sellerWalletWorld(t);
      world.node.nonce = 1;
      const sent = await anchor(world);
      assert.equal(sent.status, 'submitted', label);
      replyTo(world.node, 'broadcastTx', () => jsonResponse({ result: 400, response: 'TEST-duplicate-transaction', require_reply: false, extra: null }));
      if (nonceAnswer) replyTo(world.node, 'getAddressNonce', () => jsonResponse(nonceAnswer()));
      world.node.reads.length = 0;
      assert.deepEqual(await entry(world), { status: 'applied', txHash: sent.txHash }, `${entry.name} with a ${label} nonce`);
      assert.equal(world.node.broadcasts.length, 1, `${entry.name} with a ${label} nonce: broadcast once in total`);
      assert.deepEqual(spentIds(world), ['TEST-ledger-1'], `${label}: the applied CREATE consumed its authorization`);
      const nonceRead = world.node.reads.indexOf('getAddressNonce'), stateRead = world.node.reads.indexOf('getTransactionStatus');
      assert.ok(nonceRead >= 0 && nonceRead < stateRead, `${label}: the nonce is read before the transaction state: ${world.node.reads}`);
      await world.wallet.close();
    }
  }
  const world = await sellerWalletWorld(t);
  dropBroadcasts(world);
  const kept = await anchor(world);
  replyTo(world.node, 'getAddressNonce', () => jsonResponse(ok(5)));
  assert.deepEqual(await reconcile(world), { status: 'rebroadcast', txHash: kept.txHash }, 'a nonce past the CREATE with no covering absence index supersedes nothing');
  assert.equal(world.approval.prepared.length, 1);
});

test('overlapping retries across two journal handles reuse the winning signature and answer', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const first = await sellerWalletWorld(t);
  // A second wallet over the same files and lock, on its own connection, so the two passes do not queue on one fence.
  const connection = await nodeConnection(first.node);
  const second = { owner: connection.owner, directory: first.directory, options: first.options, wallet: await createSellerNodeWallet({ ...first.options, owner: connection.owner, admission: connection.admission, journalMode: 'open', keyRecord: keyRecordBytes() }) };
  t.after(async () => { await second.wallet.close(); await connection.owner.close(); });
  const input = evidenceInput(first);
  const [one, two] = await Promise.all([anchor(first, input), anchor(second, input)]);
  assert.equal(one.txHash, two.txHash, `both retries answer for the winning CREATE: ${JSON.stringify([one, two])}`);
  assert.equal(signatures.length, 1, 'one signature');
  assert.equal(new Set(sentBytes(first)).size, 1, 'one signed CREATE reached the node');
});

test('an unknown confirmation keeps the CREATE live and it is never reported unsent', async t => {
  const world = await sellerWalletWorld(t);
  replyTo(world.node, 'confirmTx', () => { throw new Error('TEST-confirmation-lost'); });
  await assert.rejects(anchor(world));
  const after = await reconcile(world);
  assert.notEqual(after.status, 'unsigned', JSON.stringify(after));
  await world.restart();
  const again = await reconcile(world);
  assert.notEqual(again.status, 'unsigned', JSON.stringify(again));
  assert.equal(again.txHash, after.txHash, 'the same kept CREATE');
  assert.equal(world.approval.prepared.length, 1, 'never signed anew');
});

test('the journal passes the kept row\'s projection, nonce and signal to readTransactionState, and the anchorEvidence/reconcilePaymentEvidence pair stays registered', async t => {
  const world = await sellerWalletWorld(t), paymentEvidence = journalOverAdapter(world);
  assert.equal(isPaymentEvidenceWalletJournalPair(paymentEvidence.anchorEvidence, paymentEvidence.reconcilePaymentEvidence), true, 'the journal pair over the wallet\'s adapter is registered');
  const node = walletChain(), asked = [], directory = privateDataDirectory(t);
  const journal = createPaymentEvidenceWalletJournal({ path: join(directory, 'journal.sqlite'), signCreate: input => node.signCreate(input), broadcast: async () => {},
    readAccountNonce: async options => { asked.push(['nonce', options]); return { nonce: 0, blockHeight: 0 }; },
    readTransactionState: async (kept, options) => { asked.push(['state', kept, options]); return 'pending'; } });
  t.after(() => journal.close());
  const input = chainEvidenceInput(node.claim);
  const sent = await journal.anchorEvidence(input);
  await journal.reconcilePaymentEvidence(input);
  const [[, nonceOptions], [, kept, stateOptions]] = asked;
  assert.ok(nonceOptions.signal instanceof AbortSignal && stateOptions.signal instanceof AbortSignal, 'both reads get their deadline signal');
  const row = await journal.readSignedProjection({ logicalAddress: input.logicalAddress });
  assert.deepEqual(kept, { txHash: sent.txHash, signedTransaction: JSON.stringify(row), nonce: row.content.nonce });
  assert.equal(isPaymentEvidenceWalletJournalPair(journal.anchorEvidence, journal.reconcilePaymentEvidence), true);
});

test('through the real kit journal, a nonce read and then the status, transaction and block reads each stall past their deadline: the signal the adapter receives is aborted, no later request of that read starts, and a late answer consumes and settles nothing', async t => {
  for (const stalled of ['getAddressNonce', 'getTransactionStatus', 'getTxByHash', 'getBlockByNumber']) {
    const world = await sellerWalletWorld(t);
    dropBroadcasts(world);
    const sent = await anchor(world);
    // The transaction and block reads follow only an included CREATE; with a stalled nonce read the state read answers pending.
    if (['getTxByHash', 'getBlockByNumber'].includes(stalled)) world.node.applied.set(sent.txHash, structuredClone(world.node.broadcasts[0]));
    let stall, late;
    const reached = new Promise(resolve => { stall = resolve; });
    world.node.reads.length = 0;
    // One request stalls: the block read is the one after the transaction read (the binding reads blocks earlier).
    let stalledOnce = false;
    replyTo(world.node, stalled, row => {
      if (stalledOnce || (stalled === 'getBlockByNumber' && !world.node.reads.includes('getTxByHash'))) return undefined;
      stalledOnce = true; stall(row);
      return new Promise(resolve => { late = () => resolve(jsonResponse(ok({}))); });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reconciled = reconcile(world);
    const row = await reached;
    t.mock.timers.tick(JOURNAL_READ_TIMEOUT_MS);
    const answer = await reconciled;
    t.mock.timers.reset();
    assert.ok(row.signal?.aborted, `${stalled}: the stalled request's signal is aborted`);
    assert.notEqual(answer.status, 'unsigned', `${stalled}: ${JSON.stringify(answer)}`);
    assert.deepEqual(spentIds(world), [], `${stalled}: nothing settled at the deadline`);
    const readsBeforeLateAnswer = world.node.reads.length;
    late();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(world.node.reads.slice(readsBeforeLateAnswer), [], `${stalled}: the late answer starts no later request of that read`);
    assert.deepEqual(spentIds(world), [], `${stalled}: the late answer consumes and settles nothing`);
    await world.wallet.close();
  }
});

test('withdraw evidence authorization during nonce read and pre-broadcast microtask, zero unauthorized effects and child survives', async t => {
  const world = await sellerWalletWorld(t), unhandled = [];
  const record = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));
  let current = true;
  const pass = { context: api.passContext({ operationClass: 'payment-evidence',
    currentAuthorization: () => { if (!current) throw Object.assign(new Error('TEST-authorization-withdrawn'), { code: 'TEST-withdrawn' }); return true; } }) };
  replyTo(world.node, 'getAddressNonce', () => { current = false; return undefined; });
  const withdrawn = await inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world)), pass).then(() => null, error => error);
  assert.ok(withdrawn, 'the anchor withdrawn during its nonce read is refused');
  assert.equal(world.node.confirms.length + world.node.broadcasts.length, 0, 'nothing was confirmed or sent');
  current = true; world.node.reply = null;
  replyTo(world.node, 'confirmTx', () => { queueMicrotask(() => { current = false; }); return undefined; });
  const late = await inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world)), pass).then(answer => answer, error => error);
  assert.equal(world.node.broadcasts.length, 0, `withdrawn before the broadcast: nothing sent (${late?.code ?? late?.status})`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'both refusals were handled: the process survives');
});
