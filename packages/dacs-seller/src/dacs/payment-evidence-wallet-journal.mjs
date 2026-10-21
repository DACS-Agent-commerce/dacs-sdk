// The seller wallet's journal for the payment-evidence anchor (DACS-4 PC-7(b),
// write-once): the operator's wallet primitives composed so that what the
// agent relies on from `anchorEvidence` and `reconcilePaymentEvidence` holds
// by construction. The exact signed CREATE is kept durably, with its nonce,
// before it is broadcast, and an address has at most one live signed CREATE.
// Every later question about it is answered from that record checked against
// the chain: the kept CREATE is broadcast again as the same bytes
// (`rebroadcast`) while it can still be included, and it is superseded (kept,
// never sent again) only once it provably cannot: the account nonce has reached
// its nonce (the node refuses a transaction whose nonce is not above the
// account's), read first, and then it is neither applied nor pending. Only an
// address with no live signed CREATE is `unsigned`, and only then is it signed
// anew. A read that fails, times out or answers anything else keeps the same
// bytes alive.
//
// createPaymentEvidenceWalletJournal({ path, signCreate, broadcast,
//   readAccountNonce, readTransactionState, now, readTimeoutMs }):
//  - path: absolute path of the journal's SQLite file, in a private directory
//    owned by this user (created 0600 when missing);
//  - signCreate(input) -> { signedTransaction, txHash, nonce }: signs, and must
//    not send, the storage CREATE for input ({ logicalAddress, artifact, writer,
//    artifactKind, jobId, receiptContentHash }); nonce is the transaction's
//    account nonce (a positive safe integer);
//  - broadcast({ signedTransaction, txHash }): sends exactly these bytes. The
//    chain refuses a transaction hash it already has, so a repeat lands nothing new;
//  - readAccountNonce() -> the wallet account's current nonce on the chain (the
//    nonce of its last applied transaction), a non-negative safe integer;
//  - readTransactionState({ txHash }) -> 'applied' (the chain applied it),
//    'pending' (in the mempool, or included and not yet applied) or 'absent'
//    (not applied and not pending).
//  Each read is given readTimeoutMs (default 10 s) to answer.
// Returns { anchorEvidence, reconcilePaymentEvidence, close }: the first goes
// into createNativePaymentEvidenceConsumer, the second is the host option.
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Bounds on what signCreate answers before it is kept.
const MAX_SIGNED_TRANSACTION = 1024 * 1024;
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
const TX_STATES = new Set(['applied', 'pending', 'absent']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error) => String(error?.message ?? error).slice(0, 200);
const nonceOf = (value, least) => (Number.isSafeInteger(value) && value >= least ? value : null);

