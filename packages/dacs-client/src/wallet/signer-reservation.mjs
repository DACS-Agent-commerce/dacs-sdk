// Internal durable signer reservation: one live write per signer, claimed before a nonce is chosen or anything is signed.
// This module signs nothing, sends nothing and settles nothing; it only records who may use a signer's next nonce.
//
// Each signer has one record in the journal, under the same key as the signer's journal lock, so every process on the
// journal file contends for the same row. A stalled holder is never timed out; the journal reclaims only a holder it can
// prove dead. Every step reads the record under that lock, checks that the caller's handle is still the stored record and
// writes the whole next record in one put. A refused or interrupted put therefore leaves the previous record unchanged,
// and no step depends on another record. A put that throws is read back: the same record means it committed, another
// record means it did not (the put's error is rethrown), and an unreadable answer is `signer_reservation_uncertain`.
//
// Order of one write: `reserve` claims the nonce, `bindApprovalIntent` stores the exact approval request text before the
// approval is prepared, `bindApproval` attaches the approval ledger's id (a null manual id is kept by this instance only),
// and `bindSigned` stores the signed bytes. The caller sends the bytes only after `bindSigned` returns them.
//
// Lock order: the kit writer lock, then the signer lock; the signer lock is never re-entered.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyDemosSignature } from '../signatures.mjs';
import { sha256Hex } from '../util/ids.mjs';

const FORMAT = 'dacs-signer-reservation/v3';
const KEY_ROOT = 'devnet/signer-reservation';
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
const OPERATIONS = ['payment-evidence', 'native', 'artifact'];
const SIGNATURE_DATA = /^(?:0x)?[a-f0-9]{128}$/;
const UNCHANGED = Symbol('unchanged');

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isHex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isAddress = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
const isText = (value, limit = MAX_ID_BYTES) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !value.includes('\0');

function fail(code, detail = code) { throw Object.assign(new Error(code, { cause: detail instanceof Error ? detail : new Error(detail) }), { code }); }
function check(condition, message) { if (!condition) fail('signer_reservation_invalid', message); }

// The signed projection must be the transaction this signer signed for this nonce: its hash is the digest of its content
// and its Ed25519 signature over that hash verifies against the signer's key.
function validateSigned(signed, signer, nonce) {
  check(isHex64(signed?.txHash) && isHex64(signed.inputDigest) && isText(signed.projectionText, MAX_TEXT_BYTES), 'invalid signed projection');
  let projection;
  try { projection = JSON.parse(signed.projectionText); } catch (cause) { fail('signer_reservation_invalid', cause); }
  check(projection?.hash === signed.txHash && projection.content?.from === signer && projection.content.nonce === nonce, 'signed fields mismatch');
  check(sha256Hex(JSON.stringify(projection.content)) === signed.txHash, 'transaction hash mismatch');
  const { signature } = projection;
  check(signature?.type === 'ed25519' && typeof signature.data === 'string' && SIGNATURE_DATA.test(signature.data)
    && verifyDemosSignature({ address: signer, message: signed.txHash, signature: signature.data }), 'transaction signature invalid');
}

/**
 * Creates the reservation steps over a durable journal that has `get`, `put` and `withWalletLock`. `pins` supplies the
 * network, chain identity and pin version every record carries. Returns `reserve`, `bindApprovalIntent`, `bindApproval`,
 * `bindSigned` and the read-only `current(signer)`, which returns the signer's record or null.
 * Throws `signer_reservation_invalid` for a malformed record or argument, `signer_reservation_stale` for a handle that is
 * not the stored record, `signer_reservation_uncertain` when a failed write cannot be read back, `signer_lane_busy` and
 * `invalid_nonce`; journal errors such as `journal-capacity` pass through. Each keeps the original error as its `cause`.
 */
