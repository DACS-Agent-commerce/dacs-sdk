// The seller wallet's Deliverable journal on its own: what the agent relies on
// from `submitAuthorized` and `resume` (the payment-evidence journal's retry
// rule, DACS-4 PC-7(b), applied to the Deliverable; CORE §5.1): the exact signed
// CREATE is kept before it is broadcast, sent again as the same bytes while it
// can still land, and only an address with no live CREATE is signed anew; and
// nothing is signed or sent unless the order's journal is named and authorize()
// answers true right before the signature or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { createDeliverableWalletJournal, createPaymentEvidenceWalletJournal } from '../src/index.mjs';
import { deliverableJournalFor } from '../src/dacs/deliverable-wallet-journal.mjs';
import { createNativeDemDeliveryCapability, submitNativeDemDelivery } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { deliverableInput, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';

// The journal's two operations as the agent calls them: for the journal it
// recorded for the order, with an authorization (by default, one that holds).
const allow = () => true;
const submit = (journal, input, authorize = allow) => journal.submitAuthorized({ ...input, expectedJournalId: journal.journalId }, authorize);
const resume = (journal, input, authorize = allow) => journal.resume({ ...input, expectedJournalId: journal.journalId }, authorize);

// A wallet over one account on a chain with the node's nonce rule. `calls.sign`
// counts signatures, `calls.broadcast` lists the bytes of each broadcast. The
// next sign or broadcast fails as `faults` say: 'throw', and 'drop' (the node
// never applies it) or 'hang' (never answers) for a broadcast. `hooks.duringSign`
// and `hooks.duringNonce` run inside signCreate and the account nonce read.
function wallet(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deliverable-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = walletChain(), path = join(dir, 'journal.sqlite'), calls = { sign: 0, broadcast: [] }, faults = { sign: [], broadcast: [] }, hooks = {};
  const open = (file = path, make = createDeliverableWalletJournal) => make({ path: file, readTimeoutMs: 200,
    signCreate: async (asked, change = {}) => {
      calls.sign++;
      hooks.duringSign?.();
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
    readAccountNonce: async () => { hooks.duringNonce?.(); return { nonce: node.accountNonce(), blockHeight: node.accountNonce() }; },
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.accountNonce() }) });
  return { dir, path, node, calls, faults, hooks, open, input: (extra) => deliverableInput(node.claim, extra) };
}

test('a Deliverable is signed once: the kept CREATE is broadcast again as the same bytes, also after the journal is reopened', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  assert.deepEqual(await resume(journal, w.input()), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' });
  w.faults.broadcast.push('throw');
  await assert.rejects(submit(journal, w.input()), /TEST node unreachable/, 'a broadcast that fails after signing throws');
  journal.close();
  journal = w.open();
  t.after(() => journal.close());
  const kept = await journal.readSignedProjection(w.input());
  assert.equal(JSON.stringify(kept), w.calls.broadcast[0], 'the kept bytes are the bytes that were sent');
  assert.deepEqual(await resume(journal, w.input()), { status: 'rebroadcast', txHash: kept.hash }, 'kept and not overtaken: broadcast again, never unsigned');
  assert.deepEqual(await submit(journal, w.input()), { status: 'accepted', reconciliationId: kept.hash }, 'a repeated submit reports the retained CREATE');
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.equal(new Set(w.calls.broadcast).size, 1, 'every broadcast is the same signed bytes');
});

test('a CREATE the node applied is not broadcast again', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  const { reconciliationId } = await submit(journal, w.input());
  const answer = await resume(journal, w.input());
  assert.deepEqual([answer.status, answer.txHash], ['applied', reconciliationId]);
  assert.equal(w.calls.broadcast.length, 1, 'nothing is sent for an applied CREATE');
});

test('a broadcast that never answers leaves the CREATE live: reconcile answers pending and signs nothing', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('hang');
  await assert.rejects(submit(journal, w.input()), { code: 'wallet_broadcast_timeout' });
  w.faults.broadcast.push('hang');
  const answer = await resume(journal, w.input());
  assert.equal(answer.status, 'pending');
  assert.match(answer.reason, /not broadcast again/);
  assert.equal(w.calls.sign, 1);
});

