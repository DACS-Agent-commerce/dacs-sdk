import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { isTp1WireProfile, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { SELLER_CONTEXT_PATH, SellerTransportError } from './seller-transport-auth.mjs';

// The wire journal's lease; accounting refuses a clock whose lease sum the journal could not take.
const RESERVATION_LEASE_MS = 300000;
const RESULTS = new Set(['new', 'recover', 'completed']);
const PURCHASE_SLOT_UNITS = 17;
const GENERAL_CAPACITY = Object.freeze({ class: 'general', allocationId: null });
const PAYMENT_PATH = '/dacs/v1/payments';
// A transaction's key as the transport store keeps it: no 0x prefix, lower case.
const transactionOf = value => typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value) ? value.replace(/^0x/, '').toLowerCase() : null;
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const fail = (code, status) => { throw new SellerTransportError(code, status); };
// K5 step 8 (amend1 D19): a refusal of the wire or the host carries a string code and an HTTP status; a system error's code (EIO) has no status.
const isDefiniteRefusal = error => typeof error?.code === 'string' && Number.isInteger(error.status);

/**
 * Compose durable pre-reservation accounting over the owning store's synchronous SQL/transaction port and its
 * reservation ledger: the store's one definition of the records behind each limit, which its old reserve path reads too.
 * Returns an object with reserveAccounted; throws a TypeError on invalid limits.
 * The store owns the schema and BEGIN IMMEDIATE; every check and hook runs within that same transaction.
 */
