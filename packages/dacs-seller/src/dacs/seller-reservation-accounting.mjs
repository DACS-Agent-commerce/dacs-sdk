import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { isTp1WireProfile, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { SellerTransportError } from './seller-transport-auth.mjs';

// The wire journal's lease; accounting refuses a clock whose lease sum the journal could not take.
const RESERVATION_LEASE_MS = 300000;
const RESULTS = new Set(['new', 'recover', 'completed']);
const CAPACITY_CLASSES = new Set(['general', 'purchase']);
const GENERAL_CAPACITY = Object.freeze({ class: 'general', allocationId: null });
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const fail = (code, status) => { throw new SellerTransportError(code, status); };
// A refusal of the wire or the host carries a string code and an HTTP status; a system error's code (EIO) has no status.
const isDefiniteRefusal = error => typeof error?.code === 'string' && Number.isInteger(error.status);

/**
 * Compose durable pre-reservation accounting over the owning store's synchronous SQL/transaction port.
 * Returns an object with reserveAccounted; throws a TypeError on invalid limits or a missing counter.
 * contextRecords returns the number of retained context records; step 4 refuses a fresh context start at the limit.
 * The store owns the schema and BEGIN IMMEDIATE; every hook runs within that same transaction.
 */
export function createReservationAccounting({ store, now, limits, contextRecords }) {
  if (![limits?.maxJobs, limits?.maxContextRecords, limits?.maxNoncesPerBuyerPerWindow, limits?.nonceWindowMs]
    .every(value => uint(value) && value > 0) || typeof now !== 'function' || typeof contextRecords !== 'function') {
    throw new TypeError('positive reservation limits and a context-record counter required');
  }
  const { get, run, transaction } = store;

  function checkBuyerWindowWithin(buyer, at) {
    const used = get('SELECT COUNT(*) AS n FROM kit_reservations WHERE buyer = ? AND at > ?', buyer, at - limits.nonceWindowMs).n;
    if (used >= limits.maxNoncesPerBuyerPerWindow) fail('peer_buyer_nonce_limit', 429);
  }

  function checkContextRecordsWithin() {
    const count = contextRecords();
    if (!uint(count) || count >= limits.maxContextRecords) fail('peer_context_capacity', 503);
  }

  function checkPurchaseTupleWithin({ payload, keepProfile, fresh }) {
    const tuple = canonicalize(keepProfile);
    if (!fresh && store.keptProfileText(payload.jobId) !== tuple) fail('tp1_purchase_profile_mismatch', 500);
    if (canonicalize(payload.profile) !== tuple) fail('tp1_purchase_profile_mismatch', 500);
  }

  function capacityWithin(input, at, key) {
    if (get('SELECT key FROM kit_reservations WHERE key = ?', key)) fail('peer_request_replayed', 409);
    const { payload, route, operationId, checkCapacityWithin } = input;
    const capacity = checkCapacityWithin ? checkCapacityWithin({ get, run, payload, route, operationId, at }) : GENERAL_CAPACITY;
    if (!CAPACITY_CLASSES.has(capacity?.class) || !(capacity.allocationId === null || typeof capacity.allocationId === 'string')) {
      fail('wire_input_invalid', 500);
    }
    return capacity;
  }

  // Steps 1 to 6 in one transaction: a refusal at any step, or a failed commit, leaves no row, unit, claim or tuple.
  function chargeWithin(input, key, requestHash) {
    const { payload, route, operationId, newJob, contextStart, paymentTx, keepProfile } = input;
    const at = now();
    if (!uint(at) || !uint(at + RESERVATION_LEASE_MS)) fail('peer_clock_invalid', 503);
    checkBuyerWindowWithin(payload.buyer, at);
    const fresh = !store.hasJobWithin(payload.jobId);
    if (newJob !== undefined && newJob !== fresh) fail('wire_input_invalid', 500);
    if (fresh && store.jobCountWithin() >= limits.maxJobs) fail('peer_job_capacity', 503);
    if (contextStart && fresh) checkContextRecordsWithin();
    checkPurchaseTupleWithin({ payload, keepProfile, fresh });
    const capacity = capacityWithin(input, at, key);
    // The first claim for a transaction is retained for accounting only: a competing job still reaches settlement intake.
    if (paymentTx !== null) run('INSERT OR IGNORE INTO kit_payment_transactions VALUES (?, ?, ?)', paymentTx, payload.jobId, operationId);
    run(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', 1)`, key, payload.buyer, payload.jobId, operationId, route,
    capacity.allocationId, capacity.class, requestHash, at);
    if (fresh) store.keepJobWithin(payload, keepProfile, at);
  }

  // Compare-and-swap on the inserted revision: a slower or repeated path cannot overwrite a newer result.
  function saveResult(key, state, code = null) {
    transaction(() => {
      const changed = run(`UPDATE kit_reservations SET state = ?, code = ?, rev = rev + 1
        WHERE key = ? AND state = 'reserving' AND rev = 1`, state, code, key);
      if (changed.changes !== 1) fail('peer_reconciliation_conflict', 503);
    });
  }

  function saveRefusal(key, refusal) {
    try { saveResult(key, 'refused', refusal.code); }
    catch (saveError) {
      // The row stays `reserving` with its unit; the refusal is still thrown as it was, carrying the failed write.
      if (refusal instanceof Error && refusal.cause === undefined && Object.isExtensible(refusal)) refusal.cause = saveError;
    }
  }

  function admittedInput(options) {
    const { checked, payload, route, operationId, newJob, contextStart = false, paymentTx = null, keepProfile, checkCapacityWithin } = options;
    if (!isTp1WireProfile(keepProfile)) fail('tp1_purchase_profile_mismatch', 500);
    if (typeof checked?.reserve !== 'function' || typeof payload !== 'object' || payload === null || route !== payload.path ||
        operationId !== wireOperationId(payload) || (newJob !== undefined && typeof newJob !== 'boolean') ||
        typeof contextStart !== 'boolean' || (paymentTx !== null && (typeof paymentTx !== 'string' || paymentTx.length === 0)) ||
        (checkCapacityWithin !== undefined && typeof checkCapacityWithin !== 'function')) fail('wire_input_invalid', 500);
    return { checked, payload, route, operationId, newJob, contextStart, paymentTx, keepProfile, checkCapacityWithin };
  }

  return {
    /**
     * Charge once, commit a new job's row with its tuple and the payment claim, then call checked.reserve and record its result.
     * Returns the wire effect (state new, recover or completed). Throws the reservation's own refusal, after
     * recording it as refused{code}; any other failure leaves the charged row `reserving`, never refunded.
     * Throws before any row on an absent keepProfile, an unsafe clock, a full buyer window, job or context
     * capacity, a tuple mismatch, a replayed nonce key, or a refusal from checkCapacityWithin.
     * newJob, when given, must equal the store's own view of whether the job is new (else wire_input_invalid).
     * checkCapacityWithin is step 5: synchronous, run inside the transaction, returning {class, allocationId};
     * its SQL writes roll back with the rest. Without it every row is general capacity.
     */
    async reserveAccounted(options = {}) {
      assertKitOperationAdmitted('reserveAccounted');
      const input = admittedInput(options);
      const { checked, payload } = input;
      const key = sha256Hex(canonicalize({ buyer: payload.buyer, seller: payload.seller, profile: payload.profile, nonce: payload.nonce }));
      transaction(() => chargeWithin(input, key, wireRequestHash(payload)));
      let effect;
      try { effect = await checked.reserve(); }
      catch (error) {
        if (isDefiniteRefusal(error)) saveRefusal(key, error);
        throw error;
      }
      if (!RESULTS.has(effect?.state)) fail('wire_input_invalid', 500);
      saveResult(key, effect.state);
      return effect;
    },
  };
}