test('a CREATE another write of the account overtook is superseded: the address is unsigned again and one new CREATE is signed', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  const { reconciliationId: first } = await submit(journal, w.input());
  w.node.other();
  const answer = await resume(journal, w.input());
  assert.deepEqual([answer.status, answer.txHash], ['unsigned', first], 'it can no longer be executed');
  const replayed = await resume(journal, w.input());
  assert.deepEqual([replayed.status, replayed.txHash], ['unsigned', first], 'the supersession is replayed, naming the same CREATE');
  assert.equal(w.calls.broadcast.length, 1, 'the superseded CREATE is never sent again');
  const { reconciliationId: second } = await submit(journal, w.input());
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
    await assert.rejects(submit(refusing, w.input()), { code: 'wallet_sign_invalid' }, label);
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
    await assert.rejects(submit(journal, w.input(extra)), TypeError, label);
    await assert.rejects(resume(journal, w.input(extra)), TypeError, label);
  }
  assert.equal(w.calls.sign, 0);
});

test('a job id that is not a canonical ULID is refused before the wallet is asked', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  // CORE §B.1/JID: the 26-character uppercase Crockford-Base32 form only; an
  // alternate spelling is not silently accepted as another idempotency key.
  for (const jobId of ['TEST-job', '01j8n4yv7yvyq4db7m8t4c7w0a', '01J8N4YV7YVYQ4DB7M8T4C7W0', '01J8N4YV7YVYQ4DB7M8T4C7W0AA',
    '01J8N4YV7YVYQ4DB7M8T4C7W0I', '81J8N4YV7YVYQ4DB7M8T4C7W0A', 42]) {
    await assert.rejects(submit(journal, w.input({ jobId })), TypeError, String(jobId));
    await assert.rejects(resume(journal, w.input({ jobId })), TypeError, String(jobId));
  }
  assert.equal(w.calls.sign, 0, 'no signature is asked for a malformed job');
  assert.equal(w.calls.broadcast.length, 0, 'nor is anything sent');
});

test('a job id that differs from the report, the delivery binding or the Deliverable address is refused before the wallet is asked', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  const other = '01J8N4YV7YVYQ4DB7M8T4C7W0B', binding = w.input().deliveryBinding;
  const report = { ...w.input().report, jobId: other };
  // The journal is asked about one Deliverable of one job: the id, the artifact,
  // its binding and its address must all name that job, or the journal refuses
  // before the wallet can sign a CREATE under a mismatched label.
  for (const [label, extra] of [['the report', { report, receiptContentHash: sha256Hex(canonicalize(report)) }],
    ['the delivery binding', { deliveryBinding: { ...binding, jobId: other } }], ['the Deliverable address', { logicalAddress: `dacs4:deliverable:${other}` }]]) {
    await assert.rejects(submit(journal, w.input(extra)), TypeError, label);
    await assert.rejects(resume(journal, w.input(extra)), TypeError, label);
  }
  assert.equal(w.calls.sign, 0, 'no signature is asked about another job');
  assert.equal(w.calls.broadcast.length, 0, 'nor is anything sent');
});

test('a writer that is not a nonempty claim, or a delivery binding that is not a plain JSON record, is refused before the wallet is asked', async (t) => {
  const w = wallet(t), binding = w.input().deliveryBinding;
  const journal = w.open();
  t.after(() => journal.close());
  for (const [label, extra] of [['an empty writer', { writer: '' }], ['a Date as the delivery binding', { deliveryBinding: new Date(0) }],
    ['a nested Date in the delivery binding', { deliveryBinding: { ...binding, at: new Date(0) } }]]) {
    await assert.rejects(submit(journal, w.input(extra)), TypeError, label);
    await assert.rejects(resume(journal, w.input(extra)), TypeError, label);
  }
  assert.equal(w.calls.sign, 0, 'nothing is signed for an unusable input');
  assert.equal(w.calls.broadcast.length, 0, 'nor is anything sent');
});