export function createReservationAccounting({ store, now, limits, contextRecords }) {
  if (![limits?.maxRecords, limits?.maxJobs, limits?.maxContextRecords, limits?.maxNoncesPerBuyerPerWindow].every(value => uint(value) && value > 0) ||
      typeof now !== 'function') throw new TypeError('positive reservation limits required');
  const { get, run, transaction, ledger } = store;
  const countContextRecords = contextRecords ?? (() => ledger.contextCountWithin());

  // Steps 2 to 4 count every ledger record, whichever path wrote it. A job, or its context record, already held
  // by any record takes no second slot.
  function checkLimitsWithin(payload, contextStart, at) {
    if (ledger.recordCountWithin(at) >= limits.maxRecords) fail('peer_store_capacity', 503);
    if (ledger.buyerUnitsWithin(payload.buyer, at) >= limits.maxNoncesPerBuyerPerWindow) fail('peer_buyer_nonce_limit', 429);
    if ((!ledger.jobHeldWithin(payload.jobId) && ledger.jobCountWithin() >= limits.maxJobs) ||
        (contextStart && !ledger.contextHeldWithin(payload.jobId) && countContextRecords() >= limits.maxContextRecords)) store.retireSlotsWithin(at, undefined, { capacity: true });
    if (!ledger.jobHeldWithin(payload.jobId) && ledger.jobCountWithin() >= limits.maxJobs) fail('peer_job_capacity', 503);
    if (contextStart && !ledger.contextHeldWithin(payload.jobId) && countContextRecords() >= limits.maxContextRecords) {
      fail('peer_context_capacity', 503);
    }
  }

  // The job belongs to the parties and Agreement already holding it; an existing purchase must hold this exact tuple.
  // Returns whether the job has its purchase (job row) already.
  function checkJobWithin(payload, keepProfile, replay) {
    if (ledger.jobConflictWithin(payload)) fail('peer_job_conflict', 409);
    if (!replay && (ledger.jobClosedWithin(payload) ||
        ledger.jobRetiredWithin(payload.jobId))) fail('context_job_closed', 409);
    const tuple = canonicalize(keepProfile);
    if (canonicalize(payload.profile) !== tuple) fail('tp1_purchase_profile_mismatch', 500);
    const purchase = ledger.purchaseWithin(payload.jobId);
    if (purchase && purchase.profile !== tuple) fail('tp1_purchase_profile_mismatch', 500);
    return Boolean(purchase);
  }

  // The old reserve path's other refusals that read journal state, so a request is judged the same on either path:
  // a read of an unknown job, a job and route whose effect the old path holds, and a fresh start for a terminal session.
  function checkRouteWithin(payload, operationId) {
    if (ledger.unknownJobWithin(payload)) fail('peer_unknown_job', 404);
    if (ledger.oldSlotWithin(payload)) fail('peer_operation_conflict', 409);
    if (ledger.terminalStartWithin(payload, operationId)) fail('context_session_terminal', 409);
  }

  function capacityWithin(input, at, key) {
    if (get('SELECT key FROM kit_reservations WHERE key = ?', key)) fail('peer_request_replayed', 409);
    const { payload, route, operationId, checkCapacityWithin } = input;
    const capacity = checkCapacityWithin ? checkCapacityWithin({ get, run, payload, route, operationId, at }) : GENERAL_CAPACITY;
    if (capacity?.class === 'general') return GENERAL_CAPACITY;
    if (capacity?.class !== 'purchase-stage') fail('wire_input_invalid', 500);
    const changed = run(`UPDATE kit_allocations SET rev = rev + 1
      WHERE allocationId = ? AND jobId = ? AND state = 'live' AND rev = ?
        AND json_extract(record, ?) = 'open'
        AND (SELECT COUNT(*) FROM kit_reservations WHERE allocationId = ? AND route = ? AND class = 'purchase') < ?`,
    capacity.allocationId, payload.jobId, capacity.allocationRev, '$.slots."' + route + '"', capacity.allocationId, route, PURCHASE_SLOT_UNITS);
    if (changed.changes !== 1) fail('peer_store_capacity', 503);
    return { class: 'purchase', allocationId: capacity.allocationId };
  }

  // Steps 1 to 6 in one transaction: a refusal at any step, or a failed commit, leaves no hold, row, unit, claim or tuple.
  function chargeWithin(input, key, requestHash) {
    const { payload, route, operationId, paymentTx, keepProfile } = input;
    const contextStart = route === SELLER_CONTEXT_PATH;
    const at = now();
    if (!uint(at) || !uint(at + RESERVATION_LEASE_MS)) fail('peer_clock_invalid', 503);
    const replay = ledger.retiredReplayWithin(payload, operationId);
    if (replay) {
      if (ledger.recordCountWithin(at) >= limits.maxRecords) fail('peer_store_capacity', 503);
      if (ledger.buyerUnitsWithin(payload.buyer, at) >= limits.maxNoncesPerBuyerPerWindow) fail('peer_buyer_nonce_limit', 429);
      if (get('SELECT key FROM kit_reservations WHERE key = ?', key)) fail('peer_request_replayed', 409);
    } else checkLimitsWithin(payload, contextStart, at);
    const purchased = checkJobWithin(payload, keepProfile, replay);
    if (!replay) checkRouteWithin(payload, operationId);
    const capacity = replay ? GENERAL_CAPACITY : capacityWithin(input, at, key);
    // The hold comes first because every reservation row references its job.
    store.holdJobWithin(payload, contextStart);
    // The first claim for a transaction is retained for accounting only: a competing job still reaches settlement intake.
    if (paymentTx !== null && !replay) run('INSERT OR IGNORE INTO kit_payment_transactions VALUES (?, ?, ?)', paymentTx, payload.jobId, operationId);
    run(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', 1)`, key, payload.buyer, payload.jobId, operationId, route,
    capacity.allocationId, capacity.class, requestHash, at);
    // The context step carries its scope hash in the agreementHash slot, so the job's first purchase request,
    // not the context start, writes its job row and tuple.
    if (!replay && !purchased && !contextStart) store.keepJobWithin(payload, keepProfile, at);
    return replay;
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
    const { checked, payload, route, operationId, paymentTx = null, keepProfile, checkCapacityWithin } = options;
    if (!isTp1WireProfile(keepProfile)) fail('tp1_purchase_profile_mismatch', 500);
    if (typeof checked?.reserve !== 'function' || typeof payload !== 'object' || payload === null || route !== payload.path ||
        operationId !== wireOperationId(payload) || (paymentTx !== null && (typeof paymentTx !== 'string' || paymentTx.length === 0)) ||
        (checkCapacityWithin !== undefined && typeof checkCapacityWithin !== 'function')) fail('wire_input_invalid', 500);
    // The payment route carries its transaction claim, the admitted body's own txHash, and no other route carries one.
    const claim = route === PAYMENT_PATH ? transactionOf(checked.body?.txHash) : null;
    if (route === PAYMENT_PATH ? paymentTx === null || claim === null || transactionOf(paymentTx) !== claim : paymentTx !== null) fail('wire_input_invalid', 500);
    return { checked, payload, route, operationId, paymentTx: claim, keepProfile, checkCapacityWithin };
  }

  return {
    /**
     * Charge once, commit the job's hold, a first purchase's job row with its tuple and the payment claim, then call
     * checked.reserve and record its result. Returns the wire effect (state new, recover or completed). Throws the
     * reservation's own refusal (a string code and an HTTP status), after recording it as refused{code}; any other
     * failure leaves the charged row `reserving`, never refunded.
     * The store decides whether the job and its context record are new; the context route is the context start.
     * A completed replay on a retired job spends a nonce unit without spending purchase capacity or recreating the purchase.
     * Throws before any row on an absent keepProfile, an unsafe clock, a full store, buyer window, job or context
     * capacity, a job held by other parties, a closed job (context_job_closed), a tuple mismatch, a replayed nonce key,
     * or a refusal from checkCapacityWithin. Ownership remains after the job row is removed; a no-effect end
     * releases only its provisional Agreement binding when nothing else retains the job.
     * checkCapacityWithin is step 5: synchronous, run inside the transaction, returning a general or purchase-stage classification;
     * its SQL writes roll back with the rest. Without it every row is general capacity.
     */
    async reserveAccounted(options = {}) {
      assertKitOperationAdmitted('reserveAccounted');
      const input = admittedInput(options);
      const { checked, payload } = input;
      const key = sha256Hex(canonicalize({ buyer: payload.buyer, seller: payload.seller, profile: payload.profile, nonce: payload.nonce }));
      const replay = transaction(() => chargeWithin(input, key, wireRequestHash(payload)));
      let effect;
      try { effect = await checked.reserve(); }
      catch (error) {
        if (isDefiniteRefusal(error)) saveRefusal(key, error);
        throw error;
      }
      if (!RESULTS.has(effect?.state) || (replay && effect.state !== 'completed')) fail('wire_input_invalid', 500);
      saveResult(key, effect.state);
      return effect;
    },
  };
}
