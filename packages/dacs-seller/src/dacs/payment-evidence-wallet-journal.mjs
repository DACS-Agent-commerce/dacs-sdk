// The seller wallet's journal for the payment-evidence anchor (DACS-4 PC-7(b),
// write-once): the operator's wallet primitives composed so that what the
// agent relies on from `anchorEvidence` and `reconcilePaymentEvidence` holds
// by construction. The exact signed CREATE is kept durably before it is
// broadcast, a logical address is signed at most once, and every later
// question about it is answered from that record: an address it never kept a
// signed CREATE for is `unsigned`; one it kept is broadcast again as the same
// bytes (`rebroadcast`), never signed anew.
//
// createPaymentEvidenceWalletJournal({ path, signCreate, broadcast, now }):
//  - path: absolute path of the journal's SQLite file, in a private directory
//    owned by this user (created 0600 when missing);
//  - signCreate(input) -> { signedTransaction, txHash }: signs, and must not
//    send, the storage CREATE for input ({ logicalAddress, artifact, writer,
//    artifactKind, jobId, receiptContentHash });
//  - broadcast({ signedTransaction, txHash }): sends exactly these bytes. The
//    chain refuses a transaction hash it already has, so a repeat lands nothing new.
// Returns { anchorEvidence, reconcilePaymentEvidence, close }: the first goes
// into createNativePaymentEvidenceConsumer, the second is the host option.
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Bounds on what signCreate answers before it is kept.
const MAX_SIGNED_TRANSACTION = 1024 * 1024;
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error) => String(error?.message ?? error).slice(0, 200);

export function createPaymentEvidenceWalletJournal({ path, signCreate, broadcast, now = () => Date.now() } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('the wallet journal path must be absolute');
  if (typeof signCreate !== 'function' || typeof broadcast !== 'function' || typeof now !== 'function') throw new TypeError('the wallet journal needs signCreate, broadcast and now functions');
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) throw new TypeError('the wallet journal must be a private (0600) file owned by this user');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS signed_creates (logical_address TEXT PRIMARY KEY, receipt_content_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL, signed_transaction TEXT NOT NULL, signed_at INTEGER NOT NULL);`);
  const kept = (logicalAddress) => db.prepare('SELECT receipt_content_hash, tx_hash, signed_transaction FROM signed_creates WHERE logical_address = ?').get(logicalAddress);
  // One evidence per address: a question about other bytes at a kept address is refused.
  const keptFor = (input) => {
    if (!object(input) || typeof input.logicalAddress !== 'string' || typeof input.receiptContentHash !== 'string') throw new TypeError('the wallet journal is asked about no payment-evidence address');
    const row = kept(input.logicalAddress);
    if (row && row.receipt_content_hash !== input.receiptContentHash) throw Object.assign(new Error('the wallet journal holds another evidence at this address'), { code: 'wallet_journal_conflict' });
    return row ? { signedTransaction: row.signed_transaction, txHash: row.tx_hash } : null;
  };

  async function anchorEvidence(input) {
    let signed = keptFor(input);
    if (!signed) {
      const answer = await signCreate(structuredClone(input));
      if (!object(answer) || typeof answer.signedTransaction !== 'string' || answer.signedTransaction.length === 0 || answer.signedTransaction.length > MAX_SIGNED_TRANSACTION
          || typeof answer.txHash !== 'string' || !TX_HASH.test(answer.txHash)) throw Object.assign(new Error('signCreate answered no signed transaction and hash'), { code: 'wallet_sign_invalid' });
      signed = { signedTransaction: answer.signedTransaction, txHash: answer.txHash };
      // Kept before it can be sent; a second row for the address is refused, never replaced.
      db.prepare('INSERT INTO signed_creates (logical_address, receipt_content_hash, tx_hash, signed_transaction, signed_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.logicalAddress, input.receiptContentHash, signed.txHash, signed.signedTransaction, now());
    }
    await broadcast(structuredClone(signed));
    return { status: 'submitted', txHash: signed.txHash };
  }

  async function reconcilePaymentEvidence(input) {
    const signed = keptFor(input);
    if (!signed) return { status: 'unsigned', reason: 'the wallet journal kept no signed CREATE for this address' };
    try { await broadcast(structuredClone(signed)); }
    catch (error) { return { status: 'pending', txHash: signed.txHash, reason: `the same signed CREATE was not broadcast again: ${reason(error)}` }; }
    return { status: 'rebroadcast', txHash: signed.txHash };
  }

  return Object.freeze({ anchorEvidence, reconcilePaymentEvidence, close: () => db.close() });
}
