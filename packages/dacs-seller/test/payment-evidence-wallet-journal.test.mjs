// The seller wallet's payment-evidence journal on its own: what the agent
// relies on from anchorEvidence and reconcilePaymentEvidence (DACS-4 PC-7(b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import DatabaseSync from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentEvidenceWalletJournal } from '../src/index.mjs';
import { isPaymentEvidenceWalletJournalPair } from '../src/dacs/payment-evidence-wallet-journal.mjs';
import { evidenceInput, newWalletChainState, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';
import { sdkRegeneratesSignedCreate } from './helpers/payment-evidence-wallet-sdk.mjs';

const CRASH_CHILD = fileURLToPath(new URL('./helpers/payment-evidence-wallet-crash.mjs', import.meta.url));

// A wallet over one account on a chain with the node's nonce rule
// (helpers/payment-evidence-wallet-chain.mjs), signing with the pinned SDK.
// `calls.signed` lists the hash of each signature signCreate answered, in
// order, and `calls.signedContents` its signed content. `file: true` keeps the
// chain in a file; `reload()` reads it again after another process changed it.
function wallet(t, { file = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wallet-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chainFile = file ? join(dir, 'chain.json') : null;
  if (chainFile) writeFileSync(chainFile, JSON.stringify(newWalletChainState()));
  let node = walletChain({ file: chainFile });
  const reload = () => { node = walletChain({ file: chainFile }); return node; };
  const path = join(dir, 'journal.sqlite'), calls = { sign: 0, signed: [], signedContents: [], broadcast: [], reads: [] }, faults = { sign: [], broadcast: [], nonce: [], state: [] };
  const input = (extra = {}) => evidenceInput(node.claim, extra);
  const open = (extra = {}) => createPaymentEvidenceWalletJournal({ path, readTimeoutMs: 200,
    signCreate: async (asked) => {
      calls.sign++;
      const fault = faults.sign.shift();
      if (fault === 'throw') throw new Error('TEST wallet failed before signing');
      if (fault === 'malformed') return { signedTransaction: '', txHash: 'not-a-hash' };
      if (fault === 'no-nonce') { const { nonce: _nonce, ...answer } = await node.signCreate(asked); return answer; }
      const answer = await node.signCreate(asked, fault === 'stale-nonce' ? { nonce: 1 } : typeof fault === 'object' ? fault : {});
      calls.signed.push(answer.txHash);
      calls.signedContents.push(JSON.parse(answer.signedTransaction).content);
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
  assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'applied', txHash: first }, 'a second anchor reports the retained applied CREATE');
  const applied = await journal.reconcilePaymentEvidence(w.input());
  assert.deepEqual([applied.status, applied.txHash], ['applied', first], 'applied transactions stay live without another broadcast');
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
  assert.deepEqual(await journal.reconcilePaymentEvidence({ ...w.input(), attempt: { outcome: 'sent', answer: { status: 'submitted', txHash } } }), { status: 'applied', txHash }, 'its own applied attempt is answered');
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
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'applied');
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
    ['another writer\'s address', { edit: (content) => { content.from = content.from_ed25519_address = `0x${'b8'.repeat(32)}`; } }, /not signed by the writer/],
    ['a signature that does not verify', { signature: `0x${'00'.repeat(64)}` }, /not signed by the writer/]]) {
    w.faults.sign.push(change);
    await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid', message }, label);
    assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned', `${label}: nothing is kept`);
  }
  assert.deepEqual(w.calls.broadcast, [], 'nothing was broadcast');
  const db = new DatabaseSync(w.path, { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_creates').get().n, 0); } finally { db.close(); }
  assert.equal((await journal.anchorEvidence(w.input())).status, 'submitted', 'a true signature is kept and sent');
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'applied');
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

// What the pinned SDK's Demos.sign really signs for the evidence CREATE: before
// and after the node's denomination fork (number or string amount, fees and
// balance edits), with the node's fee or the SDK's own, for a storage fee of one
// and of two 10240-byte chunks, and with the SR-2 source binding the signer adds
// before signing. Each is kept and sent as signed, and the SDK regenerates its
// edits and bytes (the node's check), so the journal refuses none the node takes.
const NODE_FEE = { networkFee: 2, rpcFee: 3 }, TWO_CHUNK_ARTIFACT = { artifact: { TEST: 'e'.repeat(12_000) } };
for (const [label, sign, extra] of [
  ['before the denomination fork, with the SDK fee', {}],
  ['before the denomination fork, with the node fee', { nodeFee: NODE_FEE }],
  ['after the denomination fork, with the SDK fee', { postFork: true }],
  ['after the denomination fork, with the node fee', { postFork: true, nodeFee: NODE_FEE }],
  ['for a two-chunk artifact before the denomination fork', {}, TWO_CHUNK_ARTIFACT],
  ['for a two-chunk artifact after the denomination fork', { postFork: true, nodeFee: NODE_FEE }, TWO_CHUNK_ARTIFACT],
  ['with the SR-2 source binding', { nodeFee: NODE_FEE, prepare: (content) => {
    Object.assign(content, { network: 'TEST-network', chainIdentity: 'TEST-chain' }); content.data[1].metadata.networkBinding = { network: 'TEST-network' };
  } }],
]) test(`the CREATE the SDK signs ${label} is kept and sent as signed`, async (t) => {
  const w = wallet(t), journal = w.open();
  t.after(() => journal.close());
  w.faults.sign.push(sign);
  const { status, txHash } = await journal.anchorEvidence(w.input(extra));
  assert.equal(status, 'submitted');
  const kept = await journal.readSignedProjection(w.input(extra));
  assert.equal(JSON.stringify(kept), w.calls.broadcast[0], 'the exact signed projection is broadcast');
  assert.equal(kept.content.amount, sign.postFork ? '0' : 0);
  assert.equal(await sdkRegeneratesSignedCreate(kept.content), true, 'the SDK regenerates its edits and bytes');
  assert.equal((await journal.reconcilePaymentEvidence(w.input(extra))).txHash, txHash);
  assert.equal(w.calls.sign, 1);
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
    assert.deepEqual(await journal.reconcilePaymentEvidence(w.input()), { status: 'applied', txHash: second }, 'the applied CREATE is live, never superseded');
    assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'applied', txHash: second }, 'and is not signed or broadcast again');
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
  // Nonce not overtaken: absence cannot supersede a CREATE that can still land.
  w.faults.broadcast.push('drop');
  await expectLive('account nonce below the kept nonce');
  assert.deepEqual(w.calls.reads, ['nonce', 'state']);
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
    const db = () => { const d = new DatabaseSync(w.path, { readonly: true }); try { return d.prepare('SELECT tx_hash, superseded_at FROM evidence_creates').all().map((row) => ({ ...row })); } finally { d.close(); } };
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
      assert.deepEqual(answer, { status: cut === 'sent' ? 'applied' : 'rebroadcast', txHash: signedByChild[0] }, `${cut}: never unsigned while it can land`);
      assert.deepEqual(await journal.anchorEvidence(w.input()), { status: 'applied', txHash: signedByChild[0] }, `${cut}: a second anchor retains the applied CREATE`);
      assert.equal(w.calls.sign, 0, `${cut}: this process signed nothing`);
    }
    assert.equal(w.chain.applied.length, 1, `${cut}: one CREATE landed`);
    assert.equal(db().filter((row) => row.superseded_at === null).length, 1, `${cut}: one live signed CREATE`);
    assert.equal(new Set(w.calls.broadcast).size, cut === 'sent' ? 0 : 1, `${cut}: applied transactions are not broadcast again`);
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
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'applied');
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

