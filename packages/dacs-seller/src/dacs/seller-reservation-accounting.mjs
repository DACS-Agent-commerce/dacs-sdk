import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, isTp1WireProfile, wireOperationBinding, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { SellerTransportError } from './seller-transport-auth.mjs';

// The wire journal's lease; accounting refuses a clock whose lease sum the journal could not take.
const RESERVATION_LEASE_MS = 300000;
// How long a request waits for the mutex of its operation before it is answered `seller_effect_pending`.
const MUTEX_WAIT_MS = 10000;
const STORE_CAPACITY_CODE = 'peer_store_capacity';
const RESULTS = new Set(['new', 'recover', 'completed']);
const CAPACITY_CLASSES = new Set(['general', 'purchase']);
const GENERAL_CAPACITY = Object.freeze({ class: 'general', allocationId: null });
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const fail = (code, status) => { throw new SellerTransportError(code, status); };
/** The key a request's accounting row is stored under: the hash of its buyer, seller, profile and nonce. */
export const requestNonceKey = (payload) => sha256Hex(canonicalize({ buyer: payload.buyer, seller: payload.seller, profile: payload.profile, nonce: payload.nonce }));
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
      const key = requestNonceKey(payload);
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

// What step 5 charges for a classification: a purchase unit for a purchase stage, a general one otherwise. A completed operation
// at capacity has no unit to charge and is answered by P11d2 after revalidating its source, so here it is refused like exhaustion.
function chargedClass(classified) {
  if (classified.class === 'purchase-stage') return { class: 'purchase', allocationId: classified.allocationId };
  if (classified.class === 'general') return GENERAL_CAPACITY;
  if (classified.class === 'completed-at-capacity') return fail(STORE_CAPACITY_CODE, 503);
  return fail('wire_input_invalid', 500);
}

/**
 * Compose the reservation coordinator (K5 step 5, DC24) over the accounting, the purchase capacity and `inspectOperation(payload)`, the
 * synchronous read-only wire inspection of the payload's operation. `admissionTransaction`, when given, validates the job lease the
 * context route borrows. Returns an object with reserveCoordinated and addPreAccountingGate; throws a TypeError when a port is missing or
 * unusable. The capacity supplies the terminal check (`terminalSession`) and the pending-observation barrier it forwards from the store.
 */
export function createReservationCoordinator({ accounting, capacity, inspectOperation, admissionTransaction }) {
  if (typeof accounting?.reserveAccounted !== 'function' || typeof capacity?.classify !== 'function' || typeof capacity.recordExhaustion !== 'function'
      || typeof capacity.terminalSession !== 'function' || typeof capacity.flushTerminalObservations !== 'function'
      || typeof inspectOperation !== 'function' || (admissionTransaction != null && typeof admissionTransaction.requireJobLease !== 'function')) {
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
      void acquiring.then((release) => release());
      throw new SellerTransportError('seller_effect_pending', 503, { cause });
    }
  }
  // The context route runs inside the job's effect mutex, which its caller owns and releases; every other route takes its operation's.
  async function enter({ payload, operationId }, ownership) {
    if (payload.path !== PATHS.context) {
      if (ownership !== undefined) throw new TypeError('only the context route runs under a borrowed job lease');
      return acquireWithinDeadline(operationId);
    }
    if (admissionTransaction == null) throw new TypeError('a context reservation needs the admission transaction that owns the job mutex');
    admissionTransaction.requireJobLease(ownership?.jobLease, payload.jobId);
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
  // K5's pre-accounting order: a terminal session refuses, then each gate may, unless this very operation already completed under the
  // request's binding, whose source-verified replay stays available.
  function refuseBeforeAccounting({ payload, route }, inspection) {
    if (inspection?.state === 'completed' && inspection.binding === wireOperationBinding(payload)) return;
    if (capacity.terminalSession(payload.jobId).terminal) fail('context_session_terminal', 409);
    refuseByGates(Object.freeze({ route, jobId: payload.jobId, payload, inspection }));
  }
  async function reserveUnderMutex({ retainedWork, ...accounted }) {
    const { payload, route } = accounted;
    const inspection = inspectOperation(payload);
    capacity.flushTerminalObservations();
    refuseBeforeAccounting(accounted, inspection);
    let refusal = null;
    const checkCapacityWithin = () => {
      let classified;
      try {
        classified = capacity.classify({ jobId: payload.jobId, buyer: payload.buyer, seller: payload.seller, listingPin: payload.listingPin,
          route, binding: wireOperationBinding(payload), inspection, retainedWork });
      } catch (error) {
        if (error?.code === STORE_CAPACITY_CODE) refusal = error;
        throw error;
      }
      return chargedClass(classified);
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
     * row, unit or file; peer_store_capacity 503 where the class has no capacity, after its exhaustion record; wire_input_invalid 500
     * for malformed input; a TypeError for a context request without a live lease of its job or any other route given one;
     * otherwise the inspection's, accounting's or reservation's own error.
     */
    async reserveCoordinated(input = {}, ownership) {
      assertKitOperationAdmitted('reserveCoordinated');
      const { payload, route, operationId, retainedWork } = input;
      if (payload === null || typeof payload !== 'object' || route !== payload.path || operationId !== wireOperationId(payload) || typeof retainedWork !== 'boolean') {
        fail('wire_input_invalid', 500);
      }
      const release = await enter(input, ownership);
      try { return await reserveUnderMutex(input); } finally { release(); }
    },
  };
}
