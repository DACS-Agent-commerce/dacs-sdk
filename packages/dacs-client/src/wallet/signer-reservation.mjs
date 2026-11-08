// Internal durable signer reservation: one live write per signer, claimed before a nonce is chosen or anything is signed.
// This module signs nothing, sends nothing and settles nothing; it only records who may use a signer's next nonce.
//
// One live write: ownership has one `active` entry per signer. `reserve` takes the signer's journal lock, which is also
// the ownership record's key, so every process on the journal file contends for the same row. A stalled holder is never
// timed out; the journal reclaims only a holder it can prove dead. Every write is a compare-and-swap on `revision`
// under that lock, history is append-only and the transaction record is written once.
//
// Commit order. bindApprovalIntent stores the exact request bytes before approval preparation; bindApproval attaches the
// ledger's id to those bytes; a null manual id authorizes this instance only and is never saved. bindSigned commits
// attempt (bind-started) -> immutable transaction -> signed stage -> ownership link, and only the last step makes the
// bytes visible to the caller, so any earlier prefix stays unexposed and is retired by reconciliation.
// A put that throws is read back before anything is decided; an unreadable answer keeps ownership. The sizes of every
// record a sequence will write (intent, then bind) are checked against the journal's own `maxValueBytes` (256 KiB when it
// reports none) before its first write; the ownership record is measured at the widest revision, as every later write widens it.
//
// Terminal transitions, each one put per step under the signer lock:
//   consume (authenticated execution): attempt consumed -> floor advances and ownership clears -> settle spent -> settled.
//   retireNeverDispatched (bound, no possible dispatch): attempt never-dispatched -> settle released -> settled -> ownership
//     clears txHash, approvalIntent and approval, keeping operation, nonce and floor.
//   retireUnsigned (no linked bytes): intent resolved -> pre-link attempt never-dispatched -> audit record -> settle released
//     -> settled -> ownership clears, floor unchanged.
// Ownership changes only while it still names that exact attempt and hash, so an older transition never alters a newer owner.
// Reconciliation (inside `reserve` for one signer, `recover` for all) completes any prefix of these from the stored records.
// An approval intent without an id is looked up by its exact stored text; an unavailable, ambiguous or malformed answer refuses.
// Settlement is by ledger id and idempotent for the same outcome, so a repeat after a crash is harmless.
// Lock recovery removes the lock rows of other, dead processes and changes no record. It needs the host's ownership proof
// (the state lock is held and the journal lies inside its directory), never uses elapsed time, and never touches this process's rows.
//
// Lock order: the kit writer lock, then the signer lock, then the approval policy; the signer lock is never re-entered.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const FORMAT = 'dacs-signer-reservation/v2';
const KEY_ROOT = 'devnet/signer-reservation';
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
const DEFAULT_RECORD_BYTES = 256 * 1024; // the limit assumed for a journal that does not report its own `maxValueBytes`
const WIDEST_REVISION = Number.MAX_SAFE_INTEGER; // a record that must stay writable at every later revision is measured with the widest one
const MAX_HISTORY = 1024;
const OPERATIONS = ['payment-evidence', 'native', 'artifact'];
const STAGES = ['bind-started', 'signed', 'confirm-started', 'confirm-answered', 'broadcast-started', 'broadcast-answered',
  'broadcast-unknown', 'approval-renewed', 'adopted', 'never-dispatched', 'consumed', 'settled'];
const TERMINALS = [null, 'consumed', 'never-dispatched'];
const RESTART_CAUSE = { code: 'unsigned-at-restart', message: 'the reservation had no signed bytes when the process restarted' };
const PRELINK_CAUSE = { code: 'bind-prefix', message: 'signed binding stopped before the ownership link' };
const POSSIBLE_DISPATCH_STAGES = new Set(['confirm-started', 'confirm-answered', 'broadcast-started', 'broadcast-answered', 'broadcast-unknown', 'consumed']);
const NOT_RECORDABLE_STAGES = new Set(['bind-started', 'signed', 'never-dispatched', 'consumed', 'settled']);
const SIGNATURE_DATA = /^(?:0x)?[a-f0-9]{128}$/;

