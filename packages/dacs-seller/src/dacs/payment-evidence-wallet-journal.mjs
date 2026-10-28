// The seller wallet's journal for the payment-evidence anchor (DACS-4 PC-7(b),
// write-once): the operator's wallet primitives composed so that what the
// agent relies on from anchorEvidence, ensureEvidence and reconciliation holds
// by construction. The exact signed CREATE is kept durably, with its nonce,
// before it is broadcast, and an address has at most one live signed CREATE.
// Every later question about it is answered from that record checked against
// the chain: the kept CREATE is broadcast again as the same bytes
// (`rebroadcast`) while it can still be executed; an authenticated `applied`
// result retains the row and hash without broadcasting. It is superseded (kept,
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
//  - path: absolute path of the journal's SQLite file (created 0600 when
//    missing), in a directory owned by this user that no one else can write,
//    reached through no symbolic link and no ancestor others can write (a
//    sticky one such as /tmp excepted); anything else is refused;
//  - signCreate(input, { signal }) -> { signedTransaction, txHash, nonce }: signs, and must
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
//    Ed25519 signature over the hash as 0x and lower-case hex. Its amount is 0,
//    its ACL public and its storage on-chain; its node fee and execution edits
//    are exactly those demosdk 4.0.16 sign writes (`transaction_fee`: network
//    and rpc fee, no additional fee or rpc address; `gcr_edits`: the storage fee
//    burn, the storage program, the gas burn and the nonce increment by 1), as
//    DEM numbers before the node's denomination fork and OS strings after it
//    (amount "0"); only the node's fee amounts are not compared. Anything else is
//    refused (wallet_sign_invalid), and nothing is kept or sent;
//  - broadcast({ signedTransaction, txHash }, { signal }): sends exactly these bytes. The
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
//  Each read, signCreate and broadcast is given readTimeoutMs (default 10 s) to
//  settle, and is passed { signal } to stop at the deadline. A signCreate that
//  does not (wallet_sign_timeout) keeps nothing and frees the journal; a
//  broadcast that does not (wallet_broadcast_timeout) leaves the kept CREATE
//  live for reconcilePaymentEvidence, which answers `pending` for it.
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
// (wallet_journal_unknown_attempt) an attempt whose answer names a malformed
// txHash or one this journal never kept, a sent or applied attempt that names
// none, and any attempt other than a failure before signing that names none
// while this journal keeps no CREATE for the address: its fate is unknown, so
// it is never answered `unsigned`. A superseded named attempt with a live successor is
// refused as wallet_journal_stale_attempt; reconcile the successor separately.
// The seller's Deliverable journal (deliverable-wallet-journal.mjs) is this
// journal over its own table and file: createSignedCreateJournal is the body of
// both, and a Deliverable CREATE also carries (and is checked for) its delivery binding.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalize, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from './wallet-transactions.mjs';