test('overlapping retries across handles reuse the winning signature and answer', async (t) => {
  const w = wallet(t), node = walletChain({ state: w.chain });
  let release, entered, signatures = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const signing = new Promise((resolve) => { entered = resolve; });
  const signCreate = async (input) => { signatures++; entered(); await gate; return node.signCreate(input); };
  const first = w.open({ signCreate }), second = w.open({ signCreate });
  t.after(() => { first.close(); second.close(); });
  const a = first.anchorEvidence(w.input());
  await signing;
  const b = first.anchorEvidence(w.input()), c = second.anchorEvidence(w.input());
  const settled = Promise.allSettled([a, b, c]);
  await new Promise(setImmediate);
  release();
  const answers = await settled;
  assert.equal(signatures, 1);
  assert.ok(answers.every((answer) => answer.status === 'fulfilled'));
  assert.equal(new Set(answers.map(answer => answer.value.txHash)).size, 1);
  assert.ok(answers.every(answer => ['submitted', 'applied'].includes(answer.value.status)));
  assert.equal(new Set(w.calls.broadcast).size, 1);
});

// CREATEs the SDK never signs, each the SDK's own signed CREATE changed by a
// hostile signer that hashes and signs its change. NODE marks those the node
// refuses as well: the SDK regenerates other edits or other hashed bytes from
// them (sdkRegeneratesSignedCreate), so keeping one would rebroadcast bytes that
// can never land. POST_FORK changes the SDK's post-fork CREATE instead.
const NODE = { node: true }, NODE_POST_FORK = { node: true, postFork: true };
const hostileCreateEdits = [
  ['a missing timestamp', (content) => { delete content.timestamp; }],
  ['an invalid timestamp', (content) => { content.timestamp = 'TEST'; }],
  ['a negative timestamp', (content) => { content.timestamp = -1; }],
  ['an amount', (content) => { content.amount = 7; }],
  ['a string amount other than zero', (content) => { content.amount = '7'; }, NODE],
  // The node fee as the SDK writes it: network and rpc fee, no additional fee
  // and no rpc address, as numbers before the fork and canonical strings after it.
  ['no node fee', (content) => { delete content.transaction_fee; }],
  ['an empty node fee', (content) => { content.transaction_fee = {}; }, NODE],
  ['a negative node fee amount', (content) => { content.transaction_fee.network_fee = -1; }],
  ['a non-decimal node fee string', (content) => { content.transaction_fee.rpc_fee = '1e9'; }, NODE],
  ['a node fee with another rpc address type', (content) => { content.transaction_fee.rpc_address = 7; }],
  ['a node fee with an rpc address', (content) => { content.transaction_fee.rpc_address = `0x${'b8'.repeat(32)}`; }],
  ['an additional fee', (content) => { content.transaction_fee.additional_fee = 1; }],
  ['a node fee member the SDK does not write', (content) => { content.transaction_fee.TEST = 0; }],
  ['a string node fee before the fork', (content) => { content.transaction_fee.network_fee = '2'; }, NODE],
  ['a number node fee after the fork', (content) => { content.transaction_fee.network_fee = 2; }, NODE_POST_FORK],
  ['a node fee string with a leading zero after the fork', (content) => { content.transaction_fee.rpc_fee = '00'; }, NODE_POST_FORK],
  // The execution edits the SDK generates: the storage fee burn, the storage
  // program, the gas burn and the nonce increment by 1, in that order.
  ['no execution edits', (content) => { delete content.gcr_edits; }, NODE],
  ['empty execution edits', (content) => { content.gcr_edits = []; }, NODE],
  ['only the storage program edit', (content) => { content.gcr_edits = [content.gcr_edits[1]]; }, NODE],
  ['only the storage program edit after the fork', (content) => { content.gcr_edits = [content.gcr_edits[1]]; }, NODE_POST_FORK],
  ['no nonce edit', (content) => { content.gcr_edits.splice(3, 1); }, NODE],
  ['no balance edits', (content) => { content.gcr_edits = content.gcr_edits.filter((edit) => edit.type !== 'balance'); }, NODE],
  ['a nonce edit that adds 2', (content) => { content.gcr_edits[3].amount = 2; }, NODE],
  ['a nonce edit that adds the string 1 after the fork', (content) => { content.gcr_edits[3].amount = '1'; }, NODE_POST_FORK],
  ['a nonce edit that removes', (content) => { content.gcr_edits[3].operation = 'remove'; }, NODE],
  ['balance edits that add', (content) => { for (const edit of content.gcr_edits) if (edit.type === 'balance') edit.operation = 'add'; }, NODE],
  ['an extra balance edit', (content) => { content.gcr_edits.push({ ...content.gcr_edits[2] }); }, NODE],
  ['another storage fee', (content) => { content.gcr_edits[0].amount = 2; }, NODE],
  ['another gas burn after the fork', (content) => { content.gcr_edits[2].amount = '2000000000'; }, NODE_POST_FORK],
  ['a number balance edit amount after the fork', (content) => { content.gcr_edits[0].amount = 1; }, NODE_POST_FORK],
  ['the execution edits in another order', (content) => { content.gcr_edits.reverse(); }, NODE],
  ['an execution edit naming a transaction', (content) => { content.gcr_edits[3].txhash = 'a7'.repeat(32); }, NODE],
  ['a storage program edit of other variables', (content) => { content.gcr_edits[1].context.data.variables.acl = { mode: 'private' }; }, NODE],
  ['an execution edit member the SDK does not write', (content) => { content.gcr_edits[3].TEST = true; }, NODE],
  ['an empty execution edit', (content) => { content.gcr_edits = [{}]; }, NODE],
  ['a rollback execution edit', (content) => { content.gcr_edits[0].isRollback = true; }, NODE],
  ['an execution edit of another type', (content) => { content.gcr_edits[0].type = 'identity'; }, NODE],
  ['a balance edit of another account', (content) => { content.gcr_edits[0].account = `0x${'b8'.repeat(32)}`; }, NODE],
  ['a storage program edit of another target', (content) => { content.gcr_edits[1].target = `stor-${'c4'.repeat(20)}`; }, NODE],
  ['no storage program edit', (content) => { content.gcr_edits.splice(1, 1); }, NODE],
  ['two storage program edits', (content) => { content.gcr_edits.push({ ...content.gcr_edits[1] }); }, NODE],
  ['a private ACL', (content) => { content.data[1].acl.mode = 'private'; }, NODE],
  ['off-chain storage', (content) => { content.data[1].storageLocation = 'offchain'; }, NODE],
  ['an unknown storage location', (content) => { content.data[1].storageLocation = 'TEST-invalid'; }, NODE],
  ['an extra execution field', (content) => { content.TEST = true; }],
  ['an extra operation field', (content) => { content.data[1].TEST = true; }, NODE],
  ['an extra metadata field', (content) => { content.data[1].metadata.TEST = true; }, NODE],
];
for (const [label, edit, { node = false, postFork = false } = {}] of hostileCreateEdits) test(`refuses ${label} before retention and a corrected signer recovers`, async (t) => {
  const w = wallet(t), journal = w.open(); t.after(() => journal.close());
  w.faults.sign.push({ edit, postFork });
  await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_sign_invalid' });
  assert.equal(await journal.readSignedProjection(w.input()), null);
  assert.equal(w.calls.broadcast.length, 0);
  if (node) assert.equal(await sdkRegeneratesSignedCreate(w.calls.signedContents[0]), false, 'the node refuses it too');
  assert.equal((await journal.anchorEvidence(w.input())).status, 'submitted');
});

