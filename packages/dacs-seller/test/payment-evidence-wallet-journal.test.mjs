// The seller wallet's payment-evidence journal on its own: what the agent
// relies on from anchorEvidence and reconcilePaymentEvidence (DACS-4 PC-7(b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentEvidenceWalletJournal } from '../src/index.mjs';
import { isPaymentEvidenceWalletJournalPair } from '../src/dacs/payment-evidence-wallet-journal.mjs';
import { evidenceInput, newWalletChainState, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';

const CRASH_CHILD = fileURLToPath(new URL('./helpers/payment-evidence-wallet-crash.mjs', import.meta.url));

// A wallet over one account on a chain with the node's nonce rule
// (helpers/payment-evidence-wallet-chain.mjs). `calls.signed` lists the hash of
// each signature signCreate answered, in order. `file: true` keeps the chain in
// a file; `reload()` reads it again after another process changed it.
function wallet(t, { file = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wallet-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chainFile = file ? join(dir, 'chain.json') : null;
  if (chainFile) writeFileSync(chainFile, JSON.stringify(newWalletChainState()));
  let node = walletChain({ file: chainFile });
  const reload = () => { node = walletChain({ file: chainFile }); return node; };
  const path = join(dir, 'journal.sqlite'), calls = { sign: 0, signed: [], broadcast: [], reads: [] }, faults = { sign: [], broadcast: [], nonce: [], state: [] };
  const input = (extra = {}) => evidenceInput(node.claim, extra);
  const open = (extra = {}) => createPaymentEvidenceWalletJournal({ path, readTimeoutMs: 200,
    signCreate: async (asked) => {
      calls.sign++;
      const fault = faults.sign.shift();
      if (fault === 'throw') throw new Error('TEST wallet failed before signing');
      if (fault === 'malformed') return { signedTransaction: '', txHash: 'not-a-hash' };
      if (fault === 'no-nonce') { const { nonce: _nonce, ...answer } = node.signCreate(asked); return answer; }
      const answer = node.signCreate(asked, fault === 'stale-nonce' ? { nonce: 1 } : typeof fault === 'object' ? fault : {});
      calls.signed.push(answer.txHash);
      return answer;
    },
    broadcast: async ({ signedTransaction, txHash: hash }) => {
      calls.broadcast.push(signedTransaction);
      const fault = faults.broadcast.shift();
      if (fault === 'throw') throw new Error('TEST node unreachable');
      if (fault !== 'drop') node.land(hash);
    },
    readAccountNonce: async () => {
      calls.reads.push('nonce');
      const fault = faults.nonce.shift();
      if (fault === 'throw') throw new Error('TEST nonce read failed');
      if (fault === 'hang') return new Promise(() => {});
      if (fault === 'malformed') return '7';
      return { nonce: node.accountNonce(), blockHeight: node.accountNonce() };
    },
    readTransactionState: async ({ txHash: hash }) => {
      calls.reads.push('state');
      const fault = faults.state.shift();
      if (fault === 'throw') throw new Error('TEST state read failed');
      if (fault === 'malformed') return 'unknown';
      return { state: node.transactionState(hash), checkedThroughBlock: node.accountNonce() };
    }, ...extra });
  return { dir, path, chainFile, calls, faults, get chain() { return node.chain; }, other: () => node.other(), reload, open, input };
}

test('an address is signed once: the kept signed CREATE is broadcast again as the same bytes, also after the journal is reopened', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  assert.deepEqual(await journal.reconcilePaymentEvidence(w.input()), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' });
  w.faults.broadcast.push('throw');
  await assert.rejects(journal.anchorEvidence(w.input()), /TEST node unreachable/, 'a broadcast that fails after signing throws');
  journal.close();
  journal = w.open();
  t.after(() => journal.close());
  const [first] = w.calls.signed;
  assert.deepEqual(await journal.reconcilePaymentEvidence(w.input()), { status: 'rebroadcast', txHash: first }, 'signed and kept, nonce not overtaken: broadcast again, never unsigned');
  assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'submitted', txHash: first }, 'a second anchor broadcasts the kept CREATE');
  w.faults.broadcast.push('throw');
  const pending = await journal.reconcilePaymentEvidence(w.input());
  assert.deepEqual([pending.status, pending.txHash], ['pending', first], 'a broadcast that fails keeps it pending');
  assert.equal(w.calls.sign, 1, 'signed once');
  assert.equal(new Set(w.calls.broadcast).size, 1, 'every broadcast is the same signed bytes');
});

