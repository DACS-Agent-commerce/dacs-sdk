// The seller wallet's journal for the payment-evidence anchor (DACS-4 PC-7(b),
// write-once): the operator's wallet primitives composed so that what the
// agent relies on from `anchorEvidence` and `reconcilePaymentEvidence` holds
// by construction. The exact signed CREATE is kept durably, with its nonce,
// before it is broadcast, and an address has at most one live signed CREATE.
// Every later question about it is answered from that record checked against
// the chain: the kept CREATE is broadcast again as the same bytes
// (`rebroadcast`) while it can still be executed, and it is superseded (kept,
// never sent again) only once it provably cannot: the account nonce has reached
// its nonce (the node never executes a transaction whose nonce is not above
// the account's: it refuses it, or includes it as failed), read first, and
// then a complete transaction index proves non-execution through the same
// block height. An ordinary unknown/not-found is not proof. Only an
// address with no live signed CREATE is `unsigned`, and only then is it signed
// anew. A read that fails, times out or answers anything else keeps the same
// bytes alive. An included-but-failed CREATE is `absent` (not executed),
// never `applied`; only successful execution is `applied`.
//
// createPaymentEvidenceWalletJournal({ path, signCreate, broadcast,
//   readAccountNonce, readTransactionState, now, readTimeoutMs }):
//  - path: absolute path of the journal's SQLite file, in a private directory
//    owned by this user (created 0600 when missing);
//  - signCreate(input) -> { signedTransaction, txHash, nonce }: signs, and must
//    not send, the storage CREATE for input ({ logicalAddress, artifact, writer,
//    artifactKind, jobId, receiptContentHash }); nonce is the transaction's
//    account nonce (a positive safe integer). signedTransaction is the JSON of
//    exactly the public signed projection { hash, content, signature: { type,
//    data } } the SR-2 readback authenticates (of the SDK's signed transaction,
//    only those three members: no `status`, `blockNumber` or
//    `ed25519_signature`). It is checked before it is kept: hash is txHash and
//    the SHA-256 of JSON.stringify(content), its nonce is nonce, it is this
//    CREATE_STORAGE_PROGRAM of exactly input.artifact (salt '', encoding
//    'json'; metadata logicalAddress, artifactKind, contentHash =
//    receiptContentHash and envelopeHash = SHA-256 of the canonical artifact)
//    at input.logicalAddress, with `to` and the operation's storageAddress the
//    address the writer, the program name and the nonce derive, from the
//    writer's address (`from` and `from_ed25519_address`), with the writer's
//    Ed25519 signature over the hash as 0x and lower-case hex. Anything else is
//    refused (wallet_sign_invalid), and nothing is kept or sent;
//  - broadcast({ signedTransaction, txHash }): sends exactly these bytes. The
//    chain refuses a transaction hash it already has, so a repeat lands nothing new;
//  - readAccountNonce() -> a non-negative safe integer, or an authenticated
//    { nonce, blockHeight } snapshot from the qualified wallet reader;
//  - readTransactionState({ txHash }) -> 'applied', 'pending', or 'absent'.
//    An ordinary absent/unknown answer is indeterminate and cannot supersede.
//    To prove non-execution, a qualified reader must return
//    { state: 'absent', checkedThroughBlock } from a complete authenticated
//    transaction index (including failed transactions) on the same chain.
//    Its coverage must reach the nonce snapshot's blockHeight. A bare nonce
//    or an unfenced absence keeps the original signed CREATE alive.
//  Each read is given readTimeoutMs (default 10 s) to answer.
// Returns { anchorEvidence, reconcilePaymentEvidence, readSignedProjection,
// journalId, close }: the first goes into createNativePaymentEvidenceConsumer,
// the second is the host option. createSellerAgent (and so startSellerHost)
// takes the two only from one journal (isPaymentEvidenceWalletJournalPair):
// their answers are the only authority for a second signature of the same
// evidence. readSignedProjection({ logicalAddress }) answers the live kept
// CREATE's public signed projection (or null), read only; the agent reads the
// evidence back with it, so the consumer needs no reader of its own.
// journalId names the journal's file: it is made when the file is, so a lost
// or replaced file is another journal, which the agent never asks about an
// anchor the earlier one kept. reconcilePaymentEvidence refuses
// (wallet_journal_unknown_attempt) an attempt whose answer names a txHash this
// journal never kept.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';
import { deriveStorageAddress } from './wallet-transactions.mjs';