for (const [label, change] of [
  ['artifact envelope', { artifact: { TEST: 'evidence', signatures: [{ TEST: 'changed envelope' }] } }],
  ['artifact kind', { artifactKind: 'TEST-other-kind' }],
  ['writer', { writer: `did:demos:agent:${'ab'.repeat(32)}` }],
]) test(`retained replay refuses another ${label} with the same receipt hash`, async (t) => {
  const w = wallet(t), journal = w.open(); t.after(() => journal.close());
  await journal.anchorEvidence(w.input());
  const broadcasts = w.calls.broadcast.length;
  await assert.rejects(journal.anchorEvidence(w.input(change)), { code: 'wallet_journal_conflict' });
  await assert.rejects(journal.reconcilePaymentEvidence(w.input(change)), { code: 'wallet_journal_conflict' });
  assert.equal(w.calls.broadcast.length, broadcasts);
  assert.equal(w.calls.sign, 1);
});

test('a replaced journal refuses sent attempts with missing or malformed transaction hashes', async (t) => {
  const w = wallet(t); let journal = w.open();
  await journal.anchorEvidence(w.input()); journal.close(); rmSync(w.path);
  journal = w.open(); t.after(() => journal.close());
  for (const txHash of [undefined, null, 123, '', 'TEST-invalid']) {
    for (const attempt of [{ answer: { status: 'submitted', txHash } }, { outcome: 'sent', answer: { txHash } }]) {
      await assert.rejects(journal.reconcilePaymentEvidence(w.input({ attempt })), { code: 'wallet_journal_unknown_attempt' });
    }
  }
  assert.equal((await journal.reconcilePaymentEvidence(w.input({ attempt: { outcome: 'failed-before-signing' } }))).status, 'unsigned');
});