// A lost or replaced journal file keeps nothing of an anchor the earlier one
// sent: it never answers `unsigned` about an attempt whose transaction it
// did not keep. Its id is its file's; the live CREATE's projection reads back.
test('a journal asked about a transaction it never kept refuses; its id and the live projection belong to its file', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  const id = journal.journalId;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(await journal.readSignedProjection(w.input()), null, 'nothing kept, nothing to read');
  const { txHash } = await journal.anchorEvidence(w.input());
  const projection = await journal.readSignedProjection(w.input());
  assert.equal(projection.hash, txHash, 'the live kept CREATE');
  assert.equal(JSON.stringify(projection), w.calls.broadcast.at(-1), 'exactly the bytes broadcast');
  assert.deepEqual(await journal.reconcilePaymentEvidence({ ...w.input(), attempt: { outcome: 'sent', answer: { status: 'submitted', txHash } } }), { status: 'rebroadcast', txHash }, 'its own attempt is answered');
  journal.close();
  journal = w.open();
  assert.equal(journal.journalId, id, 'the same file is the same journal');
  journal.close();
  rmSync(w.path);
  journal = w.open();
  t.after(() => journal.close());
  assert.notEqual(journal.journalId, id, 'a new file is another journal');
  await assert.rejects(journal.reconcilePaymentEvidence({ ...w.input(), attempt: { outcome: 'sent', answer: { status: 'submitted', txHash } } }), { code: 'wallet_journal_unknown_attempt' });
  assert.deepEqual(await journal.reconcilePaymentEvidence(w.input()), { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' }, 'asked about no attempt, it holds nothing');
  assert.equal(w.calls.sign, 1, 'nothing signed anew');
});

test('nothing signed is unsigned: a throw before signing or a signature that is not one keeps nothing, so the evidence can be anchored again', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.sign.push('throw', 'malformed', 'no-nonce');
  await assert.rejects(journal.anchorEvidence(w.input()), /TEST wallet failed before signing/);
  await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid' });
  await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid' }, 'a signature without its nonce is not kept');
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned');
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'submitted', txHash: w.calls.signed.at(-1) });
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'rebroadcast');
});