test('a writer that names no account is refused before the wallet is asked', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  for (const writer of ['not-a-claim', 'did:demos:agent:zz', 42]) {
    await assert.rejects(submit(journal, w.input({ writer })), TypeError, String(writer));
    await assert.rejects(resume(journal, w.input({ writer })), TypeError, String(writer));
  }
  assert.equal(w.calls.sign, 0, 'nothing is signed for a writer with no address');
  assert.equal(w.calls.broadcast.length, 0, 'nor is anything sent');
});

test('a delivery binding that is incomplete or commits to other bytes than the report is refused before the wallet is asked', async (t) => {
  const w = wallet(t), binding = w.input().deliveryBinding;
  const journal = w.open();
  t.after(() => journal.close());
  const { fulfilmentId, ...noFulfilment } = binding, { payloadHash, ...noPayload } = binding;
  for (const [label, deliveryBinding] of [['only a job id', { jobId: binding.jobId }], ['no fulfilment id', noFulfilment], ['no payload hash', noPayload],
    ['another payload hash', { ...binding, payloadHash: '00'.repeat(32) }], ['another version', { ...binding, version: '2' }]]) {
    await assert.rejects(submit(journal, w.input({ deliveryBinding })), TypeError, label);
    await assert.rejects(resume(journal, w.input({ deliveryBinding })), TypeError, label);
  }
  assert.equal(w.calls.sign, 0, 'nothing is signed for a binding that does not fit the report');
  assert.equal(w.calls.broadcast.length, 0, 'nor is anything sent');
});

