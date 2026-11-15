import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, isTp1WireProfile, wireOperationBinding, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { assertAdmissionJobLease } from './seller-admission-transaction.mjs';
import { SELLER_CONTEXT_PATH, SellerTransportError } from './seller-transport-auth.mjs';

// The wire journal's lease; accounting refuses a clock whose lease sum the journal could not take.
const RESERVATION_LEASE_MS = 300000;
// How long a request waits for the mutex of its operation before it is answered `seller_effect_pending`.
const MUTEX_WAIT_MS = 10000;
const STORE_CAPACITY_CODE = 'peer_store_capacity';
const RESULTS = new Set(['new', 'recover', 'completed']);
const PURCHASE_SLOT_UNITS = 17;
const GENERAL_CAPACITY = Object.freeze({ class: 'general', allocationId: null });
const PAYMENT_PATH = '/dacs/v1/payments';
// A transaction's key as the transport store keeps it: no 0x prefix, lower case.
const transactionOf = value => typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value) ? value.replace(/^0x/, '').toLowerCase() : null;
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const fail = (code, status) => { throw new SellerTransportError(code, status); };
/** The key a request's accounting row is stored under: the hash of its buyer, seller, profile and nonce. */
export const requestNonceKey = (payload) => sha256Hex(canonicalize({ buyer: payload.buyer, seller: payload.seller, profile: payload.profile, nonce: payload.nonce }));
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
      const key = requestNonceKey(payload);
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

// One in-process first-come mutex per key. `acquire(key)` resolves to a release function (safe to call twice); a key nobody owns or
// waits for leaves no entry. The mutex lives in memory only: a restart starts with every key free, relying on the seller state lock
// that excludes a second live host.
function createKeyedMutex() {
  const tails = new Map();
  return function acquire(key) {
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const owned = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => owned);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return previous.then(() => release);
  };
}

/**
 * Compose the reservation coordinator over the accounting, the purchase capacity and `inspectOperation(payload)`, the
 * synchronous read-only wire inspection of the payload's operation. `admissionTransaction`, when given, validates the job lease the
 * context route borrows. Returns an object with reserveCoordinated and addPreAccountingGate; throws a TypeError when a port is missing or
 * unusable. The capacity supplies the terminal check (`terminalSession`) and the pending-observation barrier it forwards from the store.
 */
