// K1's admission transaction for a context start: D2-D5 (intent, policy hold, acceptance, wire reservation), the fenced
// completion D7/D8a-c, compensation C1-C4 with its outcome-first settlement, durable hold release, the sweep and the read-only
// admission record. Nothing calls it until P12b1 wires the context route into it, schedules the sweep and ties `cleanupPending()` to readiness.
// P11d3 later extends the C3 evidence kinds beyond `no-intent` and `proven-unsigned`; until then every other kind stays undetermined.
import { randomUUID } from 'node:crypto';
import { canonicalize, compositeVerificationAddress, isAttestationRef, isCanonicalClaimReference, isCanonicalJobId, sameCanonicalClaimIdentity, sha256Hex } from '@kynesyslabs/dacs';
import { isTp1WireProfile, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { SELLER_CONTEXT_PATH, SellerTransportError, pinValid, sellerStoreInternals } from './seller-transport-auth.mjs';
import { SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';

const ACQUIRE_TIMEOUT_MS = 10_000, POLICY_HOLD_WRITES = 2;
const LIVE_STATES = ['intent', 'admitted', 'running'], HASH = /^[0-9a-f]{64}$/;
// The rows whose context outcome a pass inspects first, and the most one sweep waits on one row's pass before it moves on.
const OUTCOME_STATES = ['admitted', 'running', 'compensating'], SWEEP_ROW_TIMEOUT_MS = 30_000;
const DELEGATION_GRACE_MS = 30_000;
// C3 kinds that prove no effect; every other kind, absence and age included, is undetermined.
const NO_EFFECT_KINDS = ['no-intent', 'proven-unsigned'];
// K1's triggers (a) to (d) and the cause each leaves on the fenced row.
const TRIGGER_CODES = { a: 'context_start_failed', b: 'peer_operation_mismatch', c: 'context_delegation_grace', d: 'context_operator_abort' };
const ORPHANED_INTENT_CODE = 'context_intent_orphaned';
const PARTY_VET_NON_PASS = 'party_vet_non_pass';
// Cleanup state by row state, as `cleanup = { releasePending, holdCall, cause, tries }`:
//   intent: holdCall none or pending | admitted, running: settled | compensating: none, pending or settled; releasePending false in all four
//   aborted, settled: holdCall none or settled, never pending; releasePending true until a release succeeds (or no D3 call ever started)
// Open work is a compensating row, a pending release or a pending D3 call. `cause` is the last failure of the last pass over the row,
// `tries` counts failed releases; the next pass that finishes clears the cause, so it holds readiness false only while the failure lasts.
const OPEN_CLEANUP = `json_extract(record, '$.cleanup.releasePending') = 1 OR json_extract(record, '$.cleanup.holdCall') = 'pending'
  OR json_extract(record, '$.cleanup.cause') IS NOT NULL`;

// Per transaction instance: the live-begin reader below, kept off the frozen API so that nothing outside the module can take it for authority.
const instanceReaders = new WeakMap();

const isHash = (value) => typeof value === 'string' && HASH.test(value);
const isUint = (value) => Number.isSafeInteger(value) && value >= 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 409, cause) => { throw new SellerTransportError(code, status, cause === undefined ? undefined : { cause }); };
// An error that names its own refusal (a seller or wire error: a code and an HTTP error status) keeps it; any other local error is an uncertain operation.
const refusalOf = (error) => (typeof error?.code === 'string' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
  ? { code: error.code, status: error.status } : { code: 'operation_uncertain', status: 503 });
const storedCause = (cause) => ({ ...refusalOf(cause), message: cause?.message ?? String(cause) });
// boundedCall answers at the deadline or at the work's end, whichever is first. A late hold or lease needs the work's own end too, so
// that is kept beside it: `result` is the bounded answer, `settled` the work's status object (it never rejects, and is no proof of success).
function boundedWork(work, options) {
  let started;
  const result = boundedCall(() => { started = new Promise((resolve) => resolve(work())); return started; }, options);
  const settled = started.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
  return { result, settled };
}
// The presenter of a retained bundle text, only when the text is the very presentation that was attempted.
function bundlePresenter(text, presentationHash, nonce) {
  try {
    const bundle = JSON.parse(text);
    const exact = isRecord(bundle) && sha256Hex(canonicalize(bundle)) === presentationHash && bundle.sessionNonce === nonce;
    return exact && isCanonicalClaimReference(bundle.presentedBy) ? bundle.presentedBy : null;
  } catch { return null; }
}
const namesVetRecord = (party) => isAttestationRef(party?.vetRecordRef);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
// The statuses the buyer's reader turns into a named refusal from the `{ error }` envelope (seller-http.mjs); 408 and 429 are retryable, never a refusal.
const isRefusalStatus = (status) => Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408 && status !== 429;
// SA-8's class of a completed context outcome, from the exact stored response `{ status, text }` read as the buyer reads it, and never by the
// absence of a refusal. `success` is only status 200 with exactly `{ disposition: 'present', value: { input, scope } }`, the scope hashing to the
// row's contextScopeHash, for the row's job, naming both Vet records by exact signed-record references. `vet-non-pass` is the explicit
// `party_vet_non_pass` rejection at status 200, or that `error` alone in the envelope of a refusal status; everything else, a text that is no
// JSON object or a status the buyer would not read as that answer included, is `other`.
function contextOutcomeClass(row, outcome) {
  let answer;
  try { answer = JSON.parse(outcome?.text); } catch { return 'other'; }
  if (!isRecord(answer)) return 'other';
  if (isRefusalStatus(outcome.status)) return answer.disposition === undefined && answer.error === PARTY_VET_NON_PASS ? 'vet-non-pass' : 'other';
  if (outcome.status !== 200) return 'other';
  if (answer.disposition === 'rejected') return answer.code === PARTY_VET_NON_PASS ? 'vet-non-pass' : 'other';
  if (answer.disposition !== 'present' || !hasExactKeys(answer, ['disposition', 'value']) || !hasExactKeys(answer.value, ['input', 'scope'])) return 'other';
  const { scope, input } = answer.value;
  try {
    return input?.jobId === row.jobId && namesVetRecord(input.buyer) && namesVetRecord(input.seller) && sha256Hex(canonicalize(scope)) === row.contextScopeHash ? 'success' : 'other';
  } catch { return 'other'; }
}

/**
 * Creates the admission transaction on the shared store `createSellerTransportStore` returned, in its one SQLite transaction owner.
 * `policy` is `createSellerContextAdmission`'s `{ reserve, release }`; `completeWire(effect, outcome)` is synchronous and completes only
 * the wire effect handle it is given; `capacity` is null or `{ fitsNewPurchase, allocateWithin }`, whose allocation runs as the first
 * acceptance hook; `now` and `ready` are synchronous; `deadlines.policyMs` bounds the policy call.
 * `inspectContextOutcome(jobId)` is the wire's synchronous, read-only operation view; `effectEvidence(row)` resolves one `{ address, kind, cause? }` per
 * Vet sink address (C3; only `no-intent` and `proven-unsigned` on both retained presenter addresses prove no effect).
 * `begin(request)` is D2-D4: it resolves `{ jobId, rev }` once the intent, the policy hold and the acceptance are durable. A D3 or D4 failure
 * is rejected at once and then compensated (C1-C4) under the same lease.
 * `reserveContext(jobId, reserveWire)` is D5: it resolves the wire's completed result (which grants no capability; its source is the
 * caller's to revalidate; the row first settles on the journal's own completed outcome, when it holds one) or the attempt's capability
 * `{ effect, operationId, attempt, rev, complete(outcome, { jobLease }) }`. `runningCheck(jobId, attempt, rev)` is the synchronous D6 fence.
 * `jobEffectMutex(jobId)` is `{ acquire(), run(work) }` over opaque leases. `addAcceptanceHook(hook)` registers a synchronous hook that
 * runs inside D4's transaction and refuses by throwing; the first `begin` seals registration.
 * `compensate(jobId, trigger)` fences the row for trigger `a`, `b`, `c` (only from the delegation's expiry plus 30,000 ms) or `d`, then runs C2-C4 under the
 * job mutex; it settles a completed context outcome, aborts only on proof of no effect, and otherwise keeps the row `compensating` with its cause.
 * It throws TypeError for a job that is not canonical or a trigger that is not one of those four strings; for an unknown job it writes nothing.
 * `sweep({ startup })` is K1's sweep over every unfinished row (the ledger's startup closing first when `startup`). It waits at most 10,000 ms for a
 * row's lease and 30,000 ms for its pass, records a row it could not finish on that row and goes on to the next; it rejects with an AggregateError
 * after visiting every row when it could not record one. A periodic sweep called while one runs answers that one; a startup sweep rejects with
 * TypeError while a begin is live or a sweep runs, and a periodic one leaves a live begin's intent alone. `cleanupPending()` is true while a row is
 * compensating, or holds a pending release, a pending policy call or a cleanup cause. `admissionRecord(jobId)` is the frozen read-only projection, or null.
 * Throws TypeError for an unusable option; operations reject with a SellerTransportError (guard errors keep their own class) that keeps its cause.
 */
export function createContextAdmissionTransaction({ store, policy, capacity = null, effectEvidence, inspectContextOutcome, completeWire, now, ready, deadlines }) {
  const { db, transaction, challenges, admissionCounts, limits } = sellerStoreInternals(store);
  if (![policy?.reserve, policy?.release, effectEvidence, inspectContextOutcome, completeWire, now, ready].every((port) => typeof port === 'function')
    || !Number.isSafeInteger(deadlines?.policyMs) || deadlines.policyMs <= 0
    || (capacity !== null && !['fitsNewPurchase', 'allocateWithin'].every((name) => typeof capacity?.[name] === 'function'))) {
    throw new TypeError('admission needs the store, policy, evidence, completion, clock, readiness and deadline ports');
  }
  const mutexes = new Map(), leases = new WeakMap(), acceptanceHooks = [];
  // The live-begin owners: the one `begin` per job between D2's commit and the end of its D3/D4 work, late policy settlement and failure
  // recording included. Closure-private: P09bb's sweep reads `ownedIntent` from inside this closure, and no age or lease stands in for it.
  const liveBegins = new Map();
  const ownedIntent = (jobId, rev) => liveBegins.get(jobId)?.rev === rev;
  // Jobs whose D3 call is known to have ended while their row still says `pending`: every earlier process's, once a startup sweep holds
  // the state lock, and this process's own when recording the call's end failed. Only these are settled-unknown.
  const endedCalls = new Set();
  let hooksSealed = false, sweeping = null;
  if (capacity !== null) acceptanceHooks.push(({ jobId, buyer, seller, listingPin }) => { capacity.allocateWithin({ jobId, buyer, seller, listingPin }); });

  const read = (jobId) => {
    const found = db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId);
    return found ? JSON.parse(found.record) : null;
  };
  // The CAS: the write lands only on the exact record that was read. A patch that names a state is a state change and so a new rev.
  function update(row, patch) {
    if (!db.inTransaction) throw new TypeError('admission rows change inside a store transaction');
    const next = { ...row, ...patch, rev: patch.state === undefined ? row.rev : row.rev + 1 };
    const changed = db.prepare('UPDATE kit_context_admissions SET state = ?, rev = ?, admittedAt = ?, record = ? WHERE jobId = ? AND record = ?')
      .run(next.state, next.rev, next.admittedAt, JSON.stringify(next), row.jobId, JSON.stringify(row)).changes;
    if (changed !== 1) fail('context_admission_closed');
    return next;
  }
  function clock() {
    const time = now();
    if (!isUint(time) || !isUint(time + SESSION_CHALLENGE_LIFETIME_MS)) fail('peer_clock_invalid', 503);
    return time;
  }

  // The per-job effect mutex. A lease is held until released (idempotent); work queued with `afterRelease` runs once it ends.
  function jobEffectMutex(jobId) {
    if (!isCanonicalJobId(jobId)) throw new TypeError('the job mutex needs a canonical job');
    async function acquire() {
      const previous = mutexes.get(jobId) ?? Promise.resolve();
      let open;
      const gate = new Promise((resolve) => { open = resolve; });
      const tail = previous.then(() => gate);
      mutexes.set(jobId, tail);
      void tail.then(() => { if (mutexes.get(jobId) === tail) mutexes.delete(jobId); });
      await previous;
      const held = { jobId, held: true, afterRelease: [] };
      const lease = Object.freeze({ release() {
        if (!held.held) return;
        held.held = false; open();
        for (const work of held.afterRelease.splice(0)) work();
      } });
      leases.set(lease, held);
      return lease;
    }
    return Object.freeze({ acquire, async run(work) {
      const lease = await acquire();
      try { return await work(lease); } finally { lease.release(); }
    } });
  }
  function heldLease(lease, jobId) {
    const held = leases.get(lease);
    if (held?.held !== true || held.jobId !== jobId) throw new TypeError('the job lease is not a live lease of this job');
    return held;
  }

  // D2's dry check and D4's authoritative one: readiness, the context-record and unpaid-start limits, then purchase capacity.
  function checkLimits(buyer, ownRow) {
    if (ready() !== true) fail('seller_not_ready', 503);
    const counts = admissionCounts();
    if (counts.contextRecords - Number(ownRow) >= limits.maxContextRecords) fail('peer_context_capacity', 503);
    if (counts.starts >= limits.maxStartsPerHour) fail('unpaid_start_limit', 429);
    if (counts.buyerStarts(buyer) >= limits.maxStartsPerBuyerPerHour) fail('buyer_unpaid_start_limit', 429);
    if (capacity !== null && capacity.fitsNewPurchase() !== true) fail('seller_not_ready', 503);
  }
  function requireOwner({ nonce, jobId, buyer, presentationHash, owner }) {
    const challenge = challenges.retained(nonce);
    if (challenge?.state !== 'attempted' || challenge.jobId !== jobId || !sameCanonicalClaimIdentity(challenge.buyer, buyer)
      || challenge.presentationHash !== presentationHash || challenge.owner?.generation !== owner.generation || challenge.owner?.attemptId !== owner.attemptId) fail('context_challenge_attempt_invalid');
  }

  // The ledger reads the seller and the Listing from the admission itself, so only here are they held to the row's own.
  const admissionNames = (admission, seller, listingPin) => {
    const sellers = Array.isArray(admission?.participants) ? admission.participants.filter((entry) => entry?.role === 'seller') : [];
    return sellers.length === 1 && sameCanonicalClaimIdentity(sellers[0].claim, seller) && pinValid(admission.listingPin) && canonicalize(admission.listingPin) === canonicalize(listingPin);
  };
  // A request checked without touching the store: its detached copy and the row's immutable binding to the wire operation and the Vet parties.
  function startRow(request, time) {
    if (!isRecord(request) || !isRecord(request.accepted)) throw new TypeError('begin needs a request that carries the accepted challenge record');
    if (Object.hasOwn(request.accepted, 'admittedAt')) throw new TypeError('begin stamps admittedAt itself: the caller supplies none');
    const input = structuredClone(request);
    const { jobId, buyer, seller, listingPin, nonce, presentationHash, contextScopeHash, owner, delegationExpiresAt, purchaseProfile, sellerBundlePresentedBy } = input;
    const presenter = bundlePresenter(input.accepted.buyerBundleText, presentationHash, nonce);
    if (!isCanonicalJobId(jobId) || ![nonce, presentationHash, contextScopeHash].every(isHash) || !isRecord(owner) || !pinValid(listingPin)
      || ![buyer, seller, sellerBundlePresentedBy].every(isCanonicalClaimReference) || !isTp1WireProfile(purchaseProfile)
      || (delegationExpiresAt !== null && !isUint(delegationExpiresAt)) || presenter === null || !admissionNames(input.accepted.admission, seller, listingPin)
      || !sameCanonicalClaimIdentity(presenter, buyer) || !sameCanonicalClaimIdentity(sellerBundlePresentedBy, seller)) fail('context_challenge_attempt_invalid');
    const vetPresenters = { buyer: presenter, seller: sellerBundlePresentedBy };
    return { input, row: { jobId, buyer, seller, listingPin, contextScopeHash, nonce, presentationHash, holdId: randomUUID(), state: 'intent', rev: 1, compensation: null,
      cleanup: { releasePending: false, holdCall: 'none', cause: null, tries: 0 }, createdAt: time, admittedAt: null, attempt: null, attemptFence: null, delegationExpiresAt, contextOutcome: null,
      contextBinding: wireOperationBinding({ profile: purchaseProfile, buyer, agreementHash: contextScopeHash }), vetPresenters,
      vetAddresses: { buyer: compositeVerificationAddress(jobId, vetPresenters.buyer), seller: compositeVerificationAddress(jobId, vetPresenters.seller) } } };
  }

  // C1: the exact revision of an `intent`, `admitted` or `running` row becomes `compensating`; on a row already compensating for that
  // revision it changes nothing. Returns whether the row is compensating for `rev + 1`. Runs in the caller's transaction.
  function fenceWithin(jobId, rev, cause) {
    const row = read(jobId);
    if (row?.state === 'compensating') return row.compensation.rev === rev + 1;
    if (row === null || row.rev !== rev || !LIVE_STATES.includes(row.state)) return false;
    update(row, { state: 'compensating', compensation: { rev: rev + 1, proof: null, evidence: null, cause: storedCause(cause) } });
    return true;
  }
  // A D3 or D4 failure: C1 on the row and the owning challenge's `failed`, together. The hold, if any, is compensation's.
  function recordStartFailure({ jobId, owner, nonce }, error) {
    const { code, status } = refusalOf(error);
    transaction(() => {
      const row = read(jobId);
      if (row !== null) fenceWithin(jobId, row.rev, error);
      challenges.recordFailedWithin(owner, nonce, code, status);
    });
  }
  // Changes only a row's cleanup notes, on the row as it now stands; `change(cleanup)` answers the fields to set, or null to write nothing.
  function patchCleanup(jobId, change) {
    return transaction(() => {
      const current = read(jobId), next = current === null ? null : change(current.cleanup);
      return next === null ? current : update(current, { cleanup: { ...current.cleanup, ...next } });
    });
  }
  const noteCause = (jobId, cause) => { patchCleanup(jobId, () => ({ cause: storedCause(cause) })); };
  const clearCause = (jobId) => { patchCleanup(jobId, (cleanup) => (cleanup.cause === null ? null : { cause: null })); };
  // D8b/D8c and C4b/C4c: release the hold by its holdId (idempotent at the policy) within the policy deadline, then clear releasePending
  // and the cause. A failure, a late one included, only counts a try with its cause, and only while the row still has releasePending: a
  // completion's release and a sweep's can overlap. A hold whose D3 call never started is cleared without a policy line. Answers whether
  // nothing is left to release.
  async function releaseHold(jobId) {
    const row = read(jobId);
    if (row?.cleanup.releasePending !== true) return true;
    if (row.cleanup.holdCall !== 'none') {
      try { await boundedCall(() => policy.release({ jobId, hold: row.holdId }), { timeoutMs: deadlines.policyMs }); } catch (cause) {
        patchCleanup(jobId, (cleanup) => (cleanup.releasePending ? { cause: storedCause(cause), tries: cleanup.tries + 1 } : null));
        return false;
      }
    }
    patchCleanup(jobId, () => ({ releasePending: false, cause: null }));
    return true;
  }

  // D2: the intent commits in one transaction, or its refusal fails the owning challenge alone and nothing else is written.
  // A job that already has a row is refused without touching the challenge: its owner may still be validating.
  function commitIntent(input, row) {
    const refusal = transaction(() => {
      if (read(row.jobId) !== null) fail('context_job_closed');
      try {
        requireOwner(input); checkLimits(input.buyer, false);
      } catch (error) {
        const { code, status } = refusalOf(error);
        challenges.recordFailedWithin(input.owner, input.nonce, code, status);
        return error;
      }
      db.prepare('INSERT INTO kit_context_admissions VALUES (?, ?, ?, ?, ?, ?)').run(row.jobId, row.buyer, null, row.state, row.rev, JSON.stringify(row));
      return null;
    });
    if (refusal !== null) throw refusal;
  }
  function markHoldCall(jobId, rev) {
    transaction(() => {
      const row = read(jobId);
      if (row?.state !== 'intent' || row.rev !== rev) fail('context_admission_closed');
      update(row, { cleanup: { ...row.cleanup, holdCall: 'pending' } });
    });
  }
  async function awaitHold(call) {
    let answer;
    try { answer = await call.result; } catch (cause) { fail('seller_budget_unavailable', 503, cause); }
    if (typeof answer === 'string') fail('seller_budget_refused', 409, answer);
    if (answer !== null) fail('seller_budget_unavailable', 503, new TypeError('the policy answered neither null nor a refusal'));
  }
  function runAcceptanceHook(hook, input) {
    const result = hook(structuredClone(input));
    if (result === undefined) return;
    if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
    throw new TypeError('an acceptance hook runs synchronously and returns nothing');
  }
  // D4: acceptance, the start's `admittedAt`, the limits' authoritative re-check and every hook commit together or not at all.
  function acceptAdmission(input, rev) {
    return transaction(() => {
      const row = read(input.jobId), time = clock();
      if (row?.state !== 'intent' || row.rev !== rev) fail('context_admission_closed');
      requireOwner(input); checkLimits(input.buyer, true);
      const admitted = update(row, { state: 'admitted', admittedAt: time, cleanup: { ...row.cleanup, holdCall: 'settled' } });
      const accepted = { ...input.accepted, admittedAt: time, firstAdmission: { ...input.accepted.firstAdmission, checkedAt: time } };
      if (!challenges.acceptWithin(input.owner, input.nonce, accepted)) fail('context_admission_closed');
      for (const hook of acceptanceHooks) runAcceptanceHook(hook, input);
      return Object.freeze({ jobId: admitted.jobId, rev: admitted.rev });
    });
  }
  // What the deadline outran: the call's own end is awaited under the lease, so compensation sees its result. When recording that end
  // fails, the end is still known to this process, and a later pass settles it.
  async function settleLateCall({ jobId }, call) {
    await call.settled;
    try { patchCleanup(jobId, () => ({ holdCall: 'settled' })); } catch (fault) { endedCalls.add(jobId); throw fault; }
  }
  // D3 and D4 under the job lease. The caller's answer settles as soon as D4 or its failure is recorded; the lease is held on until a
  // policy call that the deadline outran has settled, so neither cleanup nor a later reserve can race a late hold. A failure is then
  // compensated under that same lease (C2 to C4).
  async function admit(input, intent, answer) {
    let call = null;
    try {
      markHoldCall(input.jobId, intent.rev);
      call = boundedWork(() => policy.reserve({ jobId: input.jobId, effect: wireOperationId({ seller: input.seller, jobId: input.jobId, path: SELLER_CONTEXT_PATH }),
        writes: POLICY_HOLD_WRITES, hold: intent.holdId }), { timeoutMs: deadlines.policyMs });
      await awaitHold(call);
      answer.resolve(acceptAdmission(input, intent.rev));
    } catch (error) {
      let fault = null;
      try { recordStartFailure(input, error); } catch (storeFault) { fault = storeFault; }
      answer.reject(fault ?? error);
      if (call !== null) await settleLateCall(input, call);
      await reconcile(input.jobId);
    }
  }
  async function begin(request) {
    assertKitOperationAdmitted('begin');
    hooksSealed = true;
    const { input, row } = startRow(request, clock());
    commitIntent(input, row);
    // Registered in the turn the intent commits, with no await between; only this begin's own compare-and-delete removes it.
    const owner = { rev: row.rev, token: Symbol('live begin') };
    liveBegins.set(input.jobId, owner);
    return new Promise((resolve, reject) => {
      void jobEffectMutex(input.jobId).run(() => admit(input, row, { resolve, reject })).catch(reject)
        .finally(() => { if (liveBegins.get(input.jobId)?.token === owner.token) liveBegins.delete(input.jobId); });
    });
  }

  async function acquireBounded(mutex) {
    const acquisition = boundedWork(() => mutex.acquire(), { timeoutMs: ACQUIRE_TIMEOUT_MS });
    try { return await acquisition.result; } catch (cause) {
      void acquisition.settled.then((late) => { if (late.status === 'fulfilled') late.value.release(); });
      return fail('seller_effect_pending', 503, cause);
    }
  }
  // D5 under the lease: the wire reserves once, then the exact revision moves to the issued attempt. Losing that CAS to C1 ends the
  // attempt null (nothing was signed) and answers closed. A completed answer is reconciled under the same lease before it is returned,
  // so the row settles on the journal's own completed outcome where the answer arrives and never waits for a sweep.
  async function reserveUnderLease(jobId, reserveWire, lease) {
    const row = read(jobId);
    if (row === null || !['admitted', 'running'].includes(row.state)) fail('context_admission_closed');
    let effect;
    try { effect = await reserveWire(lease); } catch (error) {
      if (error?.code === 'peer_operation_mismatch') transaction(() => fenceWithin(jobId, row.rev, error));
      throw error;
    }
    if (effect?.state === 'completed') { await reconcile(jobId); return effect; }
    if (!['new', 'recover'].includes(effect?.state) || !isHash(effect.operationId) || !isUint(effect.attempt)) throw new TypeError('the wire reservation is neither new, recover nor completed');
    const running = transaction(() => {
      const current = read(jobId);
      if (current?.rev !== row.rev || current.state !== row.state) return null;
      return update(current, { state: 'running', attempt: effect.attempt, attemptFence: effect.attempt === row.attempt ? row.attemptFence : 'open' });
    });
    if (running === null) {
      let cause;
      try { completeWire(effect, null); } catch (error) { cause = error; }
      fail('context_admission_closed', 409, cause);
    }
    const issued = Object.freeze({ jobId, attempt: effect.attempt, rev: running.rev });
    return Object.freeze({ effect, operationId: effect.operationId, attempt: effect.attempt, rev: running.rev, complete: (outcome, ownership) => complete(issued, effect, outcome, ownership) });
  }
  async function reserveContext(jobId, reserveWire) {
    assertKitOperationAdmitted('reserveContext');
    if (typeof reserveWire !== 'function') throw new TypeError('context reservation needs the admitted wire reserve');
    const lease = await acquireBounded(jobEffectMutex(jobId));
    try { return await reserveUnderLease(jobId, reserveWire, lease); } finally { lease.release(); }
  }

  // D6: true only for the exact running attempt and revision whose fence is not null-ended. Its first true answer latches `open` to
  // `effect-authorized` durably, so that attempt can never end null afterwards. The caller holds the job lease and no transaction.
  function runningCheck(jobId, attempt, rev) {
    assertKitOperationAdmitted('runningCheck');
    if (db.inTransaction) throw new TypeError('runningCheck runs outside any store transaction');
    const row = read(jobId);
    if (row?.state !== 'running' || row.attempt !== attempt || row.rev !== rev || !['open', 'effect-authorized'].includes(row.attemptFence)) return false;
    if (row.attemptFence === 'open') transaction(() => update(row, { attemptFence: 'effect-authorized' }));
    return true;
  }

  // D7 and D8a with no await from the final re-read of the exact running attempt to the commit: C1 and a successor cannot slip in.
  // A null end only latches `null-ended` and publishes (the row stays running); it returns null. Otherwise returns the settled row.
  function publish({ jobId, attempt, rev }, effect, outcome) {
    const row = read(jobId);
    if (row?.state !== 'running' || row.attempt !== attempt || row.rev !== rev) fail('context_admission_closed');
    if (outcome === null) {
      if (!['open', 'null-ended'].includes(row.attemptFence)) fail('context_admission_closed');
      if (row.attemptFence === 'open') transaction(() => update(row, { attemptFence: 'null-ended' }));
      completeWire(effect, null);
      return null;
    }
    if (!['open', 'effect-authorized'].includes(row.attemptFence)) fail('context_admission_closed');
    completeWire(effect, outcome);
    return settleWithin(row, contextOutcomeClass(row, outcome));
  }
  // The completion the capability carries, on its own handle only. A caller that holds the job lease passes it: complete then neither
  // acquires nor releases it, and D8b runs once the lease ends. Otherwise complete takes the lease itself and releases it before D8b.
  async function complete(issued, effect, outcome, ownership) {
    assertKitOperationAdmitted('complete');
    const borrowed = ownership === undefined ? null : heldLease(ownership?.jobLease, issued.jobId);
    const lease = borrowed === null ? await jobEffectMutex(issued.jobId).acquire() : null;
    let settled;
    try { settled = publish(issued, effect, outcome); } finally { lease?.release(); }
    if (settled === null) return;
    // A lost callback leaves releasePending durable, which the sweep retries.
    if (borrowed !== null) borrowed.afterRelease.push(() => { void releaseHold(settled.jobId).catch(() => {}); });
    else await releaseHold(settled.jobId);
  }

  // D8 from `admitted`, `running` or `compensating`: the row settles with the context outcome's class and its hold is released afterwards.
  function settleWithin(row, contextOutcome) {
    return transaction(() => update(row, { state: 'settled', contextOutcome, cleanup: { ...row.cleanup, releasePending: true } }));
  }
  // The context outcome comes first. It is the class of a completed outcome under this row's own binding, or null while there is none.
  // An inspection that fails, or that reports another binding, throws and settles nothing.
  function recordedOutcomeClass(row) {
    const view = inspectContextOutcome(row.jobId);
    if (view?.state === 'none') return null;
    if (!['pending', 'ended', 'completed'].includes(view?.state)) fail('context_outcome_unavailable', 503);
    if (view.binding !== row.contextBinding) fail('context_outcome_binding_mismatch');
    return view.state === 'completed' ? contextOutcomeClass(row, view.outcome) : null;
  }
  // The exact two sink addresses C3 must cover: the retained presenters' composite addresses, checked against the row's parties.
  function sinkAddresses({ jobId, buyer, seller, vetPresenters, vetAddresses }) {
    try {
      const addresses = [['buyer', buyer], ['seller', seller]].map(([role, party]) => {
        if (!sameCanonicalClaimIdentity(vetPresenters[role], party) || compositeVerificationAddress(jobId, vetPresenters[role]) !== vetAddresses[role]) throw new TypeError(`the retained ${role} sink address does not follow its presenter`);
        return vetAddresses[role];
      });
      if (new Set(addresses).size !== addresses.length) throw new TypeError('the buyer and seller sink addresses collide');
      return addresses;
    } catch (cause) { return fail('context_compensation_undetermined', 503, cause); }
  }
  // C3 and C3r: a fresh read, every time. No proof is read from the row, and anything but no-intent or proven-unsigned on both addresses is undetermined.
  async function noEffectEvidence(row) {
    const addresses = sinkAddresses(row);
    let evidence;
    try { evidence = await effectEvidence(structuredClone(row)); } catch (cause) { fail('context_compensation_undetermined', 503, cause); }
    const entries = Array.isArray(evidence) && evidence.length === addresses.length ? evidence : [];
    const byAddress = new Map(entries.map((entry) => [entry?.address, entry]));
    if (byAddress.size !== addresses.length || !addresses.every((address) => NO_EFFECT_KINDS.includes(byAddress.get(address)?.kind))) {
      fail('context_compensation_undetermined', 503, entries.find((entry) => entry?.cause !== undefined)?.cause);
    }
    return addresses.map((address) => ({ address, kind: byAddress.get(address).kind }));
  }
  // C3 (C3r after a restart) to C4a for a compensating row with no completed outcome. The proof and the abort are two commits on the exact
  // revision that was read; the evidence is read fresh every time, so a saved proof never authorizes the abort.
  async function abortOnNoEffect(row) {
    if (row.cleanup.holdCall === 'pending') fail('context_hold_call_pending', 503);
    const evidence = await noEffectEvidence(row);
    const proven = transaction(() => {
      const current = read(row.jobId);
      if (current?.rev !== row.rev || current.state !== 'compensating') fail('context_admission_closed');
      return update(current, { compensation: { ...current.compensation, proof: 'no-effect', evidence } });
    });
    return transaction(() => update(proven, { state: 'aborted', cleanup: { ...proven.cleanup, releasePending: true } }));
  }
  // A pending D3 call whose end is known is settled-unknown: compensation then releases its hold, if it appended one, by holdId.
  function adoptEndedCall(row) {
    if (row?.cleanup.holdCall !== 'pending' || !endedCalls.has(row.jobId)) return row;
    const adopted = patchCleanup(row.jobId, () => ({ holdCall: 'settled' }));
    endedCalls.delete(row.jobId);
    return adopted;
  }
  // The one reconciliation pass over a row, run by a failed begin, a completed wire answer, compensate and the sweep, always under the
  // job lease: adopt an ended D3 call; settle on the context outcome first (D8, never an abort); abort a compensating row only on proof
  // of no effect; then release. A pass that finishes clears the row's cause; one that cannot finish records why and keeps the row.
  async function reconcile(jobId) {
    try {
      let row = adoptEndedCall(read(jobId));
      if (OUTCOME_STATES.includes(row?.state)) {
        const contextOutcome = recordedOutcomeClass(row);
        if (contextOutcome !== null) row = settleWithin(row, contextOutcome);
        else if (row.state === 'compensating') await abortOnNoEffect(row);
      }
      if (await releaseHold(jobId)) clearCause(jobId);
    } catch (cause) { noteCause(jobId, cause); }
  }
  // Trigger (c): the delegation's expiry plus the grace is checked to be a safe integer first. A direct request has no expiry, so no grace trigger.
  function graceElapsed({ delegationExpiresAt }) {
    if (delegationExpiresAt === null) return false;
    const eligibleAt = delegationExpiresAt + DELEGATION_GRACE_MS;
    if (!isUint(eligibleAt)) fail('peer_clock_invalid', 503);
    return clock() >= eligibleAt;
  }
  // C1 for a trigger on a live row, in one transaction with the trigger's own check. Answers whether this call fenced the row. An unsafe
  // trigger (c) sum or seller clock throws `peer_clock_invalid` and fences nothing.
  function fenceForTrigger(jobId, trigger) {
    return transaction(() => {
      const row = read(jobId);
      return LIVE_STATES.includes(row?.state) && (trigger !== 'c' || graceElapsed(row)) && fenceWithin(jobId, row.rev, new SellerTransportError(TRIGGER_CODES[trigger], 409));
    });
  }
  async function compensate(jobId, trigger) {
    assertKitOperationAdmitted('compensate');
    if (!isCanonicalJobId(jobId) || typeof trigger !== 'string' || !Object.hasOwn(TRIGGER_CODES, trigger)) throw new TypeError('compensation needs a canonical job and trigger a, b, c or d');
    try { fenceForTrigger(jobId, trigger); } catch (error) {
      if (error.code !== 'peer_clock_invalid') throw error;
      noteCause(jobId, error);
      return;
    }
    await jobEffectMutex(jobId).run(() => reconcile(jobId));
  }

  const ownedByLiveBegin = (row) => row?.state === 'intent' && ownedIntent(row.jobId, row.rev);
  // Step 2: an intent nobody is working on is fenced. A periodic pass re-reads it and checks the registry in the one transaction that fences it.
  function fenceOrphanedIntent(jobId, startup) {
    transaction(() => {
      const row = read(jobId);
      if (row?.state === 'intent' && (startup || !ownedByLiveBegin(row))) fenceWithin(jobId, row.rev, new SellerTransportError(ORPHANED_INTENT_CODE, 409));
    });
  }
  // One row of the sweep, with its own lease wait and pass deadline: a row that hangs keeps its lease and its pass, is recorded with its
  // cause, and never holds up the rows after it. Throws only when that record itself cannot be written.
  async function sweepRow(jobId, startup) {
    if (!startup && ownedByLiveBegin(read(jobId))) return;
    let lease;
    try { lease = await acquireBounded(jobEffectMutex(jobId)); } catch (cause) { noteCause(jobId, cause); return; }
    const pass = boundedWork(async () => {
      fenceOrphanedIntent(jobId, startup);
      await reconcile(jobId);
      if (fenceForTrigger(jobId, 'c')) await reconcile(jobId);
    }, { timeoutMs: SWEEP_ROW_TIMEOUT_MS });
    void pass.settled.then(() => lease.release());
    try { await pass.result; } catch (cause) {
      noteCause(jobId, isBoundedCallTimeout(cause) ? new SellerTransportError('context_cleanup_timeout', 503, { cause }) : cause);
    }
  }
  async function sweepPass(startup) {
    if (startup) {
      challenges.closeLostValidations();
      const pending = db.prepare(`SELECT jobId FROM kit_context_admissions WHERE json_extract(record, '$.cleanup.holdCall') = 'pending'`).all();
      for (const { jobId } of pending) endedCalls.add(jobId);
    }
    const unfinished = db.prepare(`SELECT jobId FROM kit_context_admissions WHERE state IN ('intent', 'compensating', 'admitted', 'running') OR ${OPEN_CLEANUP}`).all();
    const faults = [];
    for (const { jobId } of unfinished) {
      try { await sweepRow(jobId, startup); } catch (fault) { faults.push(fault); }
    }
    if (faults.length > 0) throw new AggregateError(faults, 'the sweep could not record the state of every row it visited');
  }
  // Not behind the kit operation guard: the sweep starts no effect, and with the guard off it only finishes the cleanup of rows that exist.
  function sweep(options) {
    const startup = options?.startup;
    if (typeof startup !== 'boolean') return Promise.reject(new TypeError('sweep needs { startup } as a boolean'));
    if (startup && (liveBegins.size > 0 || sweeping !== null)) return Promise.reject(new TypeError('the startup sweep runs before any begin or other sweep'));
    sweeping ??= sweepPass(startup).finally(() => { sweeping = null; });
    return sweeping;
  }
  // A begin that is running is not unfinished cleanup; every other open compensation, release, policy call or cause is.
  function cleanupPending() {
    return db.prepare(`SELECT jobId, state, rev FROM kit_context_admissions WHERE state = 'compensating' OR ${OPEN_CLEANUP}`).all()
      .some((row) => !ownedByLiveBegin(row));
  }
  function admissionRecord(jobId) {
    const row = isCanonicalJobId(jobId) ? read(jobId) : null;
    if (row === null) return null;
    return Object.freeze({ jobId: row.jobId, buyer: row.buyer, seller: row.seller, listingPin: Object.freeze(row.listingPin), contextScopeHash: row.contextScopeHash,
      nonce: row.nonce, presentationHash: row.presentationHash, state: row.state, rev: row.rev, admittedAt: row.admittedAt, contextOutcome: row.contextOutcome });
  }

  const api = Object.freeze({ begin, reserveContext, runningCheck, jobEffectMutex, compensate, sweep, cleanupPending, admissionRecord,
    addAcceptanceHook(hook) {
      if (hooksSealed || typeof hook !== 'function') throw new TypeError('an acceptance hook is a synchronous function registered before the first begin');
      acceptanceHooks.push(hook);
    } });
  instanceReaders.set(api, Object.freeze({ ownedIntent }));
  return api;
}

/** Seller-internal, not on the transaction: one instance's private `ownedIntent(jobId, rev)` (true only while the `begin` that committed that intent revision still works on it), for this package's tests. */
export function admissionTransactionInternals(transaction) {
  const readers = instanceReaders.get(transaction);
  if (readers === undefined) throw new TypeError('admissionTransactionInternals needs a transaction made by createContextAdmissionTransaction');
  return readers;
}