test('a replaced journal refuses an ambiguous attempt that names no transaction, and an applied one without a hash', async (t) => {
  const w = wallet(t); let journal = w.open();
  await journal.anchorEvidence(w.input()); journal.close(); rmSync(w.path);
  journal = w.open(); t.after(() => journal.close());
  for (const attempt of [
    { outcome: 'threw', error: 'TEST response lost' },
    { outcome: 'threw' },
    { answer: { status: 'applied', txHash: null } },
    { answer: { status: 'applied' } },
    { outcome: 'failed-before-signing', answer: { txHash: 123 } },
  ]) await assert.rejects(journal.reconcilePaymentEvidence(w.input({ attempt })), { code: 'wallet_journal_unknown_attempt' });
  assert.equal(w.calls.sign, 1, 'nothing signed anew');
});

test('a journal that kept the CREATE answers an attempt that threw without naming a transaction', async (t) => {
  const w = wallet(t), journal = w.open(); t.after(() => journal.close());
  w.faults.broadcast.push('throw');
  await assert.rejects(journal.anchorEvidence(w.input()), /TEST node unreachable/);
  const answer = await journal.reconcilePaymentEvidence(w.input({ attempt: { outcome: 'threw', error: 'TEST node unreachable' } }));
  assert.equal(answer.status, 'rebroadcast');
  assert.equal(w.calls.sign, 1);
});