// Bounds on what signCreate answers before it is kept.
const MAX_SIGNED_TRANSACTION_BYTES = 1024 * 1024;
const LOCK_POLL_MS = 5;
const TX_HASH = /^[0-9a-f]{64}$/;
// demosdk 4.0.16 (demosclass.js sign): Ed25519 is 0x and lower-case hex.
const SIGNATURE = /^0x[0-9a-f]{128}$/;
// The members the signer may leave on a storage CREATE: the SDK's own, and the source binding the SR-2 readback asks for.
const CONTENT_MEMBERS = new Set(['type', 'from', 'from_ed25519_address', 'to', 'amount', 'data', 'nonce', 'timestamp', 'transaction_fee', 'gcr_edits', 'network', 'chainIdentity']);
const OPERATION_MEMBERS = new Set(['operation', 'storageAddress', 'programName', 'encoding', 'data', 'metadata', 'acl', 'salt', 'storageLocation']);
const METADATA_MEMBERS = new Set(['logicalAddress', 'artifactKind', 'contentHash', 'envelopeHash', 'networkBinding', 'deliveryBinding']);
// One table per kind of journal; a file made for the other kind is refused.
const TABLE_NAME = /^[a-z]+_creates$/;
const EVIDENCE_TABLE = 'evidence_creates';
// Zero as the SDK signs it: a number before the node's denomination fork, the string "0" after it.
const ZERO_AMOUNTS = [0, '0'];
// demosdk 4.0.16 signs amounts as DEM numbers before the fork and as canonical OS strings (10^9 OS per DEM) after it.
const OS_PER_DEM = 1_000_000_000n;
const OS_AMOUNT = /^(0|[1-9][0-9]*)$/;
// Its storage CREATE burns 1 DEM of gas and 1 DEM of storage fee per started 10240 bytes of the program's JSON.
const GAS_DEM = 1;
const STORAGE_FEE_CHUNK_BYTES = 10_240;
// The only attempt outcome that proves no CREATE was signed, so nothing was sent.
const PRE_SIGNING_FAILURE = 'failed-before-signing';
const TX_STATES = new Set(['applied', 'pending', 'absent']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error) => String(error?.message ?? error).slice(0, 200);
const nonceOf = (value, least) => (Number.isSafeInteger(value) && value >= least ? value : null);
const journalBusy = (cause) => Object.assign(new Error('the wallet journal is busy', { cause }), { code: 'wallet_journal_busy' });
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
// Why the node fee and execution edits are not exactly those demosdk 4.0.16 sign writes for this CREATE, or null: the
// node's (or the SDK's own) network and rpc fee with no additional fee or rpc address, and the edits GCRGeneration makes,
// which the node regenerates and compares: storage fee burn, storage program, gas burn, nonce increment by 1.
function feeAndEditsProblem(content, from, op) {
  const zero = content.amount, postFork = zero === '0', fee = content.transaction_fee;
  const amount = (value) => (postFork ? typeof value === 'string' && OS_AMOUNT.test(value) : typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!object(fee) || Object.keys(fee).join() !== 'network_fee,rpc_fee,additional_fee,rpc_address' || !amount(fee.network_fee) || !amount(fee.rpc_fee)
      || fee.additional_fee !== zero || fee.rpc_address !== null) return 'does not carry the node fee as the SDK signs it';
  const dem = (value) => (postFork ? String(BigInt(value) * OS_PER_DEM) : value);
  const storageFee = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(op.data), 'utf8') / STORAGE_FEE_CHUNK_BYTES));
  const edits = [{ type: 'balance', operation: 'remove', isRollback: false, account: from, txhash: '', amount: dem(storageFee) },
    { type: 'storageProgram', target: op.storageAddress, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: from, data: { variables: op, metadata: op.metadata } } },
    { type: 'balance', account: from, operation: 'remove', amount: dem(GAS_DEM), txhash: '', isRollback: false },
    { type: 'nonce', operation: 'add', account: from, amount: 1, txhash: '', isRollback: false }];
  return JSON.stringify(content.gcr_edits) === JSON.stringify(edits) ? null : 'does not carry the execution edits the SDK signs, so the node cannot execute it';
}
// True when the CREATE's delivery binding is not exactly the input's: a Deliverable names its fulfilment, evidence names none.
const bindingProblem = (metadata, input) => ('deliveryBinding' in metadata ? input.deliveryBinding === undefined || canonicalize(metadata.deliveryBinding) !== canonicalize(input.deliveryBinding)
  : input.deliveryBinding !== undefined);
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
      || metadata.contentHash !== input.receiptContentHash || metadata.envelopeHash !== sha256Hex(canonicalize(input.artifact))
      || bindingProblem(metadata, input)) return `is not this ${input.artifactKind === 'Deliverable' ? 'Deliverable' : 'evidence'}'s storage CREATE`;
  if (content.from !== from || content.from_ed25519_address !== from || signed.signature.type !== 'ed25519' || typeof signed.signature.data !== 'string'
      || !SIGNATURE.test(signed.signature.data) || !verifyDemosSignature({ address: from, message: answer.txHash, signature: signed.signature.data })) return 'is not signed by the writer';
  const storageAddress = deriveStorageAddress(from, programName, answer.nonce, '');
  if (content.to !== storageAddress || op.storageAddress !== storageAddress) return `is not at the storage address its writer, name and nonce derive (${storageAddress})`;
  if (nonceOf(content.timestamp, 0) === null) return 'has no valid timestamp';
  // The pre-signing builder bounds the artifact and checks the signed members.
  buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress: input.logicalAddress,
    signedListing: input.artifact, nonce: answer.nonce, timestamp: content.timestamp });
  // Around the node fee and the execution edits the signer adds (demosdk sign): the zero-value public on-chain CREATE.
  if (!Object.keys(content).every((key) => CONTENT_MEMBERS.has(key)) || !Object.keys(op).every((key) => OPERATION_MEMBERS.has(key))
      || !Object.keys(metadata).every((key) => METADATA_MEMBERS.has(key))) return 'carries a member a storage CREATE does not';
  if (!ZERO_AMOUNTS.includes(content.amount) || !object(op.acl) || Object.keys(op.acl).join() !== 'mode' || op.acl.mode !== 'public' || op.storageLocation !== 'onchain') return 'is not the public zero-value on-chain CREATE';
  return feeAndEditsProblem(content, from, op);
}