// The fate of a kept CREATE is read by its hash and its nonce, so a wallet
// whose answer names another hash or nonce than its signed bytes, or whose
// bytes are not this evidence's CREATE signed by the writer, would let the
// journal supersede a transaction that can still land and sign the evidence
// twice. Such an answer is refused before anything is kept or broadcast.
test('a signCreate answer that is not the signed CREATE it names is refused: nothing is kept or broadcast, and the evidence is still unsigned', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  for (const [label, change, message] of [['a txHash the bytes do not hash to', { txHash: 'a7'.repeat(32) }, /does not hash to its txHash/],
    ['a nonce the bytes do not carry', { claimedNonce: 9 }, /carries another nonce/], ['other evidence', { artifact: { TEST: 'other evidence' } }, /not this evidence's storage CREATE/],
    ['another writer\'s address', { from: `0x${'b8'.repeat(32)}` }, /not this evidence's storage CREATE|not signed by the writer/],
    ['a signature that does not verify', { signature: `0x${'00'.repeat(64)}` }, /not signed by the writer/]]) {
    w.faults.sign.push(change);
    await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid', message }, label);
    assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned', `${label}: nothing is kept`);
  }
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  const db = new DatabaseSync(w.path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_creates').get().n, 0); } finally { db.close(); }
  assert.equal((await journal.anchorEvidence(w.input())).status, 'submitted', 'a true signature is kept and sent');
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'rebroadcast');
});

// The kept bytes must be a CREATE the node can execute and the SR-2 readback
// (demos-sr2-adapter.mjs authenticate) can read back as this evidence: exactly
// the signed projection (node 61b8e75 validateTransaction refuses a truthy
// top-level `status`, which the signature does not cover), at the storage
// address the writer, the program name and the nonce derive, from the writer on
// both sender fields, with the readback's salt, encoding and metadata, and the
// SDK's signature encoding. Kept otherwise, the CREATE could never land or read
// back, and while its nonce is not overtaken it would never be superseded.
test('a signed CREATE the node or the readback would refuse is not kept: exact projection, derived address, both senders, salt, encoding, metadata and signature encoding', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  const meta = (key, value) => ({ edit: (content) => { content.data[1].metadata[key] = value; } });
  const NOT_EVIDENCE = /not this evidence's storage CREATE/, NOT_AT = /not at the storage address/, PROJECTION = /not exactly the signed projection/, NOT_SIGNED = /not signed by the writer/;
  for (const [label, change, message] of [
    ['a truthy top-level status', { wrap: (signed) => ({ ...signed, status: 'confirmed' }) }, PROJECTION],
    ['an empty top-level status', { wrap: (signed) => ({ ...signed, status: '' }) }, PROJECTION],
    ['another top-level member', { wrap: (signed) => ({ ...signed, blockNumber: 7 }) }, PROJECTION],
    ['another signature member', { wrap: (signed) => ({ ...signed, signature: { ...signed.signature, publicKey: 'TEST' } }) }, PROJECTION],
    ['another destination', { edit: (content) => { content.to = `stor-${'c4'.repeat(20)}`; } }, NOT_AT],
    ['another storage address in the operation', { edit: (content) => { content.data[1].storageAddress = `stor-${'c4'.repeat(20)}`; } }, NOT_AT],
    ['a nonce edited after the address was derived', { nonce: 40, edit: (content) => { content.nonce = 41; } }, NOT_AT],
    ['another from_ed25519_address', { edit: (content) => { content.from_ed25519_address = `0x${'b8'.repeat(32)}`; } }, NOT_SIGNED],
    ['no from_ed25519_address', { edit: (content) => { delete content.from_ed25519_address; } }, NOT_SIGNED],
    ['a salt', { edit: (content) => { content.data[1].salt = 'TEST'; } }, NOT_EVIDENCE],
    ['another encoding', { edit: (content) => { content.data[1].encoding = 'raw'; } }, NOT_EVIDENCE],
    ['another artifact kind', meta('artifactKind', 'Deliverable'), NOT_EVIDENCE],
    ['another content hash', meta('contentHash', 'f2'.repeat(32)), NOT_EVIDENCE],
    ['another envelope hash', meta('envelopeHash', 'f3'.repeat(32)), NOT_EVIDENCE],
    ['no metadata', { edit: (content) => { delete content.data[1].metadata; } }, /is not a signed Demos transaction/],
    ['a base64url signature', { wrap: (signed) => ({ ...signed, signature: { type: 'ed25519', data: Buffer.from(signed.signature.data.slice(2), 'hex').toString('base64url') } }) }, NOT_SIGNED],
    ['an upper-case hex signature', { wrap: (signed) => ({ ...signed, signature: { type: 'ed25519', data: `0x${signed.signature.data.slice(2).toUpperCase()}` } }) }, NOT_SIGNED]]) {
    w.faults.sign.push(change);
    await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid', message }, label);
    assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned', `${label}: nothing is kept`);
  }
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  assert.equal((await journal.anchorEvidence(w.input())).status, 'submitted', 'the exact projection at the derived address is kept and sent');
  assert.equal(w.calls.broadcast.length, 1);
});