test('a multibyte signed transaction beyond the wire byte limit is not retained or broadcast', async (t) => {
  const w = wallet(t), node = walletChain({ state: w.chain });
  const journal = w.open({ async signCreate(asked) {
    const answer = await node.signCreate(asked);
    const projection = JSON.parse(answer.signedTransaction);
    projection.content.data[1].data.TEST = '🙂'.repeat(300_000);
    answer.signedTransaction = JSON.stringify(projection);
    Object.defineProperty(answer, 'txHash', { get() { throw new Error('TEST oversized reply must be refused before hash inspection'); } });
    return answer;
  } });
  t.after(() => journal.close());
  const input = w.input();
  await assert.rejects(journal.anchorEvidence(input), { code: 'wallet_sign_invalid' });
  assert.equal(await journal.readSignedProjection(input), null);
  assert.equal(w.calls.broadcast.length, 0);
});

test('opening another initialized journal handle does not wait for an active signer', async (t) => {
  const w = wallet(t), node = walletChain({ state: w.chain });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const signing = new Promise(resolve => { entered = resolve; });
  const first = w.open({ signCreate: async input => { entered(); await gate; return node.signCreate(input); } });
  t.after(() => first.close());
  const anchor = first.anchorEvidence(w.input());
  await signing;
  try {
    const second = w.open();
    try { assert.equal(second.journalId, first.journalId); } finally { second.close(); }
  } finally {
    release();
    await anchor;
  }
});

test('a superseded named attempt cannot broadcast or answer for its live successor after reopen', async (t) => {
  const w = wallet(t);
  let journal = w.open();
  w.faults.broadcast.push('drop');
  const first = await journal.anchorEvidence(w.input());
  w.other();
  assert.equal((await journal.reconcilePaymentEvidence(w.input())).status, 'unsigned');
  const second = await journal.anchorEvidence(w.input());
  journal.close(); journal = w.open(); t.after(() => journal.close());
  const broadcasts = w.calls.broadcast.length;
  await assert.rejects(journal.reconcilePaymentEvidence(w.input({ attempt: { outcome: 'sent', answer: first } })), { code: 'wallet_journal_stale_attempt' });
  assert.equal(w.calls.broadcast.length, broadcasts);
  assert.equal((await journal.readSignedProjection(w.input())).hash, second.txHash);
  assert.equal((await journal.reconcilePaymentEvidence(w.input({ attempt: { answer: second } }))).txHash, second.txHash);
  assert.equal(w.calls.sign, 2);
});