// Refuses a journal path whose directory another user could write to: they could unlink or replace the file and with it the kept signatures.
function assertPrivateDirectory(directory) {
  if (realpathSync(directory) !== directory) throw new TypeError('the wallet journal directory must be a real path without symbolic links');
  for (let current = directory; ; current = dirname(current)) {
    const { uid, mode } = lstatSync(current), own = current !== directory || uid === process.getuid?.();
    // Others may write only a sticky ancestor (/tmp), where they cannot remove what they do not own.
    if (!own || ((mode & 0o022) !== 0 && (current === directory || (mode & 0o1000) === 0))) throw new TypeError(`the wallet journal directory ${current} must be owned by this user and not writable by others`);
    if (dirname(current) === current) return;
  }
}

/**
 * The journal of signed storage CREATEs both kinds of seller wallet journal are
 * made of (createPaymentEvidenceWalletJournal, createDeliverableWalletJournal):
 * the options the header describes, and `table`, the one SQLite table of its
 * kind (a file made for another kind is refused). Returns { anchor, reconcile,
 * readSignedProjection, journalId, close }, which the two kinds name for their
 * artifact. Throws TypeError for an unusable option, path or file.
 */
export function createSignedCreateJournal({ table, path, signCreate, broadcast, readAccountNonce, readTransactionState, now = () => Date.now(), readTimeoutMs = 10_000 } = {}) {
  if (!TABLE_NAME.test(table)) throw new TypeError('the wallet journal table must be named for its kind of artifact');
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('the wallet journal path must be absolute');
  if (typeof signCreate !== 'function' || typeof broadcast !== 'function' || typeof now !== 'function') throw new TypeError('the wallet journal needs signCreate, broadcast and now functions');
  if (typeof readAccountNonce !== 'function' || typeof readTransactionState !== 'function') throw new TypeError('the wallet journal needs readAccountNonce and readTransactionState, to tell a kept CREATE that can no longer be executed');
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) throw new TypeError('the wallet journal readTimeoutMs must be a positive integer');
  assertPrivateDirectory(dirname(path));
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) throw new TypeError('the wallet journal must be a private (0600) file owned by this user');
  const db = new DatabaseSync(path);
  // One row per signed CREATE; superseded rows are kept, and an address has at most one live row.
  let journalId;
  try {
    // Another opener's initialization is waited for as long as a wallet read is.
    db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=${readTimeoutMs}`);
    if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'signed_creates'").get()) {
      throw new TypeError('the wallet journal file has the earlier format, which kept no nonce; it is not read');
    }
    const initialized = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'journal_meta'").get();
    journalId = initialized ? db.prepare("SELECT value FROM journal_meta WHERE key = 'journal-id'").get()?.value : undefined;
    if (!journalId) {
      db.exec('PRAGMA journal_mode=DELETE');
      db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (logical_address TEXT NOT NULL, receipt_content_hash TEXT NOT NULL,
          tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, signed_transaction TEXT NOT NULL, signed_at INTEGER NOT NULL,
          superseded_at INTEGER, PRIMARY KEY (logical_address, nonce));
        CREATE UNIQUE INDEX IF NOT EXISTS ${table}_live ON ${table} (logical_address) WHERE superseded_at IS NULL;
        CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        // Another first opener may have initialized while this one waited for the writer lock.
        if (!db.prepare("SELECT value FROM journal_meta WHERE key = 'journal-id'").get()) {
          if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new TypeError('the wallet journal lost its identity while retaining signed CREATEs');
          db.prepare("INSERT INTO journal_meta VALUES ('journal-id', ?)").run(randomBytes(16).toString('hex'));
        }
      }).immediate();
      journalId = db.prepare("SELECT value FROM journal_meta WHERE key = 'journal-id'").get().value;
    }
    if (!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new TypeError('the wallet journal file was made for another kind of journal; it is not read');
  } catch (error) { db.close(); throw error.code === 'SQLITE_BUSY' ? journalBusy(error) : error; }
  // SQLite's writer lock is the signing lease across handles and processes.
  // A crash releases it. Commit the signed bytes before any broadcast.
  db.exec('PRAGMA busy_timeout=0');
  let queue = Promise.resolve();
  async function locked(change) {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    let begun = false;
    const deadline = performance.now() + readTimeoutMs;
    try {
      while (!begun) {
        try { db.exec('BEGIN IMMEDIATE'); begun = true; }
        catch (cause) {
          if (cause.code !== 'SQLITE_BUSY') throw cause;
          if (performance.now() >= deadline) throw journalBusy(cause);
          await delay(LOCK_POLL_MS);
        }
      }
      const answer = await change();
      db.exec('COMMIT'); begun = false;
      return answer;
    } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
    finally { release(); }
  }

  const rows =(logicalAddress) => db.prepare(`SELECT receipt_content_hash, tx_hash, nonce, signed_transaction, superseded_at FROM ${table} WHERE logical_address = ? ORDER BY nonce`).all(logicalAddress);
  // One evidence per address: a question about other bytes at a kept address is refused.
  const keptFor = (input) => {
    if (!object(input) || typeof input.logicalAddress !== 'string' || typeof input.receiptContentHash !== 'string') throw new TypeError('the wallet journal is asked about no payment-evidence address');
    const kept = rows(input.logicalAddress);
    if (kept.some((row) => row.receipt_content_hash !== input.receiptContentHash || signedCreateProblem({ signedTransaction: row.signed_transaction, txHash: row.tx_hash, nonce: Number(row.nonce) }, input))) throw Object.assign(new Error('the wallet journal holds another evidence at this address'), { code: 'wallet_journal_conflict' });
    const live = kept.find((row) => row.superseded_at === null);
    return { live: live ? { signedTransaction: live.signed_transaction, txHash: live.tx_hash, nonce: Number(live.nonce) } : null, highestNonce: kept.length ? Number(kept.at(-1).nonce) : 0 };
  };
  // Every wallet call has readTimeoutMs to settle. A call that does not is told to stop (its AbortSignal) and rejected with timedOut().
  const withDeadline = async (call, timedOut) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => call(controller.signal)), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timedOut()); }, readTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  // A wallet read with a deadline: a throw, a timeout or an answer of another shape is null.
  const read = async (call, accept) => {
    try {
      const value = accept(await withDeadline(() => call(), () => new Error('timed out')));
      return value === null ? { cause: 'answered no valid value' } : { value };
    } catch (error) { return { cause: reason(error) }; }
  };
  const sendSigned = ({ signedTransaction, txHash }) => withDeadline((signal) => broadcast({ signedTransaction, txHash }, { signal }),
    () => Object.assign(new Error(`broadcasting the kept signed CREATE ${txHash} did not settle in ${readTimeoutMs} ms; its fate is not known`), { code: 'wallet_broadcast_timeout' }));
  // Read the nonce snapshot before the transaction index. The latter must
  // have indexed at least that snapshot, closing the nonce-before-tx-row race.
  async function fate(signed) {
    const account = await read(() => readAccountNonce(), (value) => {
      const nonce = nonceOf(object(value) ? value.nonce : value, 0);
      return nonce === null ? null : { nonce, blockHeight: object(value) ? nonceOf(value.blockHeight, 0) : null };
    });
    const state = await read(() => readTransactionState({ txHash: signed.txHash }), (value) => {
      if (TX_STATES.has(value)) return { state: value, checkedThroughBlock: null };
      return object(value) && TX_STATES.has(value.state) ? { state: value.state, checkedThroughBlock: nonceOf(value.checkedThroughBlock, 0) } : null;
    });
    // Execution is authoritative even if the account nonce is stale or unreadable.
    if ('value' in state && state.value.state === 'applied') return { alive: true, applied: true };
    if (!('value' in account)) return { alive: true, reason: `the account nonce could not be read: ${account.cause}` };
    if (!('value' in state)) return { alive: true, reason: `the kept CREATE's state could not be read: ${state.cause}` };
    if (state.value.state !== 'absent' || account.value.nonce < signed.nonce) return { alive: true };
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
    if (checked.alive) return { live, highestNonce, applied: checked.applied, reason: checked.reason };
    const swap = db.prepare(`UPDATE ${table} SET superseded_at = ? WHERE logical_address = ? AND tx_hash = ? AND superseded_at IS NULL`).run(now(), input.logicalAddress, live.txHash);
    if (swap.changes !== 1) throw Object.assign(new Error('the wallet journal row changed while it was checked'), { code: 'wallet_journal_conflict' });
    return { live: null, highestNonce, superseded: { txHash: live.txHash, reason: checked.reason } };
  }

  async function prepareAnchor(input) {
    let { live: signed, highestNonce, applied } = await liveFor(input);
    if (!signed) {
      const answer = await withDeadline((signal) => signCreate(structuredClone(input), { signal }),
        () => Object.assign(new Error(`signCreate did not settle in ${readTimeoutMs} ms; nothing was kept`), { code: 'wallet_sign_timeout' }));
      if (!object(answer) || typeof answer.signedTransaction !== 'string' || answer.signedTransaction.length === 0 || Buffer.byteLength(answer.signedTransaction, 'utf8') > MAX_SIGNED_TRANSACTION_BYTES
          || typeof answer.txHash !== 'string' || !TX_HASH.test(answer.txHash) || nonceOf(answer.nonce, 1) === null) throw Object.assign(new Error('signCreate answered no signed transaction, hash and nonce'), { code: 'wallet_sign_invalid' });
      const problem = signedCreateProblem(answer, input);
      if (problem) throw Object.assign(new Error(`signCreate's signed transaction ${problem}`), { code: 'wallet_sign_invalid' });
      // A new signature must be able to land where the kept ones cannot.
      if (answer.nonce <= highestNonce) throw Object.assign(new Error(`signCreate answered nonce ${answer.nonce}, not above the kept nonce ${highestNonce}`), { code: 'wallet_sign_invalid' });
      signed = { signedTransaction: answer.signedTransaction, txHash: answer.txHash, nonce: answer.nonce };
      // Kept before it can be sent; a second live row for the address is refused, never replaced.
      db.prepare(`INSERT INTO ${table} (logical_address, receipt_content_hash, tx_hash, nonce, signed_transaction, signed_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.logicalAddress, input.receiptContentHash, signed.txHash, signed.nonce, signed.signedTransaction, now());
    }
    return { ...signed, applied };
  }
  async function anchorCreate(input) {
    const signed = await locked(() => prepareAnchor(input));
    if (!signed.applied) await sendSigned(signed);
    return { status: signed.applied ? 'applied' : 'submitted', txHash: signed.txHash };
  }

  // True when a supplied attempt cannot be tied to what this journal kept: a
  // malformed or unkept hash, a sent or applied attempt without one, or an
  // attempt that did not fail before signing while nothing is kept for the address.
  function attemptIsUnbound({ attempt, named, sent }, input) {
    if (named !== undefined) {
      return typeof named !== 'string' || !TX_HASH.test(named)
        || !db.prepare(`SELECT 1 AS found FROM ${table} WHERE logical_address = ? AND tx_hash = ?`).get(input.logicalAddress, named);
    }
    if (sent) return true;
    return attempt != null && attempt.outcome !== PRE_SIGNING_FAILURE && rows(input.logicalAddress).length === 0;
  }

  function inspectAttempt(input,attempt,ownerChecked=false,acceptedLegacy=false) {
    const named=attempt?.answer?.txHash;
    const sent=attempt?.outcome==='sent'||['submitted','applied'].includes(attempt?.answer?.status);
      if ((!ownerChecked || named !== undefined || sent) && attemptIsUnbound({ attempt, named, sent }, input)) {
        throw Object.assign(new Error(`the wallet journal kept no signed CREATE ${String(named).slice(0, 64)} for this address`), { code: 'wallet_journal_unknown_attempt' });
      }
      if (typeof named === 'string'&&!acceptedLegacy) {
        const namedRow = db.prepare(`SELECT superseded_at FROM ${table} WHERE logical_address = ? AND tx_hash = ?`).get(input.logicalAddress, named);
        const retained = keptFor(input);
        if (namedRow.superseded_at !== null && retained.live) {
          throw Object.assign(new Error('the named CREATE was superseded; reconcile the live successor separately'), { code: 'wallet_journal_stale_attempt' });
        }
      }
  }
  // Owner-bound recovery inspects and prepares under the signing lease. A
  // crashed caller's unnamed attempt cannot override this journal's facts.
  // expectedJournalId must be the immutable checkpoint owner; generic
  // reconciliation still refuses unnamed ambiguous and unkept attempts.
  async function ensureEvidence({expectedJournalId,attempt,authorize,...input}) {
    if(authorize!==undefined&&typeof authorize!=='function')throw new TypeError('evidence authorization must be a function');
    const permitted=async()=>{if(authorize&&await authorize()!==true)throw Object.assign(new Error('evidence authorization was withdrawn'),{code:'wallet_not_authorized'});};
    const signed=await locked(async()=>{
      if(expectedJournalId!==journalId)throw Object.assign(new Error('the original wallet journal is required'),{code:'wallet_journal_changed'});
      await permitted();
      const key=`ensure:${input.logicalAddress}`,binding=JSON.stringify([input.receiptContentHash,attempt?.answer?.txHash??null]);
      const accepted=db.prepare('SELECT value FROM journal_meta WHERE key = ?').get(key);
      // Remember an accepted legacy name in the same commit as its successor:
      // a lost broadcast answer cannot leave the caller naming a stale row.
      inspectAttempt(input,attempt,true,accepted?.value===binding);
      db.prepare('INSERT OR IGNORE INTO journal_meta VALUES (?, ?)').run(key,binding);
      return prepareAnchor(input);
    });
    if(!signed.applied){await permitted();await sendSigned(signed);}
    return {status:signed.applied?'applied':'submitted',txHash:signed.txHash};
  }

  async function reconcileCreate(input) {
    // An attempt whose answer names a transaction this journal never kept was
    // anchored through another journal (a lost or replaced file): its fate is
    // not this journal's to answer, and `unsigned` would allow a second CREATE.
    const attempt = input?.attempt, named = attempt?.answer?.txHash;
    const { live: signed, superseded, applied, reason: unread } = await locked(async () => {
      inspectAttempt(input,attempt);
      return liveFor(input);
    });
    if (!signed) {
      // Replay the transaction-bound decision after a crash between this
      // journal's supersession and the agent's checkpoint of that answer.
      const prior = rows(input.logicalAddress).filter((row) => row.superseded_at !== null).at(-1);
      return { status: 'unsigned', ...(prior ? { txHash: typeof named === 'string' ? named : prior.tx_hash } : {}), reason: superseded?.reason ?? 'the wallet journal keeps no live signed CREATE for this address' };
    }
    if (applied) return { status: 'applied', txHash: signed.txHash };
    try { await sendSigned(signed); }
    catch (error) { return { status: 'pending', txHash: signed.txHash, reason: `the same signed CREATE was not broadcast again: ${reason(error)}` }; }
    return { status: 'rebroadcast', txHash: signed.txHash, ...(unread ? { reason: unread } : {}) };
  }

  // Read only: the live kept CREATE's public signed projection, as signCreate gave it.
  async function readSignedProjection(input) {
    if (!object(input) || typeof input.logicalAddress !== 'string') throw new TypeError('the wallet journal is asked about no payment-evidence address');
    const live = db.prepare(`SELECT signed_transaction FROM ${table} WHERE logical_address = ? AND superseded_at IS NULL`).get(input.logicalAddress);
    return live ? JSON.parse(live.signed_transaction) : null;
  }

  return Object.freeze({ anchor: anchorCreate, reconcile: reconcileCreate, ...(table===EVIDENCE_TABLE?{ensureEvidence}:{}), readSignedProjection, journalId, close: () => db.close() });
}

export function createPaymentEvidenceWalletJournal(options) {
  const { anchor: anchorEvidence, reconcile: reconcilePaymentEvidence, ...rest } = createSignedCreateJournal({ ...options, table: EVIDENCE_TABLE });
  const journal = Object.freeze({ anchorEvidence, reconcilePaymentEvidence, ...rest });
  journals.set(anchorEvidence, journal);
  journals.set(reconcilePaymentEvidence, journal);
  return journal;
}
