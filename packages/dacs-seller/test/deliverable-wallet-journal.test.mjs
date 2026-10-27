// The seller wallet's Deliverable journal on its own: what the agent relies on
// from `submit` and `reconcile` (DACS-4 PC-7(b), write-once): the exact signed
// CREATE is kept before it is broadcast, sent again as the same bytes while it
// can still land, and only an address with no live CREATE is signed anew.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliverableWalletJournal, createPaymentEvidenceWalletJournal } from '../src/index.mjs';
import { deliverableJournalFor } from '../src/dacs/deliverable-wallet-journal.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { deliverableInput, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';

// A wallet over one account on a chain with the node's nonce rule. `calls.sign`
// counts signatures, `calls.broadcast` lists the bytes of each broadcast. The
// next sign or broadcast fails as `faults` say: 'throw', and 'drop' (the node
// never applies it) or 'hang' (never answers) for a broadcast.
function wallet(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deliverable-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = walletChain(), path = join(dir, 'journal.sqlite'), calls = { sign: 0, broadcast: [] }, faults = { sign: [], broadcast: [] };
  const open = (file = path, make = createDeliverableWalletJournal) => make({ path: file, readTimeoutMs: 200,
    signCreate: async (asked, change = {}) => {
      calls.sign++;
      if (faults.sign.shift() === 'throw') throw new Error('TEST wallet failed before signing');
      return node.signCreate(asked, change);
    },
    broadcast: async ({ signedTransaction, txHash }) => {
      calls.broadcast.push(signedTransaction);
      const fault = faults.broadcast.shift();
      if (fault === 'throw') throw new Error('TEST node unreachable');
      if (fault === 'hang') return new Promise(() => {});
      if (fault !== 'drop') node.land(txHash);
    },
    readAccountNonce: async () => ({ nonce: node.accountNonce(), blockHeight: node.accountNonce() }),
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.accountNonce() }) });
  return { dir, path, node, calls, faults, open, input: (extra) => deliverableInput(node.claim, extra) };
}

test('a Deliverable is signed once: the kept CREATE is broadcast again as the same bytes, also after the journal is reopened', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  assert.deepEqual(await journal.reconcile(w.input()), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' });
  w.faults.broadcast.push('throw');
  await assert.rejects(journal.submit(w.input()), /TEST node unreachable/, 'a broadcast that fails after signing throws');
  journal.close();
  journal = w.open();
  t.after(() => journal.close());
  const kept = await journal.readSignedProjection(w.input());
  assert.equal(JSON.stringify(kept), w.calls.broadcast[0], 'the kept bytes are the bytes that were sent');
  assert.deepEqual(await journal.reconcile(w.input()), { status: 'rebroadcast', txHash: kept.hash }, 'kept and not overtaken: broadcast again, never unsigned');
  assert.deepEqual(await journal.submit(w.input()), { status: 'accepted', reconciliationId: kept.hash }, 'a repeated submit reports the retained CREATE');
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.equal(new Set(w.calls.broadcast).size, 1, 'every broadcast is the same signed bytes');
});

test('a CREATE the node applied is not broadcast again', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  const { reconciliationId } = await journal.submit(w.input());
  const answer = await journal.reconcile(w.input());
  assert.deepEqual([answer.status, answer.txHash], ['applied', reconciliationId]);
  assert.equal(w.calls.broadcast.length, 1, 'nothing is sent for an applied CREATE');
});

test('a broadcast that never answers leaves the CREATE live: reconcile answers pending and signs nothing', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('hang');
  await assert.rejects(journal.submit(w.input()), { code: 'wallet_broadcast_timeout' });
  w.faults.broadcast.push('hang');
  const answer = await journal.reconcile(w.input());
  assert.equal(answer.status, 'pending');
  assert.match(answer.reason, /not broadcast again/);
  assert.equal(w.calls.sign, 1);
});