for (const method of ['anchorEvidence', 'reconcilePaymentEvidence']) for (const nonce of ['current', 'stale', 'unavailable']) test(`an applied CREATE is retained without duplicate broadcasts on ${method} with ${nonce} nonce`, async (t) => {
  const w = wallet(t);
  const broadcast = async ({ signedTransaction, txHash }) => {
    assert.equal(w.chain.applied.includes(txHash), false, 'the node rejects duplicate applied hashes');
    w.calls.broadcast.push(signedTransaction);
    // A qualified broadcaster lands this transaction once.
    w.chain.applied.push(txHash); w.chain.accountNonce = w.chain.signed[txHash];
  };
  const open = () => w.open({ broadcast, ...(nonce === 'current' ? {} : { readAccountNonce: async () => {
    if (nonce === 'unavailable') throw new Error('TEST nonce unavailable');
    return 0;
  } }) });
  let journal = open();
  const first = await journal.anchorEvidence(w.input());
  assert.equal(first.status, 'submitted');
  journal.close(); journal = open();
  t.after(() => journal.close());
  assert.deepEqual(await journal[method](w.input()), { status: 'applied', txHash: first.txHash });
  assert.equal(w.calls.sign, 1);
  assert.equal(w.calls.broadcast.length, 1);
  assert.equal((await journal.readSignedProjection(w.input())).hash, first.txHash);
});