// Bounds on what signCreate answers before it is kept.
const MAX_SIGNED_TRANSACTION = 1024 * 1024;
const TX_HASH = /^[0-9a-f]{64}$/;
// demosdk 4.0.16 (demosclass.js sign): Ed25519 is 0x and lower-case hex.
const SIGNATURE = /^0x[0-9a-f]{128}$/;
const TX_STATES = new Set(['applied', 'pending', 'absent']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error) => String(error?.message ?? error).slice(0, 200);
const nonceOf = (value, least) => (Number.isSafeInteger(value) && value >= least ? value : null);
// Each journal's own anchorEvidence and reconcilePaymentEvidence, mapped to it.
const journals = new WeakMap();
// True only for the two functions of one createPaymentEvidenceWalletJournal.
export function isPaymentEvidenceWalletJournalPair(anchorEvidence, reconcilePaymentEvidence) {
  const journal = typeof anchorEvidence === 'function' ? journals.get(anchorEvidence) : undefined;
  return journal !== undefined && journal.anchorEvidence === anchorEvidence && journal.reconcilePaymentEvidence === reconcilePaymentEvidence;
}
// The journal whose own anchorEvidence this is, or null.
export function paymentEvidenceWalletJournalOf(anchorEvidence) {
  const journal = typeof anchorEvidence === 'function' ? journals.get(anchorEvidence) : undefined;
  return journal?.anchorEvidence === anchorEvidence ? journal : null;
}

// Why signCreate's answer is not the signed CREATE it names, or null. The fate
// of a kept CREATE is read by its hash and nonce, so both must be the bytes'.
// The bytes must also be what the node executes and the SR-2 readback
// (demos-sr2-adapter.mjs authenticate) reads back as this evidence: kept
// otherwise, they could never land, and while their nonce is not overtaken
// they would never be superseded.
function signedCreateProblem(answer, input) {
  let signed;
  try { signed = JSON.parse(answer.signedTransaction); } catch { return 'is not JSON'; }
  const content = signed?.content, op = content?.data?.[1];
  if (!object(signed) || !object(content) || !Array.isArray(content.data) || !object(op) || !object(op.metadata)) return 'is not a signed Demos transaction { hash, content, signature }';
  // Only members the signature covers: node 61b8e75 refuses a truthy top-level `status`.
  if (Object.keys(signed).sort().join() !== 'content,hash,signature' || !object(signed.signature)
      || Object.keys(signed.signature).sort().join() !== 'data,type') return 'is not exactly the signed projection { hash, content, signature: { type, data } }';
  if (signed.hash !== answer.txHash || sha256Hex(JSON.stringify(content)) !== answer.txHash) return 'does not hash to its txHash';
  if (content.nonce !== answer.nonce) return 'carries another nonce';
  let from;
  try { from = addressForClaim(input.writer); } catch { return 'names no writer address'; }
  const programName = logicalToStorageProgramName(input.logicalAddress), metadata = op.metadata;
  if (content.type !== 'storageProgram' || content.data.length !== 2 || content.data[0] !== 'storageProgram' || op.operation !== 'CREATE_STORAGE_PROGRAM'
      || op.programName !== programName || op.salt !== '' || op.encoding !== 'json' || canonicalize(op.data) !== canonicalize(input.artifact)
      || metadata.logicalAddress !== input.logicalAddress || typeof input.artifactKind !== 'string' || metadata.artifactKind !== input.artifactKind
      || metadata.contentHash !== input.receiptContentHash || metadata.envelopeHash !== sha256Hex(canonicalize(input.artifact))) return 'is not this evidence\'s storage CREATE';
  if (content.from !== from || content.from_ed25519_address !== from || signed.signature.type !== 'ed25519' || typeof signed.signature.data !== 'string'
      || !SIGNATURE.test(signed.signature.data) || !verifyDemosSignature({ address: from, message: answer.txHash, signature: signed.signature.data })) return 'is not signed by the writer';
  const storageAddress = deriveStorageAddress(from, programName, answer.nonce, '');
  if (content.to !== storageAddress || op.storageAddress !== storageAddress) return `is not at the storage address its writer, name and nonce derive (${storageAddress})`;
  return null;
}