test('a signed CREATE whose binding has no canonical form is refused as a wallet_sign_invalid answer, never a bare TypeError', async (t) => {
  const w = wallet(t), binding = w.input().deliveryBinding;
  // Signed as it stands, so its hash and signature are self-consistent: only the binding check can refuse it.
  const change = { prepare: (content) => { content.data[1].metadata.deliveryBinding = { ...binding, x: 1e21 }; } };
  const journal = w.open(join(w.dir, 'unrepresentable.sqlite'), (options) => createDeliverableWalletJournal({ ...options, signCreate: (asked) => w.node.signCreate(asked, change) }));
  t.after(() => journal.close());
  await assert.rejects(submit(journal, w.input()), { code: 'wallet_sign_invalid', message: /is not this Deliverable's storage CREATE/ });
  assert.equal(await journal.readSignedProjection(w.input()), null, 'nothing is kept');
  assert.equal(w.calls.broadcast.length, 0, 'nothing is sent');
});

test('resume belongs to the capability only when its guarded submit is the same journal\'s: an unguarded capability, a wrapper, two journals, an evidence journal or a scripted resume is refused', async (t) => {
  const w = wallet(t);
  const journal = w.open(), other = w.open(join(w.dir, 'other.sqlite')), evidence = w.open(join(w.dir, 'evidence.sqlite'), createPaymentEvidenceWalletJournal);
  t.after(() => { journal.close(); other.close(); evidence.close(); });
  const capability = (operations) => createNativeDemDeliveryCapability({ authority: 'TEST-journal', reconcile: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'valid', ...operations });
  const guarded = capability({ submitAuthorized: journal.submitAuthorized });
  assert.equal(deliverableJournalFor(guarded, journal.resume), journal);
  assert.equal(deliverableJournalFor(capability({ submit: async () => ({}) }), null), null, 'no journal, no resume');
  for (const [label, delivery, resumeOf] of [['two journals', guarded, other.resume],
    ['the guarded submit as a plain submit only', capability({ submit: journal.submitAuthorized }), journal.resume],
    ['a wrapper of the guarded submit', capability({ submitAuthorized: (input, authorize) => journal.submitAuthorized(input, authorize) }), journal.resume],
    ['an unguarded submit beside the guarded one', capability({ submitAuthorized: journal.submitAuthorized, submit: async () => ({ status: 'accepted' }) }), journal.resume],
    ['the resume as the submit', capability({ submitAuthorized: journal.resume }), journal.resume],
    ['the journal\'s capability with no resume', guarded, null], ['a scripted resume', guarded, async () => ({ status: 'unsigned' })],
    ['an evidence journal', capability({ submitAuthorized: evidence.anchorEvidence }), evidence.reconcilePaymentEvidence],
    ['no capability', null, journal.resume], ['a copy of a capability', { ...guarded }, journal.resume]]) {
    assert.throws(() => deliverableJournalFor(delivery, resumeOf), { name: 'TypeError', message: /resumeDeliverableCreate/ }, label);
  }
});

test('the journal\'s capability called with an authorization that answers false signs and sends nothing', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  const capability = createNativeDemDeliveryCapability({ authority: 'TEST-journal', submitAuthorized: journal.submitAuthorized, reconcile: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'valid' });
  for (const [label, authorize] of [['false', () => false], ['a throw', () => { throw new Error('TEST credit withdrawn'); }], ['a promise of true', async () => true], ['a truthy value', () => 1]]) {
    await assert.rejects(submitNativeDemDelivery(capability, { ...w.input(), expectedJournalId: journal.journalId }, authorize), { code: 'wallet_not_authorized' }, label);
  }
  // Without an authorization the capability's own submit is the guarded one too.
  await assert.rejects(submitNativeDemDelivery(capability, { ...w.input(), expectedJournalId: journal.journalId }), TypeError, 'no authorization');
  await assert.rejects(journal.resume({ ...w.input(), expectedJournalId: journal.journalId }), TypeError, 'resume needs it too');
  assert.equal(w.calls.sign, 0, 'nothing is signed');
  assert.equal(w.calls.broadcast.length, 0, 'nothing is sent');
});

test('a call that does not name this journal is refused before anything is read, signed or sent', async (t) => {
  const w = wallet(t);
  const journal = w.open(), other = w.open(join(w.dir, 'other.sqlite'));
  t.after(() => { journal.close(); other.close(); });
  w.faults.broadcast.push('throw');
  await assert.rejects(submit(journal, w.input()), /TEST node unreachable/);
  let reads = 0;
  w.hooks.duringNonce = () => { reads++; };
  for (const [label, expectedJournalId] of [['none', undefined], ['another journal', other.journalId]]) {
    await assert.rejects(journal.submitAuthorized({ ...w.input(), expectedJournalId }, allow), { code: 'wallet_journal_changed' }, label);
    await assert.rejects(journal.resume({ ...w.input(), expectedJournalId }, allow), { code: 'wallet_journal_changed' }, label);
  }
  assert.equal(reads, 0, 'the chain is not read');
  assert.equal(w.calls.sign, 1, 'signed only by the first, named call');
  assert.equal(w.calls.broadcast.length, 1, 'nothing more is sent');
});

// Authorization is asked under the lease, again after the chain reads right
// before signCreate, and again right before each broadcast: withdrawn at any
// of those points, nothing later is signed or sent, and a kept CREATE stays kept.
test('an authorization withdrawn while queued, during the nonce read, during signing or before the broadcast stops every later signature and broadcast', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  let allowed = true;
  const authorize = () => allowed;
  // Queued behind another call: refused once its turn comes.
  w.hooks.duringSign = () => { allowed = false; };
  const [first, queued] = await Promise.allSettled([submit(journal, w.input(), authorize), submit(journal, w.input(), authorize)]);
  assert.equal(first.reason?.code, 'wallet_not_authorized', 'withdrawn during signing: the signed CREATE is kept, not sent');
  assert.equal(queued.reason?.code, 'wallet_not_authorized', 'withdrawn while queued');
  assert.equal(w.calls.sign, 1);
  assert.equal(w.calls.broadcast.length, 0);
  const kept = await journal.readSignedProjection(w.input());
  assert.notEqual(kept, null, 'the signed CREATE is kept');
  // Withdrawn while the kept CREATE's fate is read: neither resume nor submit sends it.
  w.hooks.duringSign = undefined;
  for (const call of [resume, submit]) {
    allowed = true;
    w.hooks.duringNonce = () => { allowed = false; };
    await assert.rejects(call(journal, w.input(), authorize), { code: 'wallet_not_authorized' }, call.name);
  }
  assert.equal(w.calls.broadcast.length, 0, 'nothing is sent after the authorization is withdrawn');
  // Authorized again: the same bytes, never a second signature.
  w.hooks.duringNonce = undefined; allowed = true;
  assert.deepEqual(await resume(journal, w.input(), authorize), { status: 'rebroadcast', txHash: kept.hash });
  assert.deepEqual(w.calls.broadcast, [JSON.stringify(kept)], 'the kept bytes, exactly');
  assert.equal(w.calls.sign, 1, 'signed once');
});