test('initialization killed before journal ID insertion rolls back the schema and reopens', (t) => {
  const w = wallet(t, { file: true });
  const child = spawnSync(process.execPath, [CRASH_CHILD, w.path, w.chainFile, 'initialize'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const db = new DatabaseSync(w.path);
  try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'evidence_creates'").get(), undefined); }
  finally { db.close(); }
  const journal = w.open();
  const id = journal.journalId;
  journal.close();
  const reopened = w.open();
  assert.equal(reopened.journalId, id);
  reopened.close();
});

test('an empty schema interrupted before its journal ID can finish initialization', (t) => {
  const w = wallet(t), initialized = w.open();
  initialized.close();
  const db = new DatabaseSync(w.path);
  db.prepare("DELETE FROM journal_meta WHERE key = 'journal-id'").run();
  db.close();
  const journal = w.open();
  assert.match(journal.journalId, /^[0-9a-f]{32}$/);
  journal.close();
});

test('simultaneous first opens serialize initialization and retain one journal ID', async (t) => {
  const w = wallet(t), barrier = new SharedArrayBuffer(4);
  const starts = [], answers = [], exits = [];
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(new URL('./helpers/payment-evidence-wallet-initialize.mjs', import.meta.url), { workerData: { path: w.path, barrier } });
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
  assert.equal(results[0].error, undefined); assert.equal(results[1].error, undefined);
  assert.match(results[0].journalId, /^[0-9a-f]{32}$/);
  assert.equal(results[0].journalId, results[1].journalId);
  assert.deepEqual(await Promise.all(exits), [0, 0]);
});

test('a first open that cannot get the writer lock in time is refused as wallet_journal_busy', (t) => {
  const w = wallet(t), holder = new DatabaseSync(w.path);
  chmodSync(w.path, 0o600);
  holder.exec('BEGIN IMMEDIATE');
  t.after(() => holder.close());
  assert.throws(() => w.open(), { code: 'wallet_journal_busy' });
});

// Every wallet call has a deadline: a signer that never settles must not hold
// the journal's writer lock, and a broadcast that never settles leaves the kept
// CREATE live for reconcile.
test('a signCreate that never settles is refused at the deadline: nothing is kept and the journal answers again', async (t) => {
  const w = wallet(t), node = walletChain({ state: w.chain });
  let stopped = false;
  const hung = w.open({ signCreate: (_input, { signal }) => { signal.addEventListener('abort', () => { stopped = true; }); return new Promise(() => {}); } });
  const other = w.open();
  t.after(() => { hung.close(); other.close(); });
  await assert.rejects(hung.anchorEvidence(w.input()), { code: 'wallet_sign_timeout' });
  assert.ok(stopped, 'the signer is told to stop');
  assert.equal((await hung.reconcilePaymentEvidence(w.input())).status, 'unsigned', 'the same handle is not wedged');
  assert.equal((await other.reconcilePaymentEvidence(w.input())).status, 'unsigned', 'another handle is not locked out');
  assert.equal(await hung.readSignedProjection(w.input()), null, 'nothing was kept');
  assert.equal(node.chain.signed && Object.keys(w.chain.signed).length, 0, 'nothing was signed');
  assert.equal((await other.anchorEvidence(w.input())).status, 'submitted');
});

test('a broadcast that never settles is a timeout that keeps the signed CREATE; reconcile answers pending for it', async (t) => {
  const w = wallet(t);
  let stopped = false;
  const journal = w.open({ broadcast: (_sent, { signal }) => { signal.addEventListener('abort', () => { stopped = true; }); return new Promise(() => {}); } });
  t.after(() => journal.close());
  await assert.rejects(journal.anchorEvidence(w.input()), { code: 'wallet_broadcast_timeout' });
  assert.ok(stopped, 'the broadcast is told to stop');
  const kept = await journal.readSignedProjection(w.input());
  assert.ok(kept, 'the signed CREATE is kept');
  const answer = await journal.reconcilePaymentEvidence(w.input());
  assert.deepEqual([answer.status, answer.txHash], ['pending', kept.hash]);
  assert.equal(w.calls.sign, 1, 'never signed again');
});

test('a journal in a directory others can write, or reached through a symbolic link, is refused before a file is made', (t) => {
  const w = wallet(t), open = (path) => createPaymentEvidenceWalletJournal({ path, readTimeoutMs: 200, signCreate() {}, broadcast() {}, readAccountNonce() {}, readTransactionState() {} });
  const shared = join(w.dir, 'shared'), linked = join(w.dir, 'linked');
  mkdirSync(shared); chmodSync(shared, 0o777);
  symlinkSync(w.dir, linked);
  assert.throws(() => open(join(shared, 'journal.sqlite')), /not writable by others/);
  chmodSync(shared, 0o770);
  assert.throws(() => open(join(shared, 'journal.sqlite')), /not writable by others/, 'a writable group is not private either');
  assert.throws(() => open(join(linked, 'journal.sqlite')), /without symbolic links/);
  assert.equal(existsSync(join(shared, 'journal.sqlite')), false, 'no file was made');
  chmodSync(shared, 0o700);
  open(join(shared, 'journal.sqlite')).close();
});

for(const failedSigner of [false,true])test(`owning journal recovers an unknown empty attempt after restart, signer failed=${failedSigner}`,async t=>{
 const w=wallet(t);let journal=w.open(),id=journal.journalId;
 if(failedSigner){w.faults.sign.push('throw');await assert.rejects(journal.anchorEvidence(w.input()),/before signing/);}
 const attempt={outcome:'unknown'};
 await assert.rejects(journal.reconcilePaymentEvidence({...w.input(),attempt}),{code:'wallet_journal_unknown_attempt'});
 journal.close();journal=w.open();t.after(()=>journal.close());
 const result=await journal.ensureEvidence({...w.input(),expectedJournalId:id,attempt});
 assert.equal(result.status,'submitted');assert.equal(w.calls.signed.length,1);assert.equal(w.chain.applied.length,1);
 assert.equal((await journal.ensureEvidence({...w.input(),expectedJournalId:id,attempt})).status,'applied');
 assert.equal(w.calls.signed.length,1);
});

for(const expected of [undefined,'TEST-other-owner'])test(`owner-checked evidence refuses a missing or changed journal owner ${expected}`,async t=>{
 const w=wallet(t),journal=w.open();t.after(()=>journal.close());
 await assert.rejects(journal.ensureEvidence({...w.input(),expectedJournalId:expected}),{code:'wallet_journal_changed'});
 assert.equal(w.calls.sign,0);assert.equal(w.calls.broadcast.length,0);
});

test('owner-checked preparation rechecks the job authorization before signing and broadcasting',async t=>{
 const w=wallet(t),journal=w.open();t.after(()=>journal.close());
 await assert.rejects(journal.ensureEvidence({...w.input(),expectedJournalId:journal.journalId,authorize:async()=>false}),{code:'wallet_not_authorized'});
 assert.equal(w.calls.sign,0);
 let checks=0;
 await assert.rejects(journal.ensureEvidence({...w.input(),expectedJournalId:journal.journalId,authorize:()=>++checks===1}),{code:'wallet_not_authorized'});
 const kept=await journal.readSignedProjection(w.input());assert.ok(kept);assert.equal(w.calls.broadcast.length,0);
 await journal.ensureEvidence({...w.input(),expectedJournalId:journal.journalId,authorize:()=>true});
 assert.equal(w.calls.signed.length,1);assert.equal(w.calls.broadcast.length,1);assert.equal(w.chain.applied.length,1);
});

test('an accepted legacy name survives a lost successor broadcast answer',async t=>{
 const w=wallet(t);let journal=w.open();
 w.faults.broadcast.push('drop');const first=await journal.anchorEvidence(w.input());w.other();w.other();
 const attempt={outcome:'sent',answer:first},input={...w.input(),expectedJournalId:journal.journalId,attempt};
 w.faults.broadcast.push('throw');await assert.rejects(journal.ensureEvidence(input),/unreachable/);
 const kept=await journal.readSignedProjection(w.input());assert.notEqual(kept.hash,first.txHash);journal.close();
 journal=w.open();t.after(()=>journal.close());
 const result=await journal.ensureEvidence(input);assert.equal(result.txHash,kept.hash);assert.equal(w.calls.signed.length,2);assert.equal(w.chain.applied.length,1);
});

for(const attempt of [{outcome:'sent'},{outcome:'unknown',answer:{txHash:null}},{outcome:'unknown',answer:{txHash:'TEST-malformed'}},{outcome:'sent',answer:{txHash:'a'.repeat(64)}}])test(`owner recovery rejects an unbound legacy answer ${JSON.stringify(attempt)}`,async t=>{
 const w=wallet(t),journal=w.open();t.after(()=>journal.close());
 await journal.ensureEvidence({...w.input(),expectedJournalId:journal.journalId});
 await assert.rejects(journal.ensureEvidence({...w.input(),expectedJournalId:journal.journalId,attempt}),{code:'wallet_journal_unknown_attempt'});
 assert.equal(w.calls.signed.length,1);assert.equal(w.calls.broadcast.length,1);
});

for(const cut of ['checkpoint','signing','committed','broadcast','answer'])test(`owner checkpoint survives process interruption at ${cut}`,async t=>{
 const w=wallet(t,{file:true}),checkpoint=join(w.dir,'work.json'),initialized=w.open(),owner=initialized.journalId;initialized.close();
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/payment-evidence-owner-crash.mjs',import.meta.url)),w.path,w.chainFile,checkpoint,cut],{encoding:'utf8',timeout:60000});
 assert.equal(child.signal,'SIGKILL',child.stderr);const work=JSON.parse(readFileSync(checkpoint,'utf8'));assert.equal(work.expectedJournalId,owner);w.reload();
 const journal=w.open();t.after(()=>journal.close());const answer=await journal.ensureEvidence(work);
 assert.ok(['submitted','applied'].includes(answer.status));assert.equal(w.chain.applied.length,1);
 const projection=await journal.readSignedProjection(work);assert.equal(projection.hash,answer.txHash);assert.deepEqual(work.artifact,w.input().artifact);
 assert.equal((await journal.ensureEvidence(work)).status,'applied');assert.equal(w.chain.applied.length,1);
 assert.equal(new Set(w.calls.broadcast).size,w.calls.broadcast.length?1:0);
});


test('concurrent owner-checked handles reuse the CREATE prepared under the signing lock',async t=>{
 const w=wallet(t),node=walletChain({state:w.chain});let enter,release,signs=0;
 const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 const first=w.open({signCreate:async input=>{signs++;enter();await gate;return node.signCreate(input);}}),second=w.open();t.after(()=>{first.close();second.close();});
 const input={...w.input(),expectedJournalId:first.journalId,attempt:{outcome:'unknown'}},one=first.ensureEvidence(input);await entered;const two=second.ensureEvidence(input);release();
 const [a,b]=await Promise.all([one,two]);assert.equal(a.txHash,b.txHash);assert.equal(signs+w.calls.sign,1);assert.equal(w.chain.applied.length,1);assert.equal(new Set(w.calls.broadcast).size,1);
});