export function createReservationCoordinator({ accounting, capacity, inspectOperation, admissionTransaction }) {
  if (typeof accounting?.reserveAccounted !== 'function' || typeof capacity?.classify !== 'function' || typeof capacity.recordExhaustion !== 'function'
      || typeof capacity.terminalSession !== 'function' || typeof capacity.flushTerminalObservations !== 'function'
      || typeof inspectOperation !== 'function') {
    throw new TypeError('the reservation coordinator needs accounting, purchase capacity, an operation inspection and, for context, the admission transaction');
  }
  const acquire = createKeyedMutex();
  const gates = [];
  // What a request running under a borrowed job lease releases here: nothing, since its caller releases the lease.
  const releaseNothing = () => {};

  // A waiter that passes the deadline is refused, and the grant its place in the queue still earns is handed back unused.
  async function acquireWithinDeadline(operationId) {
    const acquiring = acquire(operationId);
    try { return await boundedCall(() => acquiring, { timeoutMs: MUTEX_WAIT_MS }); } catch (cause) {
      if (!isBoundedCallTimeout(cause)) throw cause;
      void acquiring.then(release => release(), () => {});
      throw new SellerTransportError('seller_effect_pending', 503, { cause });
    }
  }
  // The context route runs inside the job's effect mutex, which its caller owns and releases; every other route takes its operation's.
  async function enter({ payload, operationId }, ownership) {
    if (payload.path !== PATHS.context) {
      if (ownership !== undefined) throw new TypeError('only the context route runs under a borrowed job lease');
      return acquireWithinDeadline(operationId);
    }
    assertAdmissionJobLease(admissionTransaction, payload.jobId, ownership?.jobLease);
    return releaseNothing;
  }

  // The exhaustion record is written after the refused charge rolled back; a failed write is thrown with the refusal as its cause.
  function annotateExhaustion({ payload, route, operationId }, refusal) {
    try { capacity.recordExhaustion({ operationId, jobId: payload.jobId, route, cause: refusal.code }); } catch (failure) {
      if (failure instanceof Error && failure.cause === undefined && Object.isExtensible(failure)) failure.cause = refusal;
      throw failure;
    }
  }
  // A gate answers exactly null or a refusal; anything else, a Promise included, is a defect of the gate and is never read as consent.
  function refuseByGates(request) {
    for (const gate of gates) {
      const answer = gate(request);
      if (answer === null) continue;
      if (typeof answer?.then === 'function') void Promise.resolve(answer).then(undefined, () => {});
      if (typeof answer?.code !== 'string' || !Number.isSafeInteger(answer.status) || answer.status < 400 || answer.status > 599) {
        throw new TypeError('a pre-accounting gate answers null or a refusal { code, status }');
      }
      throw new SellerTransportError(answer.code, answer.status);
    }
  }
  // A terminal session refuses, then each gate may, unless this very operation already completed under the
  // request's binding, whose source-verified replay stays available.
  function refuseBeforeAccounting({ payload, route }, inspection) {
    if (inspection?.state === 'completed' && inspection.binding === wireOperationBinding(payload)) return;
    if (capacity.terminalSession(payload.jobId).terminal) fail('context_session_terminal', 409);
    refuseByGates(Object.freeze({ route, jobId: payload.jobId, payload, inspection }));
  }
  async function reserveUnderMutex({ retainedWork, answersCompletedAtCapacity, ...accounted }) {
    const { payload, route } = accounted;
    capacity.flushTerminalObservations();
    const inspection = inspectOperation(payload);
    refuseBeforeAccounting(accounted, inspection);
    let refusal = null;
    const classify = () => capacity.classify({ jobId: payload.jobId, buyer: payload.buyer, seller: payload.seller, listingPin: payload.listingPin,
      route, binding: wireOperationBinding(payload), inspection, retainedWork });
    // A completed operation at capacity has no unit, record or nonce to charge, so no limit on a new reservation applies to it. A route that
    // revalidates its sources is answered from the stored outcome before any accounting; any other route is refused in the charge.
    if (answersCompletedAtCapacity && inspection.state === 'completed' && inspection.binding === wireOperationBinding(payload)) {
      const classified = classify();
      if (classified.class === 'completed-at-capacity') return Object.freeze({ state: 'completed', outcome: classified.outcome });
    }
    const checkCapacityWithin = () => {
      let classified;
      try { classified = classify(); } catch (error) {
        if (error?.code === STORE_CAPACITY_CODE) refusal = error;
        throw error;
      }
      if (classified.class === 'completed-at-capacity') fail(STORE_CAPACITY_CODE, 503);
      return classified;
    };
    try { return await accounting.reserveAccounted({ ...accounted, checkCapacityWithin }); } catch (error) {
      if (refusal !== null && error === refusal) annotateExhaustion(accounted, refusal);
      throw error;
    }
  }

  return {
    /**
     * Registers a pre-accounting gate: a synchronous, read-only `({ route, jobId, payload, inspection })` answering null or a refusal
     * `{ code, status }` (status 400 to 599). Gates run in registration order after the terminal check and before any accounting;
     * register them before serving. A gate that throws refuses the request with its own error; any other answer, a Promise included,
     * throws a TypeError. Throws a TypeError for a gate that is not a function.
     */
    addPreAccountingGate(gate) {
      if (typeof gate !== 'function') throw new TypeError('a pre-accounting gate must be a function');
      gates.push(gate);
    },
    /**
     * Reserve one request under its operation's mutex: inspect the operation, then run the accounting (steps 1 to 8) with step 5
     * classifying that inspection through the purchase capacity, call checked.reserve and record its result. The input is
     * reserveAccounted's plus `retainedWork`, the host's flag for a retained purchase stage. Returns the wire effect.
     * The mutex is released only once reserveAccounted has settled, whether it returned or threw; a context request borrows the
     * `ownership.jobLease` its caller holds instead, validated against the job and never released here.
     * After the inspection, an operation completed under this request's binding classifies as before and meets neither the terminal
     * check nor a gate; any other request is refused context_session_terminal 409 once its job's closure is durable, or by a gate, before
     * any accounting row, unit or agent call. A failed write of the closure, or of an earlier pending one, is thrown as it is.
     * Throws seller_effect_pending 503 (the timeout as its cause) after 10,000 ms without the mutex, before inspecting and with no
     * row, unit or file. A completed operation at capacity returns `{ state: 'completed', outcome }` before any accounting, so a full record
     * ledger or buyer window does not refuse it, with no row, unit, nonce, file or exhaustion record, when `answersCompletedAtCapacity`
     * is true (the route revalidates its sources before it answers); otherwise it throws peer_store_capacity 503, as does a class that
     * has no capacity, after its exhaustion record; wire_input_invalid 500
     * for malformed input; a TypeError for a context request without a live lease of its job or any other route given one;
     * otherwise the inspection's, accounting's or reservation's own error.
     */
    async reserveCoordinated(input = {}, ownership) {
      assertKitOperationAdmitted('reserveCoordinated');
      const { payload, route, operationId, retainedWork, answersCompletedAtCapacity = false } = input;
      if (payload === null || typeof payload !== 'object' || route !== payload.path || operationId !== wireOperationId(payload) || typeof retainedWork !== 'boolean' ||
          typeof answersCompletedAtCapacity !== 'boolean') {
        fail('wire_input_invalid', 500);
      }
      const release = await enter(input, ownership);
      try { return await reserveUnderMutex(input); } finally { release(); }
    },
  };
}
