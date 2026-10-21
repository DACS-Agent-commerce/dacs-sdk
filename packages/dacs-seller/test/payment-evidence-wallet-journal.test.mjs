// The seller wallet's payment-evidence journal on its own: what the agent
// relies on from anchorEvidence and reconcilePaymentEvidence (DACS-4 PC-7(b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaymentEvidenceWalletJournal } from '../src/index.mjs';

const ADDRESS = 'dacs4:payment:TEST-job:demos-native:DEM:2', EVIDENCE = 'e1'.repeat(32);
const input = (extra = {}) => ({ logicalAddress: ADDRESS, artifact: { TEST: 'evidence' }, writer: 'did:demos:agent:TEST', artifactKind: 'SettlementEvidence', jobId: 'TEST-job', receiptContentHash: EVIDENCE, ...extra });
const txHash = (n) => n.toString(16).padStart(2, '0').repeat(32);

// A wallet over one account on a chain with the node's nonce rule (node
// 61b8e75 validateTransaction: a nonce not above the account's is invalid):
// `land(hash)` applies a broadcast transaction only while its nonce is above
// the account nonce, and `other()` lands another write from the same account.
function wallet(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wallet-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite'), calls = { sign: 0, broadcast: [], reads: [] }, faults = { sign: [], broadcast: [], nonce: [], state: [] };
  const chain = { accountNonce: 0, nextNonce: 1, signed: new Map(), applied: new Set(), pending: new Set() };
  const land = (hash) => { const tx = chain.signed.get(hash); if (tx && !chain.applied.has(hash) && tx.nonce > chain.accountNonce) { chain.applied.add(hash); chain.accountNonce = tx.nonce; } };
  const other = () => { chain.accountNonce = Math.max(chain.accountNonce, chain.nextNonce); chain.nextNonce = chain.accountNonce + 1; };
  const open = (extra = {}) => createPaymentEvidenceWalletJournal({ path, readTimeoutMs: 200,
    signCreate: async () => {
      calls.sign++;
      const fault = faults.sign.shift();
      if (fault === 'throw') throw new Error('TEST wallet failed before signing');
      if (fault === 'malformed') return { signedTransaction: '', txHash: 'not-a-hash' };
      if (fault === 'no-nonce') return { signedTransaction: `TEST-signed:${calls.sign}`, txHash: txHash(calls.sign) };
      const nonce = fault === 'stale-nonce' ? 1 : chain.nextNonce++, hash = txHash(calls.sign);
      chain.signed.set(hash, { nonce });
      return { signedTransaction: `TEST-signed:${calls.sign}`, txHash: hash, nonce };
    },
    broadcast: async ({ signedTransaction, txHash: hash }) => {
      calls.broadcast.push(signedTransaction);
      const fault = faults.broadcast.shift();
      if (fault === 'throw') throw new Error('TEST node unreachable');
      if (fault !== 'drop') land(hash);
    },
    readAccountNonce: async () => {
      calls.reads.push('nonce');
      const fault = faults.nonce.shift();
      if (fault === 'throw') throw new Error('TEST nonce read failed');
      if (fault === 'hang') return new Promise(() => {});
      if (fault === 'malformed') return '7';
      return chain.accountNonce;
    },
    readTransactionState: async ({ txHash: hash }) => {
      calls.reads.push('state');
      const fault = faults.state.shift();
      if (fault === 'throw') throw new Error('TEST state read failed');
      if (fault === 'malformed') return 'unknown';
      return chain.applied.has(hash) ? 'applied' : chain.pending.has(hash) ? 'pending' : 'absent';
    }, ...extra });
  return { dir, path, calls, faults, chain, other, open };
}

test('an address is signed once: the kept signed CREATE is broadcast again as the same bytes, also after the journal is reopened', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  assert.deepEqual(await journal.reconcilePaymentEvidence(input()), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' });
  w.faults.broadcast.push('throw');
  await assert.rejects(journal.anchorEvidence(input()), /TEST node unreachable/, 'a broadcast that fails after signing throws');
  journal.close();
  journal = w.open();
  t.after(() => journal.close());
  assert.deepEqual(await journal.reconcilePaymentEvidence(input()), { status: 'rebroadcast', txHash: txHash(1) }, 'signed and kept, nonce not overtaken: broadcast again, never unsigned');
  assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: txHash(1) }, 'a second anchor broadcasts the kept CREATE');
  w.faults.broadcast.push('throw');
  const pending = await journal.reconcilePaymentEvidence(input());
  assert.deepEqual([pending.status, pending.txHash], ['pending', txHash(1)], 'a broadcast that fails keeps it pending');
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.deepEqual(new Set(w.calls.broadcast), new Set(['TEST-signed:1']), 'every broadcast is the same signed bytes');
});

test('nothing signed is unsigned: a throw before signing or a signature that is not one keeps nothing, so the evidence can be anchored again', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.sign.push('throw', 'malformed', 'no-nonce');
  await assert.rejects(journal.anchorEvidence(input()), /TEST wallet failed before signing/);
  await assert.rejects(journal.anchorEvidence(input()), { code: 'wallet_sign_invalid' });
  await assert.rejects(journal.anchorEvidence(input()), { code: 'wallet_sign_invalid' }, 'a signature without its nonce is not kept');
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned');
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: txHash(4) });
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'rebroadcast');
});