export function createPaymentEvidenceWalletJournal({ path, signCreate, broadcast, readAccountNonce, readTransactionState, now = () => Date.now(), readTimeoutMs = 10_000 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('the wallet journal path must be absolute');
  if (typeof signCreate !== 'function' || typeof broadcast !== 'function' || typeof now !== 'function') throw new TypeError('the wallet journal needs signCreate, broadcast and now functions');
  if (typeof readAccountNonce !== 'function' || typeof readTransactionState !== 'function') throw new TypeError('the wallet journal needs readAccountNonce and readTransactionState, to tell a kept CREATE that can no longer be included');
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) throw new TypeError('the wallet journal readTimeoutMs must be a positive integer');
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) throw new TypeError('the wallet journal must be a private (0600) file owned by this user');
  const db = new DatabaseSync(path);
  if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'signed_creates'").get()) {
    db.close();
    throw new TypeError('the wallet journal file has the earlier format, which kept no nonce; it is not read');
  }
  // One row per signed CREATE; superseded rows are kept, and an address has at most one live row.
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS evidence_creates (logical_address TEXT NOT NULL, receipt_content_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, signed_transaction TEXT NOT NULL, signed_at INTEGER NOT NULL,
      superseded_at INTEGER, PRIMARY KEY (logical_address, nonce));
    CREATE UNIQUE INDEX IF NOT EXISTS evidence_creates_live ON evidence_creates (logical_address) WHERE superseded_at IS NULL;`);
  const rows = (logicalAddress) => db.prepare('SELECT receipt_content_hash, tx_hash, nonce, signed_transaction, superseded_at FROM evidence_creates WHERE logical_address = ? ORDER BY nonce').all(logicalAddress);
  // One evidence per address: a question about other bytes at a kept address is refused.
  const keptFor = (input) => {
    if (!object(input) || typeof input.logicalAddress !== 'string' || typeof input.receiptContentHash !== 'string') throw new TypeError('the wallet journal is asked about no payment-evidence address');
    const kept = rows(input.logicalAddress);
    if (kept.some((row) => row.receipt_content_hash !== input.receiptContentHash)) throw Object.assign(new Error('the wallet journal holds another evidence at this address'), { code: 'wallet_journal_conflict' });
    const live = kept.find((row) => row.superseded_at === null);
    return { live: live ? { signedTransaction: live.signed_transaction, txHash: live.tx_hash, nonce: Number(live.nonce) } : null, highestNonce: kept.length ? Number(kept.at(-1).nonce) : 0 };
  };
  // A wallet read with a deadline: a throw, a timeout or an answer of another shape is null.
  const read = async (call, accept) => {
    let timer;
    try {
      const answer = await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), readTimeoutMs); })]);
      const value = accept(answer);
      return value === null ? { cause: 'answered no valid value' } : { value };
    } catch (error) { return { cause: reason(error) }; }
    finally { clearTimeout(timer); }
  };
  // Whether a live kept CREATE can still be included. The account nonce is read
  // first: once it has reached the kept nonce, the kept transaction can never be
  // included later, so if it is then neither applied nor pending it never will be.
  async function fate(signed) {
    const account = await read(() => readAccountNonce(), (value) => nonceOf(value, 0));
    if (!('value' in account)) return { alive: true, reason: `the account nonce could not be read: ${account.cause}` };
    if (account.value < signed.nonce) return { alive: true };
    const state = await read(() => readTransactionState({ txHash: signed.txHash }), (value) => (TX_STATES.has(value) ? value : null));
    if (!('value' in state)) return { alive: true, reason: `the kept CREATE's state could not be read: ${state.cause}` };
    if (state.value !== 'absent') return { alive: true };
    return { alive: false, reason: `the kept signed CREATE ${signed.txHash} (nonce ${signed.nonce}) is neither applied nor pending and the account nonce is ${account.value}; it can no longer be included` };
  }
  // The live kept CREATE after its fate is read; one that can no longer be
  // included is superseded (compare-and-swap on its live row) and none is live.
  async function liveFor(input) {
    const { live, highestNonce } = keptFor(input);
    if (!live) return { live: null, highestNonce };
    const checked = await fate(live);
    if (checked.alive) return { live, highestNonce, reason: checked.reason };
    const swap = db.prepare('UPDATE evidence_creates SET superseded_at = ? WHERE logical_address = ? AND tx_hash = ? AND superseded_at IS NULL').run(now(), input.logicalAddress, live.txHash);
    if (swap.changes !== 1) throw Object.assign(new Error('the wallet journal row changed while it was checked'), { code: 'wallet_journal_conflict' });
    return { live: null, highestNonce, superseded: { txHash: live.txHash, reason: checked.reason } };
  }

  async function anchorEvidence(input) {
    let { live: signed, highestNonce } = await liveFor(input);
    if (!signed) {
      const answer = await signCreate(structuredClone(input));
      if (!object(answer) || typeof answer.signedTransaction !== 'string' || answer.signedTransaction.length === 0 || answer.signedTransaction.length > MAX_SIGNED_TRANSACTION
          || typeof answer.txHash !== 'string' || !TX_HASH.test(answer.txHash) || nonceOf(answer.nonce, 1) === null) throw Object.assign(new Error('signCreate answered no signed transaction, hash and nonce'), { code: 'wallet_sign_invalid' });
      // A new signature must be able to land where the kept ones cannot.
      if (answer.nonce <= highestNonce) throw Object.assign(new Error(`signCreate answered nonce ${answer.nonce}, not above the kept nonce ${highestNonce}`), { code: 'wallet_sign_invalid' });
      signed = { signedTransaction: answer.signedTransaction, txHash: answer.txHash, nonce: answer.nonce };
      // Kept before it can be sent; a second live row for the address is refused, never replaced.
      db.prepare('INSERT INTO evidence_creates (logical_address, receipt_content_hash, tx_hash, nonce, signed_transaction, signed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.logicalAddress, input.receiptContentHash, signed.txHash, signed.nonce, signed.signedTransaction, now());
    }
    await broadcast({ signedTransaction: signed.signedTransaction, txHash: signed.txHash });
    return { status: 'submitted', txHash: signed.txHash };
  }

  async function reconcilePaymentEvidence(input) {
    const { live: signed, superseded, reason: unread } = await liveFor(input);
    if (superseded) return { status: 'unsigned', txHash: superseded.txHash, reason: superseded.reason };
    if (!signed) return { status: 'unsigned', reason: 'the wallet journal keeps no live signed CREATE for this address' };
    try { await broadcast({ signedTransaction: signed.signedTransaction, txHash: signed.txHash }); }
    catch (error) { return { status: 'pending', txHash: signed.txHash, reason: `the same signed CREATE was not broadcast again: ${reason(error)}` }; }
    return { status: 'rebroadcast', txHash: signed.txHash, ...(unread ? { reason: unread } : {}) };
  }

  return Object.freeze({ anchorEvidence, reconcilePaymentEvidence, close: () => db.close() });
}
