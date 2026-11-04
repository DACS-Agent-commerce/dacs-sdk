// K1's admission transaction for a context start: D2-D5 (intent, policy hold, acceptance, wire reservation), the fenced
// completion D7/D8a-c, C1's CAS and the per-job effect mutex. Nothing calls it until P12b1 wires the context route into it;
// compensation after C1, the sweep, release retries and the read-only admission record are P09bb's.
import { randomUUID } from 'node:crypto';
import { canonicalize, compositeVerificationAddress, isCanonicalClaimReference, isCanonicalJobId, sameCanonicalClaimIdentity, sha256Hex } from '@kynesyslabs/dacs';
import { isTp1WireProfile, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall } from './bounded-call.mjs';
import { SELLER_CONTEXT_PATH, SellerTransportError, pinValid, sellerStoreInternals } from './seller-transport-auth.mjs';
import { SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';

const ACQUIRE_TIMEOUT_MS = 10_000;
const POLICY_HOLD_WRITES = 2;
const LIVE_STATES = ['intent', 'admitted', 'running'];
const HASH = /^[0-9a-f]{64}$/;

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

/**
 * Creates the admission transaction on the shared store `createSellerTransportStore` returned, in its one SQLite transaction owner.
 * `policy` is `createSellerContextAdmission`'s `{ reserve, release }`; `completeWire(effect, outcome)` is synchronous and completes only
 * the wire effect handle it is given; `capacity` is null or `{ fitsNewPurchase, allocateWithin }`, whose allocation runs as the first
 * acceptance hook; `now` and `ready` are synchronous; `deadlines.policyMs` bounds the policy call.
 * `effectEvidence` and `inspectContextOutcome` are required ports that only P09bb uses.
 * `begin(request)` is D2-D4: it resolves `{ jobId, rev }` once the intent, the policy hold and the acceptance are durable.
 * `reserveContext(jobId, reserveWire)` is D5: it resolves the wire's completed result (which grants no capability; its source is the
 * caller's to revalidate) or the attempt's capability
 * `{ effect, operationId, attempt, rev, complete(outcome, { jobLease }) }`. `runningCheck(jobId, attempt, rev)` is the synchronous D6 fence.
 * `jobEffectMutex(jobId)` is `{ acquire(), run(work) }` over opaque leases. `addAcceptanceHook(hook)` registers a synchronous hook that
 * runs inside D4's transaction and refuses by throwing; the first `begin` seals registration.
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
  // The live-begin owners: the one `begin` per job that is between D2's commit and the end of its D3/D4 work, late policy settlement and
  // failure recording included. Closure-private: only `ownedIntent`, for the sweep in P09bb, reads it, and no age or lease stands in for it.
  const liveBegins = new Map();
  const ownedIntent = (jobId, rev) => liveBegins.get(jobId)?.rev === rev;
  let hooksSealed = false;
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

  // A request checked without touching the store: its detached copy and the row's immutable binding to the wire operation and the Vet parties.
  function startRow(request, time) {
    if (!isRecord(request) || !isRecord(request.accepted)) throw new TypeError('begin needs a request that carries the accepted challenge record');
    if (Object.hasOwn(request.accepted, 'admittedAt')) throw new TypeError('begin stamps admittedAt itself: the caller supplies none');
    const input = structuredClone(request);
    const { jobId, buyer, seller, listingPin, nonce, presentationHash, contextScopeHash, owner, delegationExpiresAt, purchaseProfile, sellerBundlePresentedBy } = input;
    const presenter = bundlePresenter(input.accepted.buyerBundleText, presentationHash, nonce);
    if (!isCanonicalJobId(jobId) || ![nonce, presentationHash, contextScopeHash].every(isHash) || !isRecord(owner) || !pinValid(listingPin)
      || ![buyer, seller, sellerBundlePresentedBy].every(isCanonicalClaimReference) || !isTp1WireProfile(purchaseProfile)
      || (delegationExpiresAt !== null && !isUint(delegationExpiresAt)) || presenter === null
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
  // D8b and D8c: release the hold (idempotent at the policy), then clear releasePending. A failed release keeps it, with cause and count.
  async function releaseHold(row) {
    const change = (patch) => transaction(() => { const current = read(row.jobId); update(current, { cleanup: { ...current.cleanup, ...patch(current.cleanup) } }); });
    try { await policy.release({ jobId: row.jobId, hold: row.holdId }); }
    catch (cause) { change((cleanup) => ({ cause: storedCause(cause), tries: cleanup.tries + 1 })); return; }
    change(() => ({ releasePending: false, cause: null }));
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
  // What the deadline outran: the call's own end is awaited under the lease, and a hold it appended late is released.
  async function settleLateCall({ jobId }, call, error) {
    await call.settled;
    const uncertain = error.code === 'seller_budget_unavailable';
    const row = transaction(() => {
      const current = read(jobId);
      return update(current, { cleanup: { ...current.cleanup, holdCall: 'settled', releasePending: current.cleanup.releasePending || uncertain,
        cause: uncertain ? storedCause(error.cause ?? error) : current.cleanup.cause } });
    });
    if (uncertain) await releaseHold(row);
  }
  // D3 and D4 under the job lease. The caller's answer settles as soon as D4 or its failure is recorded; the lease is held on until a
  // policy call that the deadline outran has settled, so neither cleanup nor a later reserve can race a late hold.
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
      if (call !== null) await settleLateCall(input, call, error);
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
  // attempt null (nothing was signed) and answers closed.
  async function reserveUnderLease(jobId, reserveWire, lease) {
    const row = read(jobId);
    if (row === null || !['admitted', 'running'].includes(row.state)) fail('context_admission_closed');
    let effect;
    try { effect = await reserveWire(lease); } catch (error) {
      if (error?.code === 'peer_operation_mismatch') transaction(() => fenceWithin(jobId, row.rev, error));
      throw error;
    }
    if (effect?.state === 'completed') return effect;
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
    return transaction(() => update(row, { state: 'settled', cleanup: { ...row.cleanup, releasePending: true } }));
  }
  // The completion the capability carries, on its own handle only. A caller that holds the job lease passes it: complete then neither
  // acquires nor releases it, and D8b runs once the lease ends. Otherwise complete takes the lease itself and releases it before D8b.
  async function complete(issued, effect, outcome, ownership) {
    const borrowed = ownership === undefined ? null : heldLease(ownership?.jobLease, issued.jobId);
    const lease = borrowed === null ? await jobEffectMutex(issued.jobId).acquire() : null;
    let settled;
    try { settled = publish(issued, effect, outcome); } finally { lease?.release(); }
    if (settled === null) return;
    // A lost callback leaves releasePending durable, which the sweep retries.
    if (borrowed !== null) borrowed.afterRelease.push(() => { void releaseHold(settled).catch(() => {}); });
    else await releaseHold(settled);
  }

  return Object.freeze({ begin, reserveContext, runningCheck, jobEffectMutex,
    addAcceptanceHook(hook) {
      if (hooksSealed || typeof hook !== 'function') throw new TypeError('an acceptance hook is a synchronous function registered before the first begin');
      acceptanceHooks.push(hook);
    } });
}