// DACS-4 PC-7(b): a kept CREATE whose broadcast was dropped and whose nonce
// another write of the same wallet then overtook can never be included. The
// journal reads that from the chain, keeps the dead row, answers 'unsigned'
// once, and the next anchor signs the same evidence anew, once.
test('a dropped CREATE overtaken by another write of the wallet is superseded: unsigned, then signed anew once and applied, also after the journal is reopened', async (t) => {
  for (const reopen of [false, true]) {
    const w = wallet(t);
    let journal = w.open();
    w.faults.broadcast.push('drop');
    assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: txHash(1) });
    assert.equal(w.chain.applied.size, 0, 'the node never applied it');
    w.other();
    assert.equal(w.chain.accountNonce, 2, 'another write of the wallet landed above the kept nonce');
    if (reopen) { journal.close(); journal = w.open(); }
    const answer = await journal.reconcilePaymentEvidence(input());
    assert.equal(answer.status, 'unsigned', JSON.stringify(answer));
    assert.equal(answer.txHash, txHash(1), 'it names the superseded CREATE');
    assert.match(answer.reason, /can no longer be included/);
    assert.deepEqual(w.calls.reads, ['nonce', 'state'], 'the account nonce is read before the transaction state');
    assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned', 'superseded stays superseded');
    if (reopen) { journal.close(); journal = w.open(); }
    assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: txHash(2) }, 'signed anew');
    assert.ok(w.chain.applied.has(txHash(2)), 'the new signature lands');
    assert.deepEqual(await journal.reconcilePaymentEvidence(input()), { status: 'rebroadcast', txHash: txHash(2) }, 'the applied CREATE is live, never superseded');
    assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: txHash(2) }, 'and is not signed again');
    assert.equal(w.calls.sign, 2, 'signed once more, once');
    const db = new DatabaseSync(w.path), rows = db.prepare('SELECT tx_hash, nonce, superseded_at IS NOT NULL AS superseded FROM evidence_creates ORDER BY nonce').all().map((row) => ({ ...row }));
    db.close();
    assert.deepEqual(rows, [{ tx_hash: txHash(1), nonce: 1, superseded: 1 }, { tx_hash: txHash(2), nonce: 3, superseded: 0 }], 'the dead row is kept, marked superseded');
    journal.close();
  }
});

test('a kept CREATE that can still land, is pending, or cannot be read is never superseded: the same bytes stay live', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  await journal.anchorEvidence(input());
  const expectLive = async (label) => {
    const answer = await journal.reconcilePaymentEvidence(input());
    assert.equal(answer.status === 'rebroadcast' || answer.status === 'pending', true, `${label}: ${JSON.stringify(answer)}`);
    assert.equal(answer.txHash, txHash(1), label);
    return answer;
  };
  // Nonce not overtaken: it can still be included; the state is not even read.
  w.faults.broadcast.push('drop');
  await expectLive('account nonce below the kept nonce');
  assert.deepEqual(w.calls.reads, ['nonce']);
  w.other();
  w.chain.pending.add(txHash(1));
  w.faults.broadcast.push('drop');
  await expectLive('pending in the mempool');
  w.chain.pending.delete(txHash(1));
  for (const [label, fault] of [['nonce read throws', ['nonce', 'throw']], ['nonce read never answers', ['nonce', 'hang']], ['nonce read answers no integer', ['nonce', 'malformed']],
    ['state read throws', ['state', 'throw']], ['state read answers another state', ['state', 'malformed']]]) {
    w.faults[fault[0]].push(fault[1]);
    w.faults.broadcast.push('drop');
    const answer = await expectLive(label);
    assert.match(answer.reason, /could not be read/, `${label}: the read's cause is kept`);
  }
  assert.equal(w.calls.sign, 1, 'never signed anew');
  assert.deepEqual(new Set(w.calls.broadcast), new Set(['TEST-signed:1']));
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned', 'once every read answers, the overtaken CREATE is superseded');
});

test('a new signature must use a nonce above every kept one, or nothing is kept or sent', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  await journal.anchorEvidence(input());
  w.other();
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned');
  w.faults.sign.push('stale-nonce');
  await assert.rejects(journal.anchorEvidence(input()), { code: 'wallet_sign_invalid', message: /not above the kept nonce 1/ });
  assert.equal(w.calls.broadcast.length, 1, 'the stale signature is not broadcast');
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned');
});

test('other evidence at a kept address is refused, and the journal file must be private, readable and of this format', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  await journal.anchorEvidence(input());
  for (const ask of [journal.anchorEvidence, journal.reconcilePaymentEvidence]) {
    await assert.rejects(ask(input({ receiptContentHash: 'a3'.repeat(32) })), { code: 'wallet_journal_conflict' });
  }
  await assert.rejects(journal.reconcilePaymentEvidence({}), { name: 'TypeError' });
  assert.equal(w.calls.sign, 1);
  const primitives = { signCreate: async () => null, broadcast: async () => null, readAccountNonce: async () => 0, readTransactionState: async () => 'absent' };
  const shared = join(w.dir, 'shared.sqlite');
  writeFileSync(shared, '');
  chmodSync(shared, 0o644);
  assert.throws(() => createPaymentEvidenceWalletJournal({ path: shared, ...primitives }), /private \(0600\) file/);
  assert.throws(() => createPaymentEvidenceWalletJournal({ path: 'journal.sqlite', ...primitives }), /must be absolute/);
  for (const missing of ['readAccountNonce', 'readTransactionState']) {
    assert.throws(() => createPaymentEvidenceWalletJournal({ path: join(w.dir, `${missing}.sqlite`), ...primitives, [missing]: undefined }), /needs readAccountNonce and readTransactionState/);
  }
  const earlier = join(w.dir, 'earlier.sqlite'), db = new DatabaseSync(earlier);
  db.exec('CREATE TABLE signed_creates (logical_address TEXT PRIMARY KEY)');
  db.close();
  chmodSync(earlier, 0o600);
  assert.throws(() => createPaymentEvidenceWalletJournal({ path: earlier, ...primitives }), /earlier format/);
});