test('a CREATE another write of the account overtook is superseded: the address is unsigned again and one new CREATE is signed', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  const { reconciliationId: first } = await journal.submit(w.input());
  w.node.other();
  const answer = await journal.reconcile(w.input());
  assert.deepEqual([answer.status, answer.txHash], ['unsigned', first], 'it can no longer be executed');
  const { reconciliationId: second } = await journal.submit(w.input());
  assert.notEqual(second, first);
  assert.equal(w.calls.sign, 2, 'one new signature');
  assert.equal(w.node.transactionState(second), 'applied');
});

test('a signed CREATE that is not this Deliverable is refused and nothing is kept or sent', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  const otherBinding = { version: '1', jobId: 'TEST-job', fulfilmentId: 'a0'.repeat(32), payloadHash: 'b0'.repeat(32) };
  for (const [label, change] of [['another delivery binding', { prepare: (content) => { content.data[1].metadata.deliveryBinding = otherBinding; } }],
    ['no delivery binding', { prepare: (content) => { delete content.data[1].metadata.deliveryBinding; } }],
    ['another artifact', { artifact: { ...w.input().report, body: ['TEST another report'] } }]]) {
    const refusing = w.open(join(w.dir, `${label}.sqlite`), (options) => createDeliverableWalletJournal({ ...options, signCreate: (asked) => w.node.signCreate(asked, change) }));
    await assert.rejects(refusing.submit(w.input()), { code: 'wallet_sign_invalid' }, label);
    assert.equal(await refusing.readSignedProjection(w.input()), null, `${label}: nothing is kept`);
    refusing.close();
  }
  assert.equal(w.calls.broadcast.length, 0, 'nothing is sent');
});

test('a report that is not hashed as its receiptContentHash, or no report, is refused before the wallet is asked', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  for (const [label, extra] of [['a wrong hash', { receiptContentHash: 'c0'.repeat(32) }], ['no report', { report: undefined }], ['a list as report', { report: [] }],
    ['no delivery binding', { deliveryBinding: undefined }], ['no writer', { writer: undefined }]]) {
    await assert.rejects(journal.submit(w.input(extra)), TypeError, label);
    await assert.rejects(journal.reconcile(w.input(extra)), TypeError, label);
  }
  assert.equal(w.calls.sign, 0);
});

test('the question belongs to the capability only when both are one journal\'s: a wrapper, two journals, an evidence journal or a scripted question is refused', async (t) => {
  const w = wallet(t);
  const journal = w.open(), other = w.open(join(w.dir, 'other.sqlite')), evidence = w.open(join(w.dir, 'evidence.sqlite'), createPaymentEvidenceWalletJournal);
  t.after(() => { journal.close(); other.close(); evidence.close(); });
  const capability = (submit) => createNativeDemDeliveryCapability({ authority: 'TEST-journal', submit, reconcile: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'valid' });
  assert.equal(deliverableJournalFor(capability(journal.submit), journal.reconcile), journal);
  assert.equal(deliverableJournalFor(capability(journal.submit), null), null, 'no question, no journal');
  for (const [label, delivery, reconcile] of [['two journals', capability(journal.submit), other.reconcile], ['a wrapper', capability((input) => journal.submit(input)), journal.reconcile],
    ['a scripted question', capability(journal.submit), async () => ({ status: 'unsigned' })], ['an evidence journal', capability(evidence.anchorEvidence), evidence.reconcilePaymentEvidence],
    ['no capability', null, journal.reconcile], ['a copy of a capability', { ...capability(journal.submit) }, journal.reconcile]]) {
    assert.throws(() => deliverableJournalFor(delivery, reconcile), { name: 'TypeError', message: /reconcileDeliverableCreate/ }, label);
  }
});

test('a journal file made for the other kind is refused, so evidence and Deliverable rows are never mixed', async (t) => {
  const w = wallet(t);
  w.open(w.path, createPaymentEvidenceWalletJournal).close();
  assert.throws(() => w.open(), /made for another kind of journal/);
  const deliverables = w.open(join(w.dir, 'deliverables.sqlite'));
  deliverables.close();
  assert.throws(() => w.open(join(w.dir, 'deliverables.sqlite'), createPaymentEvidenceWalletJournal), /made for another kind of journal/);
});