export function createPaymentEvidenceWalletJournal({ path, signCreate, broadcast, readAccountNonce, readTransactionState, now = () => Date.now(), readTimeoutMs = 10_000 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('the wallet journal path must be absolute');
  if (typeof signCreate !== 'function' || typeof broadcast !== 'function' || typeof now !== 'function') throw new TypeError('the wallet journal needs signCreate, broadcast and now functions');
  if (typeof readAccountNonce !== 'function' || typeof readTransactionState !== 'function') throw new TypeError('the wallet journal needs readAccountNonce and readTransactionState, to tell a kept CREATE that can no longer be executed');
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
    CREATE UNIQUE INDEX IF NOT EXISTS evidence_creates_live ON evidence_creates (logical_address) WHERE superseded_at IS NULL;
    CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO journal_meta VALUES ('journal-id', ?)").run(randomBytes(16).toString('hex'));
  const journalId = db.prepare("SELECT value FROM journal_meta WHERE key = 'journal-id'").get().value;
  const rows =(logicalAddress) => db.prepare('SELECT receipt_content_hash, tx_hash, nonce, signed_transaction, superseded_at FROM evidence_creates WHERE logical_address = ? ORDER BY nonce').all(logicalAddress);
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
  // Read the nonce snapshot before the transaction index. The latter must
  // have indexed at least that snapshot, closing the nonce-before-tx-row race.
  async function fate(signed) {
    const account = await read(() => readAccountNonce(), (value) => {
      const nonce = nonceOf(object(value) ? value.nonce : value, 0);
      return nonce === null ? null : { nonce, blockHeight: object(value) ? nonceOf(value.blockHeight, 0) : null };
    });
    if (!('value' in account)) return { alive: true, reason: `the account nonce could not be read: ${account.cause}` };
    if (account.value.nonce < signed.nonce) return { alive: true };
    const state = await read(() => readTransactionState({ txHash: signed.txHash }), (value) => {
      if (TX_STATES.has(value)) return { state: value, checkedThroughBlock: null };
      return object(value) && TX_STATES.has(value.state) ? { state: value.state, checkedThroughBlock: nonceOf(value.checkedThroughBlock, 0) } : null;
    });
    if (!('value' in state)) return { alive: true, reason: `the kept CREATE's state could not be read: ${state.cause}` };
    if (state.value.state !== 'absent') return { alive: true };
    if (account.value.blockHeight === null || state.value.checkedThroughBlock === null || state.value.checkedThroughBlock < account.value.blockHeight) {
      return { alive: true, reason: 'the kept CREATE has no complete absence observation through the account nonce snapshot' };
    }
    return { alive: false, reason: `the kept signed CREATE ${signed.txHash} (nonce ${signed.nonce}) is not executed through block ${state.value.checkedThroughBlock} and the account nonce is ${account.value.nonce}; it can no longer be executed` };
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
      const problem = signedCreateProblem(answer, input);
      if (problem) throw Object.assign(new Error(`signCreate's signed transaction ${problem}`), { code: 'wallet_sign_invalid' });
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
    // An attempt whose answer names a transaction this journal never kept was
    // anchored through another journal (a lost or replaced file): its fate is
    // not this journal's to answer, and `unsigned` would allow a second CREATE.
    const named = input?.attempt?.answer?.txHash;
    if (typeof named === 'string' && !db.prepare('SELECT 1 AS found FROM evidence_creates WHERE logical_address = ? AND tx_hash = ?').get(input.logicalAddress, named)) {
      throw Object.assign(new Error(`the wallet journal kept no signed CREATE ${named.slice(0, 64)} for this address`), { code: 'wallet_journal_unknown_attempt' });
    }
    const { live: signed, superseded, reason: unread } = await liveFor(input);
    if (!signed) {
      // Replay the transaction-bound decision after a crash between this
      // journal's supersession and the agent's checkpoint of that answer.
      const prior = rows(input.logicalAddress).filter((row) => row.superseded_at !== null).at(-1);
      return { status: 'unsigned', ...(prior ? { txHash: typeof named === 'string' ? named : prior.tx_hash } : {}), reason: superseded?.reason ?? 'the wallet journal keeps no live signed CREATE for this address' };
    }
    try { await broadcast({ signedTransaction: signed.signedTransaction, txHash: signed.txHash }); }
    catch (error) { return { status: 'pending', txHash: signed.txHash, reason: `the same signed CREATE was not broadcast again: ${reason(error)}` }; }
    return { status: 'rebroadcast', txHash: signed.txHash, ...(unread ? { reason: unread } : {}) };
  }

  // Read only: the live kept CREATE's public signed projection, as signCreate gave it.
  async function readSignedProjection(input) {
    if (!object(input) || typeof input.logicalAddress !== 'string') throw new TypeError('the wallet journal is asked about no payment-evidence address');
    const live = db.prepare('SELECT signed_transaction FROM evidence_creates WHERE logical_address = ? AND superseded_at IS NULL').get(input.logicalAddress);
    return live ? JSON.parse(live.signed_transaction) : null;
  }

  const journal = Object.freeze({ anchorEvidence, reconcilePaymentEvidence, readSignedProjection, journalId, close: () => db.close() });
  journals.set(anchorEvidence, journal);
  journals.set(reconcilePaymentEvidence, journal);
  return journal;
}