export function createSignerReservations({ journal, pins } = {}) {
  check(['get', 'put', 'withWalletLock'].every(name => typeof journal?.[name] === 'function'), 'durable journal required');
  check(pins?.network === 'demos-testnet' && isHex64(pins.chainIdentity) && isText(pins.pinVersion), 'trusted pins required');
  const manualApprovals = new Map();
  const keyOf = signer => { check(isAddress(signer), 'invalid signer'); return `${KEY_ROOT}/${JSON.stringify([pins.network, pins.chainIdentity, signer])}`; };

  function validateActive(active, record) {
    check(isText(active.attemptId) && OPERATIONS.includes(active.operation) && isText(active.operationKey), 'invalid active identity');
    check(isCount(active.nonce) && active.nonce > 0 && active.nonce >= record.floor, 'invalid nonce');
    check(active.approvalIntent === null || isText(active.approvalIntent, MAX_TEXT_BYTES), 'invalid approval intent');
    check(active.approvalId === null || (isText(active.approvalId) && active.approvalIntent !== null), 'invalid approval id');
    if (active.signed !== null) { check(active.approvalIntent !== null, 'signed without approval intent'); validateSigned(active.signed, record.signer, active.nonce); }
  }
  async function readRecord(signer) {
    const record = await journal.get(keyOf(signer));
    if (record === undefined) return null;
    check(record?.format === FORMAT && record.signer === signer && isText(record.pinVersion), 'format or signer mismatch');
    check(record.network === pins.network && record.chainIdentity === pins.chainIdentity, 'chain mismatch');
    check(isCount(record.revision) && record.revision > 0 && isCount(record.floor), 'invalid revision or floor');
    if (record.active !== null) validateActive(record.active, record);
    return record;
  }
  async function write(record) {
    const key = keyOf(record.signer);
    try { await journal.put(key, record); } catch (cause) {
      let saved;
      try { saved = await journal.get(key); } catch { fail('signer_reservation_uncertain', cause); }
      if (!isDeepStrictEqual(saved, record)) throw cause;
    }
    return record;
  }
  // Runs `step` on the stored record under the signer's lock; a handle that is not the stored record is stale.
  // `step` returns the next `active`, or UNCHANGED to return the stored record without a write.
  async function update(reservation, step) {
    check(isAddress(reservation?.signer), 'reservation required');
    return journal.withWalletLock(keyOf(reservation.signer), async () => {
      const record = await readRecord(reservation.signer);
      if (!isDeepStrictEqual(record, reservation)) fail('signer_reservation_stale');
      check(record.active !== null, 'active reservation required');
      const active = step(record);
      if (active === UNCHANGED) return record;
      check(isCount(record.revision + 1), 'revision exhausted');
      return write({ ...record, revision: record.revision + 1, active });
    });
  }

  /**
   * Claims the signer for `operation` and `operationKey` under its lock, before any nonce is chosen. Returns
   * `{reservation, nonce}`: the stored reservation unchanged when this operation already holds the signer (no write and
   * no chain read), else a new claim at `max(chain + 1, floor)`, where `chain` is read through `readChainNonce({signal})`.
   * Another operation holding the signer is `signer_lane_busy`; a nonce without a safe successor is `invalid_nonce`.
   */
  async function reserve({ signer, operation, operationKey, readChainNonce, signal } = {}) {
    check(isAddress(signer) && OPERATIONS.includes(operation) && isText(operationKey) && typeof readChainNonce === 'function', 'invalid claim');
    return journal.withWalletLock(keyOf(signer), async () => {
      signal?.throwIfAborted();
      const record = await readRecord(signer);
      if (record?.active) {
        if (record.active.operation !== operation || record.active.operationKey !== operationKey) fail('signer_lane_busy');
        return { reservation: record, nonce: record.active.nonce };
      }
      const floor = record?.floor ?? 0;
      if (!isCount(floor + 1)) fail('invalid_nonce', 'the nonce floor has no safe successor');
      const chain = await readChainNonce({ signal });
      signal?.throwIfAborted();
      if (!isCount(chain) || !isCount(chain + 1)) fail('invalid_nonce', `unusable chain nonce answer: ${String(chain)}`);
      const nonce = Math.max(chain + 1, floor), revision = (record?.revision ?? 0) + 1;
      check(isCount(revision), 'revision exhausted');
      const reservation = await write({ format: FORMAT, network: pins.network, chainIdentity: pins.chainIdentity, pinVersion: pins.pinVersion,
        signer, revision, floor, active: { attemptId: randomUUID(), operation, operationKey, nonce, approvalIntent: null, approvalId: null, signed: null } });
      return { reservation, nonce };
    });
  }

  /** Stores the exact approval request text before the approval is prepared; returns the reservation. The same text again changes nothing; another text is refused. */
  async function bindApprovalIntent(reservation, requestText) {
    check(isText(requestText, MAX_TEXT_BYTES), 'invalid approval intent');
    return update(reservation, ({ active }) => {
      if (active.approvalIntent === requestText) return UNCHANGED;
      check(active.approvalIntent === null, 'approval intent already bound');
      return { ...active, approvalIntent: requestText };
    });
  }
  /**
   * Attaches the approval `{ledgerId, requestText}` to the stored intent, whose text must match exactly, and returns the
   * reservation. A null `ledgerId` is a manual grant: this instance keeps it for the current revision and nothing durable
   * records it. Refuses after the signed bytes are bound, and refuses a ledger id other than one already bound.
   */
  async function bindApproval(reservation, approval) {
    const ledgerId = approval?.ledgerId;
    check((ledgerId === null || isText(ledgerId)) && isText(approval?.requestText, MAX_TEXT_BYTES), 'invalid approval');
    const record = await update(reservation, ({ active }) => {
      check(active.signed === null && active.approvalIntent === approval.requestText, 'approval does not match the open intent');
      if (active.approvalId === ledgerId) return UNCHANGED;
      check(active.approvalId === null && ledgerId !== null, 'approval already bound');
      return { ...active, approvalId: ledgerId };
    });
    if (ledgerId === null) manualApprovals.set(record.signer, record.revision);
    return record;
  }
  /**
   * Stores the exact signed projection `{txHash, projectionText, inputDigest}` in one write and returns the reservation
   * holding it. Refuses a stale handle, a reservation without an approval, bytes already bound, and a projection whose
   * hash, signer, nonce or Ed25519 signature do not match.
   */
  async function bindSigned(reservation, { txHash, projectionText, inputDigest } = {}) {
    return update(reservation, ({ signer, revision, active }) => {
      check(active.signed === null, 'signed bytes already bound');
      check(active.approvalId !== null || (active.approvalIntent !== null && manualApprovals.get(signer) === revision), 'approval required before signed binding');
      const signed = { txHash, inputDigest, projectionText };
      validateSigned(signed, signer, active.nonce);
      return { ...active, signed };
    });
  }
  return Object.freeze({ reserve, bindApprovalIntent, bindApproval, bindSigned, current: readRecord });
}