const sha256 = text => createHash('sha256').update(text).digest('hex');
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isHex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isAddress = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
const isText = (value, limit = MAX_ID_BYTES) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !value.includes('\0');
const transactionKey = txHash => `${KEY_ROOT}-tx/${txHash}`;
const attemptKey = attemptId => `${KEY_ROOT}-dispatch/${attemptId}`;
const retiredKey = attemptId => `${KEY_ROOT}-retired/${attemptId}`;
const hasPossibleDispatch =attempt => attempt.history.some(entry => POSSIBLE_DISPATCH_STAGES.has(entry.stage));
const isSettled = attempt => attempt.history.some(entry => entry.stage === 'settled');
const sameOperation = (left, right) => ['operation', 'operationKey', 'nonce'].every(key => left[key] === right[key]);
const namesAttempt = (owner, attempt) => owner?.active?.attemptId === attempt.attemptId && owner.active.txHash === attempt.txHash;
// A retired never-dispatched attempt whose ownership cleanup finished: the operation and nonce stay, nothing else does.
const isCleaned = (active, attempt) => attempt?.terminal === 'never-dispatched' && active.txHash === null && active.approvalIntent === null && active.approval === null;
const causeOf = value => ({ code: String(value?.code ?? 'unknown').slice(0, MAX_ID_BYTES), message: String(value?.message ?? value).slice(0, MAX_ID_BYTES) });
const unconfigured = async () => { throw new Error('approval ledger access is not configured'); };

function fail(code, detail = code) { throw Object.assign(new Error(code, { cause: detail instanceof Error ? detail : new Error(detail) }), { code }); }
function check(condition, message) { if (!condition) fail('signer_reservation_invalid', message); }

/**
 * Removes the lock rows of other, dead processes from a client durable journal and changes no record. Requires the host's
 * ownership proof `{directory, held()}`: `held()` must resolve true and the journal's real path must lie inside the real
 * directory. Never removes a row of this journal handle or of any holder with this process's pid, and never by elapsed time.
 * Returns `{released: [lock keys]}`. Throws `state_ownership_required` (cause kept) without the proof.
 */
export async function releaseAbandonedJournalLocks({ journal, stateOwnership } = {}) {
  let proven = false, reason;
  try {
    const inside = relative(realpathSync(stateOwnership.directory), realpathSync(journal.path));
    proven = (await stateOwnership.held()) === true && inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  } catch (error) { reason = error; }
  if (!proven) fail('state_ownership_required', reason);
  check(['inspectLocks', 'releaseAbandonedLock'].every(name => typeof journal[name] === 'function'), 'journal lock recovery required');
  const released = [];
  for (const row of journal.inspectLocks()) {
    if (row.thisInstance || row.pid === process.pid) continue;
    journal.releaseAbandonedLock({ key: row.key, instance: row.instance, fence: row.fence });
    released.push(row.key);
  }
  return { released };
}

/**
 * Creates the reservation operations over a durable journal that has `get`, `put`, `entries`, `withWalletLock` and
 * `appendUnderLock`. `pins` supplies the network, chain identity and pin version every record carries; `clock.now()`
 * stamps history. `openApproval(requestText)` resolves null or the one open `{ledgerId, requestText}` for those exact bytes;
 * `settleApproval(ledgerId, outcome, reason)` settles by id and is idempotent for the same outcome. Both refuse by default,
 * so an unconfigured ledger is never guessed. Returns `reserve`, `bindApprovalIntent`, `bindApproval`, `bindSigned`,
 * `recordStage`, the terminal transitions `consume`, `retireNeverDispatched` and `retireUnsigned`, `boundUnsent`, `adopt`,
 * `resolveApprovalIntent`, `recover`, and the read-only `current(signer)` and `ownerOfHash(txHash)`.
 * Throws `signer_reservation_invalid` for a malformed record or argument, `signer_reservation_stale` for a handle whose
 * revision is no longer current, `signer_reservation_uncertain` when a write cannot be read back, `signer_lane_busy`
 * and `invalid_nonce`, plus the codes named on the terminal operations below. Each keeps the original error as its `cause`.
 */