test('resume never signs: an empty journal answers unsigned and only the guarded submit signs, once', async (t) => {
  const w = wallet(t);
  const journal = w.open();
  t.after(() => journal.close());
  assert.equal((await resume(journal, w.input())).status, 'unsigned');
  assert.equal(w.calls.sign, 0);
  const { reconciliationId } = await submit(journal, w.input());
  assert.deepEqual(await resume(journal, w.input()), { status: 'applied', txHash: reconciliationId });
  assert.equal(w.calls.sign, 1);
});

test('two handles on one journal file submitting at once keep one live CREATE, signed once', async (t) => {
  const w = wallet(t);
  const one = w.open(), two = w.open();
  t.after(() => { one.close(); two.close(); });
  const answers = await Promise.all([submit(one, w.input()), submit(two, w.input())]);
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.equal(answers[0].reconciliationId, answers[1].reconciliationId, 'both answer the one kept CREATE');
  assert.equal(w.node.transactionState(answers[0].reconciliationId), 'applied');
});

test('a journal file made for the other kind is refused, so evidence and Deliverable rows are never mixed', async (t) => {
  const w = wallet(t);
  w.open(w.path, createPaymentEvidenceWalletJournal).close();
  assert.throws(() => w.open(), /made for another kind of journal/);
  const deliverables = w.open(join(w.dir, 'deliverables.sqlite'));
  deliverables.close();
  assert.throws(() => w.open(join(w.dir, 'deliverables.sqlite'), createPaymentEvidenceWalletJournal), /made for another kind of journal/);
});

test('simultaneous first opens of the two journal kinds keep one kind: the other is refused, never mixed', async (t) => {
  const w = wallet(t), barrier = new SharedArrayBuffer(4), starts = [], answers = [], exits = [];
  for (const kind of ['deliverable', 'evidence']) {
    const worker = new Worker(new URL('./helpers/deliverable-wallet-initialize-kind.mjs', import.meta.url), { workerData: { path: w.path, barrier, kind } });
    t.after(() => worker.terminate());
    starts.push(new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => { if (message.ready) resolve(); });
    }));
    answers.push(new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => { if (!message.ready) resolve(message); });
    }));
    exits.push(new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); }));
  }
  await Promise.all(starts);
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
  const results = await Promise.all(answers);
  const opened = results.filter((result) => result.error === undefined), refused = results.filter((result) => result.error !== undefined);
  assert.equal(opened.length, 1, `exactly one journal kind opens the file: ${JSON.stringify(results)}`);
  assert.match(opened[0].journalId, /^[0-9a-f]{32}$/);
  assert.equal(refused.length, 1, `the other kind is refused: ${JSON.stringify(results)}`);
  assert.match(refused[0].error, /made for another kind of journal/);
  assert.deepEqual(await Promise.all(exits), [0, 0]);
  const db = new DatabaseSync(w.path);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_creates'").all().map((row) => row.name);
    assert.equal(tables.length, 1, `exactly one kind's table: ${JSON.stringify(tables)}`);
  } finally { db.close(); }
});
