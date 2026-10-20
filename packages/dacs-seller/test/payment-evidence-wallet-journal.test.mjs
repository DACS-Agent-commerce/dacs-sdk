// The seller wallet's payment-evidence journal on its own: what the agent
// relies on from anchorEvidence and reconcilePaymentEvidence (DACS-4 PC-7(b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaymentEvidenceWalletJournal } from '../src/index.mjs';

const ADDRESS = 'dacs4:payment:TEST-job:demos-native:DEM:2', EVIDENCE = 'e1'.repeat(32), TX = 'f2'.repeat(32);
const input = (extra = {}) => ({ logicalAddress: ADDRESS, artifact: { TEST: 'evidence' }, writer: 'did:demos:agent:TEST', artifactKind: 'SettlementEvidence', jobId: 'TEST-job', receiptContentHash: EVIDENCE, ...extra });

function wallet(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wallet-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite'), calls = { sign: 0, broadcast: [] }, faults = { sign: [], broadcast: [] };
  const open = () => createPaymentEvidenceWalletJournal({ path,
    signCreate: async () => {
      calls.sign++;
      const fault = faults.sign.shift();
      if (fault === 'throw') throw new Error('TEST wallet failed before signing');
      if (fault === 'malformed') return { signedTransaction: '', txHash: 'not-a-hash' };
      return { signedTransaction: `TEST-signed:${calls.sign}`, txHash: TX };
    },
    broadcast: async (signed) => { calls.broadcast.push(signed.signedTransaction); if (faults.broadcast.shift() === 'throw') throw new Error('TEST node unreachable'); } });
  return { dir, path, calls, faults, open };
}

test('an address is signed once: the kept signed CREATE is broadcast again as the same bytes, also after the journal is reopened', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  assert.deepEqual(await journal.reconcilePaymentEvidence(input()), { status: 'unsigned', reason: 'the wallet journal kept no signed CREATE for this address' });
  w.faults.broadcast.push('throw');
  await assert.rejects(journal.anchorEvidence(input()), /TEST node unreachable/, 'a broadcast that fails after signing throws');
  journal.close();
  journal = w.open();
  t.after(() => journal.close());
  assert.deepEqual(await journal.reconcilePaymentEvidence(input()), { status: 'rebroadcast', txHash: TX }, 'signed and kept: broadcast again, never unsigned');
  assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: TX }, 'a second anchor broadcasts the kept CREATE');
  w.faults.broadcast.push('throw');
  const pending = await journal.reconcilePaymentEvidence(input());
  assert.deepEqual([pending.status, pending.txHash], ['pending', TX], 'a broadcast that fails keeps it pending');
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.deepEqual(new Set(w.calls.broadcast), new Set(['TEST-signed:1']), 'every broadcast is the same signed bytes');
});

test('nothing signed is unsigned: a throw before signing or a signature that is not one keeps nothing, so the evidence can be anchored again', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.sign.push('throw', 'malformed');
  await assert.rejects(journal.anchorEvidence(input()), /TEST wallet failed before signing/);
  await assert.rejects(journal.anchorEvidence(input()), { code: 'wallet_sign_invalid' });
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'unsigned');
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  assert.deepEqual(await journal.anchorEvidence(input()), { status: 'submitted', txHash: TX });
  assert.equal((await journal.reconcilePaymentEvidence(input())).status, 'rebroadcast');
});

test('other evidence at a kept address is refused, and the journal file must be private', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  await journal.anchorEvidence(input());
  for (const ask of [journal.anchorEvidence, journal.reconcilePaymentEvidence]) {
    await assert.rejects(ask(input({ receiptContentHash: 'a3'.repeat(32) })), { code: 'wallet_journal_conflict' });
  }
  await assert.rejects(journal.reconcilePaymentEvidence({}), { name: 'TypeError' });
  assert.equal(w.calls.sign, 1);
  const shared = join(w.dir, 'shared.sqlite');
  writeFileSync(shared, '');
  chmodSync(shared, 0o644);
  assert.throws(() => createPaymentEvidenceWalletJournal({ path: shared, signCreate: async () => null, broadcast: async () => null }), /private \(0600\) file/);
  assert.throws(() => createPaymentEvidenceWalletJournal({ path: 'journal.sqlite', signCreate: async () => null, broadcast: async () => null }), /must be absolute/);
});