export function createSignerReservations({ journal, pins, clock = { now: () => Date.now() }, openApproval = unconfigured, settleApproval = unconfigured } = {}) {
  check(['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock'].every(name => typeof journal?.[name] === 'function'), 'durable journal required');
  check(pins?.network === 'demos-testnet' && isHex64(pins.chainIdentity) && isText(pins.pinVersion) && typeof clock.now === 'function', 'trusted pins and clock required');
  const recordLimit = journal.maxValueBytes ?? DEFAULT_RECORD_BYTES;
  check(Number.isSafeInteger(recordLimit) && recordLimit >= 64, 'invalid journal record limit');
  const fits = record => Buffer.byteLength(JSON.stringify(record)) <= recordLimit;
  const manualApprovals = new Map();
  const keyOf = signer => { check(isAddress(signer), 'invalid signer'); return `${KEY_ROOT}/${JSON.stringify([pins.network, pins.chainIdentity, signer])}`; };
  const header = signer => ({ format: FORMAT, network: pins.network, chainIdentity: pins.chainIdentity, pinVersion: pins.pinVersion, signer });
  const now = () => { const at = clock.now(); check(isCount(at), 'invalid clock'); return at; };

  function validateHeader(record, signer) {
    check(record?.format === FORMAT && isAddress(record.signer) && (signer === undefined || record.signer === signer), 'format or signer mismatch');
    check(record.network === pins.network && record.chainIdentity === pins.chainIdentity, 'chain mismatch');
  }
  function validateOperation(record) {
    check(OPERATIONS.includes(record?.operation) && isText(record.operationKey) && isCount(record.nonce) && record.nonce > 0, 'invalid operation or nonce');
  }
  function validateApproval(approval) {
    check(approval === null || (isText(approval?.ledgerId) && isText(approval.requestText, MAX_TEXT_BYTES)), 'invalid durable approval');
  }
  function validateOwner(record, signer) {
    validateHeader(record, signer);
    check(isCount(record.revision) && record.revision > 0 && isCount(record.floor), 'invalid revision or floor');
    if (record.active === null) return;
    const { active } = record;
    validateOperation(active); validateApproval(active.approval);
    check(isText(active.attemptId) && (active.txHash === null || isHex64(active.txHash)), 'invalid active identity');
    check(active.approvalIntent === null || isText(active.approvalIntent?.requestText, MAX_TEXT_BYTES), 'invalid approval intent');
    check(active.approval === null || active.approvalIntent?.requestText === active.approval.requestText, 'approval differs from exact intent');
    check(active.nonce >= record.floor, 'nonce below consumed floor');
  }
  function validateAttempt(record) {
    validateHeader(record); validateOperation(record); validateApproval(record.approval);
    check(isText(record.attemptId) && isHex64(record.txHash) && isHex64(record.inputDigest) && isCount(record.revision), 'invalid attempt identity');
    check(Array.isArray(record.history) && record.history.length > 0 && record.history.length <= MAX_HISTORY, 'invalid dispatch history');
    check(record.history.every(entry => STAGES.includes(entry?.stage) && isCount(entry.at)), 'invalid dispatch stage');
    check(record.history[0].stage === 'bind-started' && record.revision === record.history.length, 'invalid attempt revision or prefix');
    check(TERMINALS.includes(record.terminal) && (record.terminal === null || record.history.some(entry => entry.stage === record.terminal)), 'invalid terminal state');
  }
  function validateTransaction(record, txHash) {
    validateHeader(record); validateOperation(record);
    check(isHex64(txHash) && isHex64(record.inputDigest) && isText(record.projectionText, MAX_TEXT_BYTES) && sha256(record.projectionText) === record.projectionDigest, 'projection digest mismatch');
    let projection;
    try { projection = JSON.parse(record.projectionText); } catch (cause) { fail('signer_reservation_invalid', cause); }
    check(projection?.hash === txHash && projection.content?.from === record.signer && projection.content.nonce === record.nonce, 'immutable signed fields mismatch');
    check(sha256(JSON.stringify(projection.content)) === txHash && projection.signature?.type === 'ed25519'
      && typeof projection.signature.data === 'string' && SIGNATURE_DATA.test(projection.signature.data), 'transaction content or signature invalid');
  }

  async function attemptsWhere(matches) {
    const attempts = [];
    for (const [key, record] of await journal.entries()) {
      if (!key.startsWith(`${KEY_ROOT}-dispatch/`)) continue;
      validateAttempt(record); check(key === attemptKey(record.attemptId), 'attempt key mismatch');
      if (matches(record)) attempts.push(record);
    }
    return attempts;
  }
  const attemptsFor = txHash => attemptsWhere(record => record.txHash === txHash);
  async function readOwner(signer) {
    const owner = await journal.get(keyOf(signer));
    if (owner === undefined) return null;
    validateOwner(owner, signer);
    const { active } = owner;
    if (active === null) return owner;
    const attempt = await journal.get(attemptKey(active.attemptId));
    if (attempt === undefined) check(active.txHash === null, 'linked attempt missing');
    else {
      validateAttempt(attempt);
      check(attempt.signer === signer && sameOperation(attempt, active), 'attempt ownership mismatch');
      if (attempt.terminal === null) check(isDeepStrictEqual(attempt.approval, active.approval), 'attempt approval mismatch');
      if (active.txHash !== null) check(attempt.txHash === active.txHash && attempt.history.some(entry => entry.stage === 'signed'), 'ownership hash link mismatch');
    }
    if (active.txHash !== null) {
      const transaction = await journal.get(transactionKey(active.txHash));
      validateTransaction(transaction, active.txHash);
      check(transaction.signer === signer && sameOperation(transaction, active) && transaction.inputDigest === attempt.inputDigest, 'transaction ownership mismatch');
    }
    return owner;
  }

  // A put that throws may still have committed: read it back before deciding. Equal means committed, different means
  // nothing was written (the put's own error is rethrown), unreadable means unknown and keeps ownership.
  async function commit(key, value, store) {
    try { await store(); } catch (cause) {
      let saved;
      try { saved = await journal.get(key); } catch { fail('signer_reservation_uncertain', cause); }
      if (!isDeepStrictEqual(saved, value)) throw cause;
    }
    return value;
  }
  const putRecord = (key, value) => commit(key, value, () => journal.put(key, value));
  const insertRecord = (signer, key, value) => commit(key, value, () => journal.appendUnderLock(keyOf(signer), key, value));
  async function swapOwner(expected, active, floor = expected.floor) {
    if (!isDeepStrictEqual(await readOwner(expected.signer), expected)) fail('signer_reservation_stale');
    check(isCount(expected.revision + 1) && isCount(floor), 'revision exhausted');
    return putRecord(keyOf(expected.signer), { ...expected, revision: expected.revision + 1, floor, active });
  }
  // `settled` closes a terminal attempt exactly once; a terminal stage sets `terminal`. Room is kept so that a full history can
  // still be closed: any other stage must leave space for a terminal stage and `settled`, and a terminal stage for `settled`.
  async function appendStage(attempt, stage, cause) {
    if (!isDeepStrictEqual(await journal.get(attemptKey(attempt.attemptId)), attempt)) fail('signer_reservation_stale');
    check(stage === 'settled' ? attempt.terminal !== null && !isSettled(attempt) : attempt.terminal === null, 'attempt state forbids this stage');
    check(attempt.history.length + (stage === 'settled' ? 1 : TERMINALS.includes(stage) ? 2 : 3) <= MAX_HISTORY, 'history full');
    const entry = { stage, at: now(), ...(cause === undefined ? {} : { cause: causeOf(cause) }) };
    return putRecord(attemptKey(attempt.attemptId), { ...attempt, revision: attempt.revision + 1, history: [...attempt.history, entry], ...(TERMINALS.includes(stage) ? { terminal: stage } : {}) });
  }
  // Runs `work` on the reservation's current ownership under its signer lock; a handle that is not current is stale.
  async function withCurrentOwner(reservation, work, { allowRetired = false } = {}) {
    check(isAddress(reservation?.signer), 'reservation required');
    return journal.withWalletLock(keyOf(reservation.signer), async () => {
      const owner = await readOwner(reservation.signer);
      if (!isDeepStrictEqual(owner, reservation)) fail('signer_reservation_stale');
      check(owner.active !== null, 'active reservation required');
      if (!allowRetired && await journal.get(retiredKey(owner.active.attemptId)) !== undefined) fail('signer_reservation_stale');
      return work(owner);
    });
  }

  // A live owner of this operation either returns unchanged (no possible dispatch), refuses (dispatch possible or an
  // uncleaned terminal prefix), or, when a never-dispatched attempt was fully cleaned, yields to a fresh attempt.
  async function claimLiveOwner(active, operation, operationKey) {
    if (active.operation !== operation || active.operationKey !== operationKey) fail('signer_lane_busy');
    const attempt = await journal.get(attemptKey(active.attemptId));
    if (isCleaned(active, attempt)) return false;
    if (attempt?.terminal) fail('signer_reservation_uncertain', 'a terminal attempt still owns the signer; its cleanup must finish first');
    if (attempt && (await attemptsFor(attempt.txHash)).some(hasPossibleDispatch)) fail('signer_lane_busy', 'a possible dispatch exists for this operation; only exact-byte replay may proceed');
    return true;
  }
  /**
   * Claims the signer for `operation` and `operationKey` under its lock, before any nonce is chosen. Returns `{reservation, nonce}`:
   * the unchanged stored reservation for a matching unsent attempt (no write, no chain read, `attemptId` unused), else a fresh
   * attempt at `max(chain + 1, floor)` read through `readChainNonce({signal})`. First reconciles this signer's incomplete steps.
   * Refuses with the codes named on the factory.
   */
  async function reserve({ signer, operation, operationKey, attemptId, readChainNonce, signal } = {}) {
    check(isAddress(signer) && OPERATIONS.includes(operation) && isText(operationKey) && typeof readChainNonce === 'function', 'invalid claim');
    return journal.withWalletLock(keyOf(signer), async () => {
      signal?.throwIfAborted();
      await reconcileSigner(signer, false);
      const owner = await readOwner(signer);
      if (owner?.active && await claimLiveOwner(owner.active, operation, operationKey)) return { reservation: owner, nonce: owner.active.nonce };
      const floor = owner?.floor ?? 0;
      if (!isCount(floor + 1)) fail('invalid_nonce', 'the nonce floor has no safe successor');
      check(isText(attemptId) && await journal.get(attemptKey(attemptId)) === undefined && await journal.get(retiredKey(attemptId)) === undefined, 'attempt id already used or invalid');
      const chain = await readChainNonce({ signal }); signal?.throwIfAborted();
      if (!isCount(chain) || !isCount(chain + 1)) fail('invalid_nonce', `unusable chain nonce answer: ${String(chain)}`);
      const nonce = Math.max(chain + 1, floor), revision = (owner?.revision ?? 0) + 1;
      check(isCount(revision), 'revision exhausted');
      const reservation = await putRecord(keyOf(signer), { ...header(signer), revision, floor,
        active: { attemptId, operation, operationKey, nonce, txHash: null, approvalIntent: null, approval: null } });
      return { reservation, nonce };
    });
  }

  /** Stores the exact approval request bytes before preparation; returns the new reservation. A different text than one already stored is refused. */
  async function bindApprovalIntent(reservation, requestText) {
    return withCurrentOwner(reservation, owner => {
      check(isText(requestText, MAX_TEXT_BYTES) && owner.active.txHash === null, 'invalid approval intent');
      check(owner.active.approvalIntent === null || owner.active.approvalIntent.requestText === requestText, 'intent cannot be rebuilt');
      // The ownership record later also holds the approval (same text, any valid ledger id) and the hash, and is rewritten at
      // every later revision (repeated intents, approval, link, each stage): refuse an intent that could not be bound.
      const widest = { ledgerId: '\u0001'.repeat(MAX_ID_BYTES), requestText };
      check(fits({ ...owner, revision: WIDEST_REVISION, active: { ...owner.active, txHash: 'f'.repeat(64), approvalIntent: { requestText }, approval: widest } }), 'approval intent too large to record');
      return swapOwner(owner, { ...owner.active, approvalIntent: { requestText } });
    });
  }
  /**
   * Attaches `{ledgerId, requestText}` to the stored intent; the text must equal it exactly. A null `ledgerId` is a manual
   * grant: it is kept only in this instance for this revision and nothing durable records it. Returns the new reservation.
   */
  async function bindApproval(reservation, approval) {
    return withCurrentOwner(reservation, async owner => {
      const manual = approval?.ledgerId === null;
      if (!manual) validateApproval(approval);
      check(isText(approval?.requestText, MAX_TEXT_BYTES) && owner.active.txHash === null && owner.active.approvalIntent?.requestText === approval.requestText, 'approval intent mismatch');
      const durable = manual ? null : structuredClone(approval);
      check(owner.active.approval === null || isDeepStrictEqual(owner.active.approval, durable), 'approval already bound');
      const updated = await swapOwner(owner, { ...owner.active, approval: durable });
      if (manual) manualApprovals.set(keyOf(owner.signer), updated.revision);
      return updated;
    });
  }
  /**
   * Binds the exact signed bytes to the reservation in the commit order above and returns the linked reservation only after the
   * last step. Refuses stale handles, a missing approval, a hash held by another operation, input or live or dispatched attempt,
   * and a projection whose digest, hash, signer, nonce or signature shape do not match.
   */
  async function bindSigned(reservation, { txHash, projectionText, inputDigest } = {}) {
    return withCurrentOwner(reservation, async owner => {
      const { active } = owner;
      check(active.txHash === null && (active.approval !== null || manualApprovals.get(keyOf(owner.signer)) === owner.revision), 'approval required before signed binding');
      check(isText(projectionText, MAX_TEXT_BYTES) && isHex64(txHash) && isHex64(inputDigest), 'invalid signed projection');
      const transaction = { ...header(owner.signer), operation: active.operation, operationKey: active.operationKey, nonce: active.nonce,
        inputDigest, projectionText, projectionDigest: sha256(projectionText) };
      validateTransaction(transaction, txHash);
      const previous = await journal.get(transactionKey(txHash)), attempts = await attemptsFor(txHash);
      if (previous !== undefined) { validateTransaction(previous, txHash); check(isDeepStrictEqual(previous, transaction), 'immutable transaction differs'); }
      check(attempts.every(attempt => attempt.signer === owner.signer && sameOperation(attempt, active) && attempt.inputDigest === inputDigest
        && attempt.terminal === 'never-dispatched' && !hasPossibleDispatch(attempt)), 'hash has a live or dispatched attempt');
      check(await journal.get(attemptKey(active.attemptId)) === undefined, 'incomplete signed binding requires reconciliation');
      const started = { ...header(owner.signer), revision: 1, attemptId: active.attemptId,
        operation: active.operation, operationKey: active.operationKey, nonce: active.nonce, txHash, inputDigest, approval: active.approval,
        history: [{ stage: 'bind-started', at: now() }], terminal: null };
      // Every record of the sequence must fit before the first is written: a later put the journal refuses would strand the attempt.
      const signedAttempt = { ...started, revision: 2, history: [...started.history, { stage: 'signed', at: now() }] };
      check([transaction, started, signedAttempt, { ...owner, revision: owner.revision + 1, active: { ...active, txHash } }].every(fits), 'signed binding record too large');
      const attempt = await insertRecord(owner.signer, attemptKey(active.attemptId), started);
      if (previous === undefined) await insertRecord(owner.signer, transactionKey(txHash), transaction);
      await appendStage(attempt, 'signed');
      return swapOwner(owner, { ...active, txHash });
    });
  }
  /**
   * Appends one dispatch-history entry (`stage`, optional `cause` {code, message}) to the current attempt before the
   * transmission it names, then advances ownership's revision. Returns the new reservation; refuses an unlinked reservation,
   * a stage this card does not record and a hash whose earlier attempts forbid this one.
   */
  async function recordStage(reservation, stage, { cause } = {}) {
    return withCurrentOwner(reservation, async owner => {
      check(owner.active.txHash !== null && STAGES.includes(stage) && !NOT_RECORDABLE_STAGES.has(stage), 'unlinked or invalid dispatch stage');
      const attempts = await attemptsFor(owner.active.txHash), attempt = attempts.find(row => row.attemptId === owner.active.attemptId);
      check(attempt?.terminal === null && attempts.every(row => row === attempt || (row.terminal === 'never-dispatched' && !hasPossibleDispatch(row))), 'hash history forbids this attempt');
      await appendStage(attempt, stage, cause);
      return swapOwner(owner, owner.active);
    });
  }
  async function settleById(approval, outcome, reason) {
    if (!approval) return;
    try { await settleApproval(approval.ledgerId, outcome, reason); } catch (cause) { fail('signer_settlement_failed', cause); }
  }
  // The attempt's one settlement: the ledger call, then the `settled` stage that records it. Repeating after a crash repeats only the call.
  async function settleOnce(attempt, outcome, reason) {
    if (isSettled(attempt)) return attempt;
    await settleById(attempt.approval, outcome, reason);
    return appendStage(attempt, 'settled');
  }
  // Looks the stored intent up by its exact bytes. Attaches the one open authorization; no match changes nothing; anything unclear refuses.
  async function resolveIntent(owner) {
    const { approvalIntent, approval } = owner.active;
    if (!approvalIntent || approval) return owner;
    let found;
    try { found = await openApproval(approvalIntent.requestText); } catch (cause) { fail('approval_lookup_refused', cause); }
    if (found === null) return owner;
    if (!(typeof found === 'object' && !Array.isArray(found) && isText(found.ledgerId) && found.requestText === approvalIntent.requestText)) {
      fail('approval_lookup_refused', 'the lookup did not return one exact open authorization');
    }
    return swapOwner(owner, { ...owner.active, approval: { ledgerId: found.ledgerId, requestText: found.requestText } });
  }
  // Clears or advances ownership for a terminal attempt, only while ownership still names exactly that attempt and hash.
  async function releaseOwnership(attempt) {
    const owner = await readOwner(attempt.signer);
    if (!namesAttempt(owner, attempt)) return;
    if (attempt.terminal === 'consumed') await swapOwner(owner, null, Math.max(owner.floor, attempt.nonce + 1));
    else await swapOwner(owner, { ...owner.active, txHash: null, approvalIntent: null, approval: null });
  }
  // Completes the remaining steps of a terminal attempt in DN-14's order; each step is a no-op once done.
  async function finishTerminal(attempt) {
    const consumed = attempt.terminal === 'consumed';
    if (consumed) await releaseOwnership(attempt);
    const settled = await settleOnce(attempt, consumed ? 'spent' : 'released', attempt.terminal);
    if (!consumed) await releaseOwnership(settled);
    return settled;
  }
  async function retireUnsignedLocked(owner, cause) {
    const resolved = await resolveIntent(owner), { active } = resolved, held = await journal.get(attemptKey(active.attemptId));
    const attempt = held?.terminal === null ? await appendStage(held, 'never-dispatched') : held;
    if (await journal.get(retiredKey(active.attemptId)) === undefined) {
      await insertRecord(owner.signer, retiredKey(active.attemptId), { ...header(owner.signer), attemptId: active.attemptId, revision: resolved.revision,
        operation: active.operation, operationKey: active.operationKey, nonce: active.nonce, cause: causeOf(cause), at: now() });
    }
    if (attempt) await settleOnce(attempt, 'released', 'unsigned-retired'); else await settleById(active.approval, 'released', 'unsigned-retired');
    return swapOwner(resolved, null);
  }
  // One signer, under its lock: finish every terminal transition, then resolve an intent, retire an unfinished bind prefix, or (at startup) any unsigned owner.
  async function reconcileSigner(signer, atStartup) {
    for (const attempt of await attemptsWhere(record => record.signer === signer)) {
      if (attempt.terminal !== null && (!isSettled(attempt) || namesAttempt(await readOwner(signer), attempt))) await finishTerminal(attempt);
    }
    const owner = await readOwner(signer);
    if (!owner?.active) return;
    const { active } = owner, attempt = await journal.get(attemptKey(active.attemptId));
    const prefix = attempt !== undefined && !isCleaned(active, attempt), retired = await journal.get(retiredKey(active.attemptId)) !== undefined;
    if (active.txHash === null && (retired || prefix || (attempt === undefined && atStartup))) await retireUnsignedLocked(owner, prefix ? PRELINK_CAUSE : RESTART_CAUSE);
    else await resolveIntent(owner);
  }
  // The attempt `owner` links when it is nonterminal and no attempt of its hash may have been dispatched, else null.
  async function unsentAttempt(owner) {
    if (!owner?.active || owner.active.txHash === null) return null;
    const attempts = await attemptsFor(owner.active.txHash), attempt = attempts.find(row => row.attemptId === owner.active.attemptId);
    return attempt?.terminal === null && !attempts.some(hasPossibleDispatch) ? attempt : null;
  }
  const requireUnsent = async owner => (await unsentAttempt(owner)) ?? fail('signer_dispatch_possible');
  /**
   * Read only. Returns `{reservation, transaction}` for the operation `operationKey` owning `signer` when its bound attempt is
   * nonterminal and no attempt of that hash may have been dispatched, else null.
   */
  async function boundUnsent(signer, operationKey) {
    const owner = await readOwner(signer);
    if (owner?.active?.operationKey !== operationKey || !(await unsentAttempt(owner))) return null;
    return { reservation: owner, transaction: await journal.get(transactionKey(owner.active.txHash)) };
  }
  /**
   * Marks the reservation's bound unsent bytes adopted (once) on the current attempt only, with no ownership write. Returns
   * `{reservation, transaction}`. Throws `signer_dispatch_possible` for a terminal or possibly dispatched attempt.
   */
  async function adopt(reservation) {
    return withCurrentOwner(reservation, async owner => {
      const attempt = await requireUnsent(owner);
      if (!attempt.history.some(entry => entry.stage === 'adopted')) await appendStage(attempt, 'adopted');
      return { reservation: owner, transaction: await journal.get(transactionKey(owner.active.txHash)) };
    });
  }
  /**
   * Retires the bound unsent attempt never-dispatched, settles its approval released and clears ownership's link, keeping the
   * operation, nonce and floor. Returns the cleaned reservation. Throws `signer_dispatch_possible` once any dispatch is possible.
   */
  async function retireNeverDispatched(reservation) {
    return withCurrentOwner(reservation, async owner => {
      await finishTerminal(await appendStage(await requireUnsent(owner), 'never-dispatched'));
      return readOwner(owner.signer);
    });
  }
  /**
   * Retires a reservation that has no linked bytes: `revision` must be the current one. Resolves any approval intent first,
   * writes the retirement record, settles its approval released and frees the signer, keeping the floor. `cause` is recorded
   * as `{code, message}`. Returns the freed ownership record. Throws `signer_reservation_stale` for another revision.
   */
  async function retireUnsigned(reservation, { revision, cause } = {}) {
    return withCurrentOwner(reservation, async owner => {
      if (revision !== owner.revision) fail('signer_reservation_stale');
      check(owner.active.txHash === null, 'linked bytes cannot be retired as unsigned');
      return retireUnsignedLocked(owner, cause);
    }, { allowRetired: true });
  }
  /** Looks up the reservation's stored intent by its exact text and attaches the one open authorization. Returns the reservation. Throws `approval_lookup_refused`. */
  const resolveApprovalIntent = reservation => withCurrentOwner(reservation, resolveIntent);
  /**
   * Consumes the immutable transaction `txHash` on an authenticated execution of its exact bytes: `observation` is
   * `{status: 'executed', authenticated: true, txHash, projectionText}` from the owning lane's reader, checked on every call.
   * Settles only the one effect-bearing attempt (or its already-consumed record, for a repeat) and never changes a newer owner.
   * Returns that attempt's record. Throws `signer_reservation_unknown`, `signer_execution_unproven`, `signer_reservation_ambiguous`
   * or `signer_settlement_failed` (cause kept).
   */
  async function consume(txHash, observation) {
    const known = await ownerOfHash(txHash);
    if (!known) fail('signer_reservation_unknown');
    const proven = observation?.status === 'executed' && observation.authenticated === true && observation.txHash === txHash && observation.projectionText === known.transaction.projectionText;
    if (!proven) fail('signer_execution_unproven');
    return journal.withWalletLock(keyOf(known.transaction.signer), async () => {
      const { attempts } = await ownerOfHash(txHash), owner = await readOwner(known.transaction.signer);
      const candidates = attempts.filter(attempt => attempt.terminal === 'consumed' || (attempt.terminal === null && namesAttempt(owner, attempt)));
      if (candidates.length !== 1) fail('signer_reservation_ambiguous', `${candidates.length} effect-bearing attempts for this hash`);
      const [candidate] = candidates;
      check(isCount(candidate.nonce + 1), 'nonce has no successor');
      return finishTerminal(candidate.terminal === null ? await appendStage(candidate, 'consumed') : candidate);
    });
  }
  /**
   * Startup recovery: removes dead holders' lock rows (see `releaseAbandonedJournalLocks`, same proof and refusal), then
   * reconciles every signer under its lock. Signs and sends nothing. Throws `state_ownership_required` or any reconciliation refusal.
   */
  async function recover({ stateOwnership } = {}) {
    await releaseAbandonedJournalLocks({ journal, stateOwnership });
    const signers = new Set();
    for (const [key, record] of await journal.entries()) if (key.startsWith(`${KEY_ROOT}/`) || key.startsWith(`${KEY_ROOT}-dispatch/`)) signers.add(record?.signer);
    for (const signer of signers) await journal.withWalletLock(keyOf(signer), () => reconcileSigner(signer, true));
  }
  /**
   * Read only. Returns `{transaction, attempts, currentAttempt}` for a signed hash (every attempt, including retired ones, and
   * `currentAttempt` only when ownership links it), or null when no transaction is stored. Never selects an authorization by hash alone.
   */
  async function ownerOfHash(txHash) {
    check(isHex64(txHash), 'invalid transaction hash');
    const transaction = await journal.get(transactionKey(txHash));
    if (transaction === undefined) return null;
    validateTransaction(transaction, txHash);
    const attempts = await attemptsFor(txHash);
    check(attempts.every(attempt => attempt.signer === transaction.signer && sameOperation(attempt, transaction) && attempt.inputDigest === transaction.inputDigest), 'hash attempt identity mismatch');
    const owner = await readOwner(transaction.signer);
    const currentAttempt = owner?.active?.txHash === txHash ? attempts.find(attempt => attempt.attemptId === owner.active.attemptId) ?? null : null;
    return { transaction, attempts, currentAttempt };
  }
  return Object.freeze({ reserve, bindApprovalIntent, bindApproval, bindSigned, recordStage, current: readOwner, ownerOfHash,
    consume, retireNeverDispatched, retireUnsigned, boundUnsent, adopt, resolveApprovalIntent, recover });
}