test('the pair check names only one journal\'s own anchorEvidence and reconcilePaymentEvidence', async (t) => {
  const a = wallet(t).open(), b = wallet(t).open();
  t.after(() => { a.close(); b.close(); });
  assert.equal(isPaymentEvidenceWalletJournalPair(a.anchorEvidence, a.reconcilePaymentEvidence), true);
  for (const [label, anchor, reconcile] of [['two journals', a.anchorEvidence, b.reconcilePaymentEvidence], ['swapped', a.reconcilePaymentEvidence, a.anchorEvidence],
    ['a wrapper', (input) => a.anchorEvidence(input), a.reconcilePaymentEvidence], ['scripted', async () => ({ status: 'refused' }), async () => ({ status: 'unsigned' })], ['none', undefined, undefined]]) {
    assert.equal(isPaymentEvidenceWalletJournalPair(anchor, reconcile), false, label);
  }
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
    const first = (await journal.anchorEvidence(w.input())).txHash;
    assert.equal(first, w.calls.signed[0]);
    assert.equal(w.chain.applied.length, 0, 'the node never applied it');
    w.other();
    assert.equal(w.chain.accountNonce, 2, 'another write of the wallet landed above the kept nonce');
    if (reopen) { journal.close(); journal = w.open(); }
    const answer = await journal.reconcilePaymentEvidence(w.input());
    assert.equal(answer.status, 'unsigned', JSON.stringify(answer));
    assert.equal(answer.txHash, first, 'it names the superseded CREATE');
    assert.match(answer.reason, /can no longer be executed/);
    assert.deepEqual(w.calls.reads, ['nonce', 'state'], 'the account nonce is read before the transaction state');
    journal.close(); journal = w.open();
    // The agent still holds the earlier attempt: its checkpoint was lost.
    const replay = await journal.reconcilePaymentEvidence({ ...w.input(), attempt: { answer: { txHash: first } } });
    assert.equal(replay.status, 'unsigned', 'superseded stays superseded');
    assert.equal(replay.txHash, first, 'the durable answer still names the transaction the agent must release');
    if (reopen) { journal.close(); journal = w.open(); }
    const second = (await journal.anchorEvidence(w.input())).txHash;
    assert.equal(second, w.calls.signed[1], 'signed anew');
    assert.ok(w.chain.applied.includes(second), 'the new signature lands');
    assert.deepEqual(await journal.reconcilePaymentEvidence(w.input()), { status: 'rebroadcast', txHash: second }, 'the applied CREATE is live, never superseded');
    assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'submitted', txHash: second }, 'and is not signed again');
    assert.equal(w.calls.sign, 2, 'signed once more, once');
    const db = new DatabaseSync(w.path), rows = db.prepare('SELECT tx_hash, nonce, superseded_at IS NOT NULL AS superseded FROM evidence_creates ORDER BY nonce').all().map((row) => ({ ...row }));
    db.close();
    assert.deepEqual(rows, [{ tx_hash: first, nonce: 1, superseded: 1 }, { tx_hash: second, nonce: 3, superseded: 0 }], 'the dead row is kept, marked superseded');
    journal.close();
  }
});

test('a kept CREATE that can still land, is pending, or cannot be read is never superseded: the same bytes stay live', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  const kept = (await journal.anchorEvidence(w.input())).txHash;
  const expectLive = async (label) => {
    const answer = await journal.reconcilePaymentEvidence(w.input());
    assert.equal(answer.status === 'rebroadcast' || answer.status === 'pending', true, `${label}: ${JSON.stringify(answer)}`);
    assert.equal(answer.txHash, kept, label);
    return answer;
  };
  // Nonce not overtaken: it can still be executed; the state is not even read.
  w.faults.broadcast.push('drop');
  await expectLive('account nonce below the kept nonce');
  assert.deepEqual(w.calls.reads, ['nonce']);
  w.other();
  w.chain.pending.push(kept);
  w.faults.broadcast.push('drop');
  await expectLive('pending in the mempool');
  w.chain.pending.length = 0;
  for (const [label, fault] of [['nonce read throws', ['nonce', 'throw']], ['nonce read never answers', ['nonce', 'hang']], ['nonce read answers no integer', ['nonce', 'malformed']],
    ['state read throws', ['state', 'throw']], ['state read answers another state', ['state', 'malformed']]]) {
    w.faults[fault[0]].push(fault[1]);
    w.faults.broadcast.push('drop');
    const answer = await expectLive(label);
    assert.match(answer.reason, /could not be read/, `${label}: the read's cause is kept`);
  }
  assert.equal(w.calls.sign, 1, 'never signed anew');
  assert.equal(new Set(w.calls.broadcast).size, 1);
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned', 'once every read answers, the overtaken CREATE is superseded');
});

test('a new signature must use a nonce above every kept one, or nothing is kept or sent', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  await journal.anchorEvidence(w.input());
  w.other();
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned');
  w.faults.sign.push('stale-nonce');
  await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid', message: /not above the kept nonce 1/ });
  assert.equal(w.calls.broadcast.length, 1, 'the stale signature is not broadcast');
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned');
});

test('other evidence at a kept address is refused, and the journal file must be private, readable and of this format', async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  await journal.anchorEvidence(w.input());
  for (const ask of [journal.anchorEvidence, journal.reconcilePaymentEvidence]) {
    await assert.rejects(ask(w.input({ receiptContentHash: 'a3'.repeat(32) })), { code: 'wallet_journal_conflict' });
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

// Process death at the wallet's signed-effect boundary (DACS-4 PC-7(b)): a
// child process anchors the evidence through the journal over a chain kept in
// a file, and is killed (SIGKILL) at a cut. The journal is then reopened from
// disk in this process: exactly one live signed CREATE, every broadcast the
// same bytes, and no new signature while the kept one can still land.
test('a process killed after signing, after the signed CREATE is kept, or after its broadcast leaves the journal on disk to recover: one live signed CREATE, never signed twice while it can land', async (t) => {
  for (const cut of ['signed', 'kept', 'sent']) {
    const w = wallet(t, { file: true });
    const child = spawnSync(process.execPath, [CRASH_CHILD, w.path, w.chainFile, cut], { encoding: 'utf8', timeout: 60000, env: process.env });
    assert.equal(child.signal, 'SIGKILL', `${cut}: the child died at the cut (${child.stderr})`);
    const signedByChild = Object.keys(w.reload().chain.signed);
    assert.equal(signedByChild.length, 1, `${cut}: the child signed once`);
    const journal = w.open();
    t.after(() => journal.close());
    const db = () => { const d = new DatabaseSync(w.path, { readOnly: true }); try { return d.prepare('SELECT tx_hash, superseded_at FROM evidence_creates').all().map((row) => ({ ...row })); } finally { d.close(); } };
    const answer = await journal.reconcilePaymentEvidence(w.input());
    if (cut === 'signed') {
      // Killed inside signCreate: signed, never kept, never sent. Nothing kept can land.
      assert.deepEqual(db(), [], 'signed: nothing was kept');
      assert.equal(answer.status, 'unsigned', `signed: ${JSON.stringify(answer)}`);
      assert.equal(w.chain.applied.length, 0, 'signed: nothing was sent');
      const anchored = await journal.anchorEvidence(w.input());
      assert.notEqual(anchored.txHash, signedByChild[0], 'signed: the evidence is signed anew, its first signature never sent');
    } else {
      // Kept before the broadcast (cut 'kept'), or sent and applied (cut 'sent'):
      // the kept CREATE is the one live row, broadcast again as the same bytes.
      assert.deepEqual(db(), [{ tx_hash: signedByChild[0], superseded_at: null }], `${cut}: the signed CREATE was kept before it was sent`);
      assert.deepEqual(answer, { status: 'rebroadcast', txHash: signedByChild[0] }, `${cut}: never unsigned while it can land`);
      assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'submitted', txHash: signedByChild[0] }, `${cut}: a second anchor broadcasts the kept CREATE`);
      assert.equal(w.calls.sign, 0, `${cut}: this process signed nothing`);
    }
    assert.equal(w.chain.applied.length, 1, `${cut}: one CREATE landed`);
    assert.equal(db().filter((row) => row.superseded_at === null).length, 1, `${cut}: one live signed CREATE`);
    assert.equal(new Set(w.calls.broadcast).size, 1, `${cut}: every broadcast here is the same signed bytes`);
  }
});


test('nonce advancement with an unknown transaction keeps the CREATE until its indexed inclusion becomes visible', async (t) => {
  const w = wallet(t);
  let visible = 'absent';
  const journal = w.open({ readAccountNonce: async () => 1, readTransactionState: async () => visible });
  t.after(() => journal.close());
  const first = (await journal.anchorEvidence(w.input())).txHash;
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'rebroadcast');
  assert.equal((await journal.anchorEvidence(w.input())).txHash, first);
  visible = 'applied';
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'rebroadcast');
  assert.equal(w.calls.sign, 1);
  assert.equal(new Set(w.calls.broadcast).size, 1);
});

test('only a complete absence snapshot at or beyond the nonce snapshot releases a CREATE', async (t) => {
  const w = wallet(t);
  let checkedThroughBlock = 7;
  const journal = w.open({ readAccountNonce: async () => ({ nonce: w.chain.accountNonce, blockHeight: 8 }),
    readTransactionState: async () => ({ state: 'absent', checkedThroughBlock }) });
  t.after(() => journal.close());
  w.faults.broadcast.push('drop');
  await journal.anchorEvidence(w.input());
  w.other();
  for (const coverage of [7, undefined, -1, '8']) {
    checkedThroughBlock = coverage;
    w.faults.broadcast.push('drop');
    assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'rebroadcast', String(coverage));
  }
  checkedThroughBlock = 8;
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned');
  await journal.anchorEvidence(w.input());
  assert.equal(w.calls.sign, 2);
});
