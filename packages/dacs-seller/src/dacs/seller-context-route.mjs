// Seller-owned Vet and Agreement context over the authenticated transport.
// Admission reserves two writes. Pre-payment writes still require exact
// seller approval. This is the kit's only context mode.
import { identityBundleHash, isCanonicalClaimReference, isCanonicalJobId, isIdentityBundle, sameCanonicalClaimIdentity, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, admitPreAgreementRequest, admitWireRequestBody, inspectWireOperation, wireOperationId } from '@kynesyslabs/dacs/wire';
import { boundedCall } from './bounded-call.mjs';
import { KitOperationGuardError, kitOperationAdmitted } from '../kit-operation-guard.mjs';
import { readStopPredicate } from '../kill-switch.mjs';
import { addressForClaim, isCanonicalEd25519Signature } from './demos-claims.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from './agreement-context-consumer.mjs';
import { DEM_RAIL, canonicalize, purchaseSupport, verifyComponent } from './listing.mjs';
import { listingPin } from './purchase-protocol.mjs';
import { deepFreeze } from './seller-challenge-ledger.mjs';
import { ownsPurchaseCapacity } from './seller-purchase-capacity.mjs';
import { refusalMessage } from './seller-http.mjs';
import { openWireRequest } from './seller-wire-requests.mjs';
import { createContextAttempt } from './seller-context-attempt.mjs';
import { createAcceptedContinuation, createContextOutcomeRevalidation, createContinuationCheck } from './seller-context-continuation.mjs';
import { resumeContext } from './seller-context-recovery.mjs';
import { createPlannedAgreementReader } from './seller-planned-agreement.mjs';
import { SELLER_CONTEXT_SCOPE_KEYS, SellerTransportError, sellerContextChallengeScope, sellerContextScopeHash, sellerStoreInternals } from './seller-transport-auth.mjs';

// The deadline of each buyer-access and known-job callback (DC18).
const POLICY_READ_TIMEOUT_MS = 10_000;
// The seller's clock window for the buyer's generatedAt (seller-agent.mjs).
const GENERATED_AT_SKEW_MS = 10 * 60 * 1000;

// The challenge scope is the context scope without the bundle hash, which only the presentation carries.
const CHALLENGE_SCOPE_KEYS = SELLER_CONTEXT_SCOPE_KEYS.filter((key) => key !== 'buyerBundleHash');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const failureText = (error) => { try { return String(error?.message ?? error); } catch { return 'unreadable error'; } };
const refuse = (code) => { throw new SellerTransportError(code, 409); };
function requireJobId(jobId) {
  if (!isCanonicalJobId(jobId)) refuse('peer_job_invalid');
}
function requireContextJob(request, body) {
  requireJobId(request?.jobId);
  requireJobId(body?.scope?.jobId);
}

/**
 * The final check of K1 issue step 16 for a wire request, which the ledger runs inside its transaction after its own guard and
 * stop checks: the admitted request's expiry, then its delegation's (`null` on a direct request), against the seller clock read
 * again, in the wire's order. Returns the `authorization` the ledger takes; its `assertStillLive()` throws `peer_expired` or
 * `peer_delegation_expired` (408).
 */
const expiryRecheck = (now, request, delegationExpiresAt) => ({
  assertStillLive: () => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || request.expiresAt <= at) throw new SellerTransportError('peer_expired', 408);
    if (delegationExpiresAt !== null && delegationExpiresAt <= at) throw new SellerTransportError('peer_delegation_expired', 408);
  },
});

/**
 * The host's checks that precede admission (K1 issue step 5): the kit guard, then the stop predicate. A predicate that throws
 * counts as stopped with cause `stop_check_failed`, and one that answers a non-boolean (a promise included, whose rejection is
 * then handled) with cause `stop_check_invalid`. Throws `kit_operation_guard_off` or `seller_stopped` (503).
 */
function assertOpenForChallenges(stopped) {
  if (!kitOperationAdmitted()) throw new SellerTransportError('kit_operation_guard_off', 503);
  const stop = readStopPredicate(stopped);
  if (stop.stopped) throw new SellerTransportError('seller_stopped', 503, stop.cause === null ? undefined : { cause: stop.cause });
}

function bundleAuthentic(bundle) {
  try {
    if (!isIdentityBundle(bundle) || bundle.claims.length !== 1 || bundle.claims[0].ref !== bundle.presentedBy) return false;
    const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
    return Boolean(proof && isCanonicalEd25519Signature(proof.signature) && verifyComponent({ signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
      signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
  } catch { return false; }
}

const PARTY_VET_NON_PASS = 'party_vet_non_pass';
const VET_FAILURE_CLASSES = ['counterparty', 'permanent'];

/**
 * A context scope against the host's own values (`seller`, Listing `pin`, purchase `support` and the `now` clock). With a `bundleHash`
 * the scope must also carry it: the challenge scope has none. Returns the refusal code, or null when the scope is admissible.
 */
function scopeTermsProblem(scope, bundleHash, { seller, pin, support, now }) {
  let wallet = null;
  try { wallet = addressForClaim(scope.buyer); } catch { /* refused below */ }
  if (scope.source !== AGREEMENT_CONTEXT_SOURCE || scope.wallet !== wallet || scope.seller !== seller || !same(scope.listingPin, pin)
      || (bundleHash !== null && scope.buyerBundleHash !== bundleHash) || scope.payee !== support.payee || !same(scope.price, support.price)
      || !same(scope.rail, { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion })) return 'context_scope_invalid';
  if (!Number.isSafeInteger(scope.generatedAt) || Math.abs(scope.generatedAt - now()) > GENERATED_AT_SKEW_MS) return 'context_generated_at';
  return null;
}

/**
 * The buyer-access and known-job reads of a context request, each bounded at POLICY_READ_TIMEOUT_MS. A late result grants nothing: this
 * call has already thrown. A policy code keeps its code; a timeout or any other failure is 503 `session_admission_unavailable` with the
 * original error as its cause. Returns `check(request)`, which throws the refusal.
 */
function buyerPolicyCheck({ assertBuyerAccess, knownJob }) {
  async function policyRead(work) {
    try { return await boundedCall(work, { timeoutMs: POLICY_READ_TIMEOUT_MS }); }
    catch (cause) {
      if (['buyer_access_closed', 'context_job_unknown'].includes(cause?.code)) throw new SellerTransportError(cause.code, 409, { cause });
      throw new SellerTransportError('session_admission_unavailable', 503, { cause });
    }
  }
  return async (request) => {
    await policyRead(() => assertBuyerAccess(request.buyer));
    if (knownJob !== null && await policyRead(() => knownJob(request.jobId, request.buyer)) !== true) refuse('context_job_unknown');
  };
}

// What the ledger's attempt takes for a context request: the nonce, the job, the buyer and the hashes of the challenge scope and the presentation.
function challengeAttemptInput(request, body) {
  let presentationHash = null, challengeScopeHash = null;
  try { presentationHash = sha256Hex(canonicalize(body.buyerIdentityBundle)); } catch { /* ledger refuses malformed bytes */ }
  try { challengeScopeHash = sellerContextScopeHash(sellerContextChallengeScope(body.scope)); } catch { /* ledger consumes a mismatched scope */ }
  return { path: 'context', nonce: body.buyerIdentityBundle?.sessionNonce, jobId: request.jobId, buyer: request.buyer, challengeScopeHash, presentationHash };
}

// The seller's route for the context challenge on the wire. Its policy ports are operator capabilities: callback deadlines throw a
// SellerTransportError with the original cause, and invalid options throw a TypeError. The context step itself is
// `createWireSellerContextRoute`.
export function createSellerContextRoute({ listing, assertBuyerAccess, knownJob = null, now = () => Date.now() }) {
  const support = purchaseSupport(listing);
  if (!support.supported || typeof assertBuyerAccess !== 'function' || (knownJob !== null && typeof knownJob !== 'function')) {
    throw new TypeError('the seller context route needs a supported Listing and buyer access');
  }
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing);
  // The challenge scope has no bundle hash; the transport has already bound the job and the buyer, so this checks the rest against the seller's own values.
  const challengeScopeProblem = (scope) => scopeTermsProblem(scope, null, { seller, pin, support, now });
  const checkPolicy = buyerPolicyCheck({ assertBuyerAccess, knownJob });
  return Object.freeze({
    path: PATHS.context,
    challengePath: PATHS.contextChallenge,
    /**
     * The challenge route on the wire (K1 issue steps 1-17, K2 for `contextChallenge`). `wire` is a `createWireContext` context
     * with its stop check; `input` is the raw request: `header`, `method`, `path`, the exact `rawBody` and its parsed `body`, and
     * `onOpened(request)`, called once the envelope is verified so that later refusals can be signed. No Agreement is needed and
     * the wire journal is never written: the ledger's insert is the only write. Returns `{ sessionNonce, expiresAt }`. Throws the
     * refusal, a SellerTransportError or the wire's WireError, with its code, status and cause.
     */
    challengeOnWire: async (wire, { header, method, path, rawBody, body, onOpened }) => {
      const opened = await openWireRequest(wire, header, onOpened);
      const request = opened.payload;
      // K2 compares its route with the signed path as a fault of the host (`wire_input_invalid` 500): a request signed for another path is the peer's.
      if (request.path !== path) throw new SellerTransportError('peer_request_mismatch', 401);
      requireContextJob(request, body);
      if (request.jobId !== body.scope.jobId) refuse('peer_job_mismatch');
      if (!keys(body, ['scope']) || !keys(body.scope, CHALLENGE_SCOPE_KEYS)) refuse('peer_context_mismatch');
      const scopeHash = sellerContextScopeHash(body.scope);
      // Each admission reads the clock, readiness, kept tuple and authority anew.
      const admit = () => admitPreAgreementRequest(opened, { route: 'contextChallenge', binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId),
        seller, listingPin: pin, method, path, rawBody, now: wire.now(), requireDelegation: wire.requireDelegation, ready: wire.ready(),
        retained: { jobId: body.scope.jobId, agreementHash: scopeHash, buyer: body.scope.buyer, seller } });
      try {
        assertOpenForChallenges(wire.stopped);
        const admitted = await admit();
        const problem = challengeScopeProblem(admitted.body.scope);
        if (problem) refuse(problem);
        await checkPolicy(request);
        // The two callbacks above may each take their full deadline, and nothing after this admission awaits: authority, the
        // delegation or readiness that closed meanwhile refuses here, before the ledger's insert.
        const current = await admit();
        return wire.store.challenges.issue(request, scopeHash, expiryRecheck(wire.now, request, current.delegationExpiresAt));
      } catch (error) {
        throw error instanceof KitOperationGuardError ? new SellerTransportError(error.code, 503, { cause: error }) : error;
      }
    },
  });
}

// A refusal's code and status for the answer: a refusal keeps its own, the guard maps to 503 and any other error is an uncertain operation.
// `cause` is the code of the error that caused it, when it names one; the answer carries it inside its message.
function refusalOf(error) {
  const causeCode = typeof error?.cause === 'string' ? error.cause : error?.cause?.code;
  const cause = typeof causeCode === 'string' ? causeCode : undefined;
  if (error instanceof KitOperationGuardError) return { code: error.code, status: 503, message: error.message, cause };
  if (typeof error?.code === 'string' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return { code: error.code, status: error.status, message: failureText(error), cause };
  return { code: 'operation_uncertain', status: 503, message: 'the context operation did not finish and its outcome is not established', cause: typeof error?.code === 'string' ? error.code : cause };
}

// What the provider answered, as the wire outcome it completes with: an exact present answer for the request's scope or an authenticated
// Vet non-pass. Anything else (a held answer included) is no final outcome: operation_uncertain 503 with the answer as its cause.
function providerOutcome(answer, scope) {
  const present = answer?.disposition === 'present' && keys(answer, ['disposition', 'value']) && keys(answer.value, ['input', 'scope'])
    && same(answer.value.scope, scope) && answer.value.input?.jobId === scope.jobId;
  const nonPass = answer?.disposition === 'rejected' && keys(answer, ['disposition', 'reason', 'code', 'errorClass']) && typeof answer.reason === 'string'
    && answer.code === PARTY_VET_NON_PASS && VET_FAILURE_CLASSES.includes(answer.errorClass);
  if (!present && !nonPass) throw new SellerTransportError('operation_uncertain', 503, { cause: answer });
  return { status: 200, text: JSON.stringify(answer) };
}

/**
 * The context route on the wire, for a job's first admission. `handleContext({ rawBody, header, method, path })` serves one request and answers
 * `{ status, text, request }` without signing: `request` is the opened envelope payload for the caller to sign the answer under, or null when
 * no envelope was opened (the answer is then sent unsigned). It never throws for a request it can refuse.
 *
 * The order is: the body's admission and the envelope, the job rules and the body's closed structure, the guard and stop predicate, the wire
 * admission, the nonce attempt, the presentation's validation, the admission transaction's intent, hold and acceptance, the reservation, the
 * provider's work under the job's effect mutex, and the completion. A refusal before the attempt consumes nothing; a failure after it fails the
 * challenge it owns. A reservation refused after the acceptance, and a provider that fails by itself, end the accepted row (compensation
 * trigger a), which releases its hold and slot unless the effect evidence is undetermined; a provider stopped at the deadline or by `closeAttempts`
 * keeps the attempt open. Any other error after the reservation leaves the attempt open and answers `operation_uncertain`, or the 503
 * refusal it carries. The provider's work runs inside `trackContextWork`, which keeps the job's mutex until the work has settled, also
 * after a deadline has answered. A presentation that was already accepted continues: the presented bundle must be the kept one, the kept admission
 * must still bind it (`session_admission_unavailable` 503 otherwise), and buyer access and the known-job check run again; the challenge expiry, the
 * generatedAt window, the profile admission and the start limits are not checked again and no hold or start is made. An `admitted` row is reserved
 * and runs, a settled one answers its stored outcome without a reservation, and a closed one is `context_admission_closed` (409). A running row whose
 * operation completed answers that outcome. One with an unfinished earlier attempt is refused `seller_effect_pending` (503) while that attempt's lease
 * lasts, and afterwards recovered by a new attempt (`resumeContext`): it works from the retained request, reads back the retained Vet records, completes
 * with what they prove or writes only the Vets still missing, and keeps the original hold and start. A recovery that cannot prove what is missing stays
 * open as `operation_uncertain` (503); neither a refused continuation nor a failed recovery ends the row. A row left running is ended by the
 * admission transaction's sweep instead: a direct request's once it is 5 minutes old, a delegated one's once its expiry plus the grace has passed,
 * and any at the host's startup.
 * A stored outcome is answered only after `revalidateContextOutcome({ jobId, outcome })` has read the retained records back through the
 * provider and found the same answer; otherwise it throws `seller_source_unavailable` (503) with its cause and changes nothing. `readPlannedAgreement({ jobId })` (see `createPlannedAgreementReader`) is registered with `wire` for a state read before any session.
 * `closeAttempts(cause)` closes every attempt still running. `store`, `capacity`, `admissionTransaction` and `coordinator` are the host's one
 * instance of each: the tuple is kept inside the acceptance, so the construction registers its hook before the first admission, and throws a
 * TypeError for a missing port, an unsupported Listing, a capacity of another store or a provider pinned to another seller presenter.
 */
export function createWireSellerContextRoute({ listing, wire, store, ledger, admissionTransaction, coordinator, capacity, provider, assertBuyerAccess, knownJob, ready, stopped, now, monotonicNow, trackContextWork }) {
  const support = purchaseSupport(listing);
  const ports = [assertBuyerAccess, ready, stopped, now, monotonicNow, trackContextWork, wire?.admitPresentation, wire?.bindPlannedAgreementReader, coordinator?.reserveCoordinated, admissionTransaction?.begin, ledger?.attempt,
    provider?.resolveBuyer, provider?.bindRetainedScope];
  if (!support.supported || !ports.every((port) => typeof port === 'function') || (knownJob !== null && typeof knownJob !== 'function') || !ownsPurchaseCapacity(store, capacity)) {
    throw new TypeError('the wire context route needs a supported Listing, the wire, its stores, ports and provider, buyer access and clocks');
  }
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing), terms = { seller, pin, support, now };
  const checkPolicy = buyerPolicyCheck({ assertBuyerAccess, knownJob });
  const running = new Set();
  // The refusals of a provider that failed by itself, not one that was stopped at the deadline or by `closeAttempts`.
  const failedProviders = new WeakSet();
  const { db, keepPurchaseProfileWithin } = sellerStoreInternals(store);
  admissionTransaction.addAcceptanceHook(({ jobId, purchaseProfile }) => keepPurchaseProfileWithin(jobId, purchaseProfile));
  const records = createSellerContextRecords({ listing, admission: admissionTransaction.admissionRecord, contextOutcome: completedContextOutcome(wire.journal, seller), acceptedPresentation: (nonce) => ledger.retained(nonce)?.accepted ?? null });
  const revalidateStored = createContextOutcomeRevalidation({ provider, retainedBody: records.retainedBody });
  const { sellerBundlePresentedBy } = provider.bindRetainedScope(records.completedScope);
  if (!sameCanonicalClaimIdentity(sellerBundlePresentedBy, seller)) throw new TypeError('the provider is pinned to a seller presenter other than the Listing\'s');

  // The tuple is kept when the admission is accepted, so a job without one is either not accepted yet (its hold is pending), closed
  // (aborted, fenced before its acceptance, or retired) or, for an open accepted job, a damaged store.
  function refusalWithoutTuple(row) {
    if (row.state === 'intent') return new SellerTransportError('context_attempt_pending', 503);
    const retired = db.prepare('SELECT 1 FROM kit_slot_retirements WHERE job = ? AND job_retired = 1').get(row.jobId) !== undefined;
    if (row.state === 'aborted' || row.admittedAt === null || retired) return new SellerTransportError('context_job_closed', 409);
    return new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
  }

  const continuesAccepted = createContinuationCheck({ ledger, completedOutcomeOf: completedContextOutcome(wire.journal, seller) });

  // Everything before the attempt: a refusal here consumes nothing. Resolves with the wire's admission of the request, whose body is the one to use.
  async function openRequest({ rawBody, header, method, path }, onOpened) {
    const body = admitWireRequestBody(rawBody);
    const opened = await openWireRequest(wire, header, onOpened);
    const request = opened.payload;
    if (request.path !== path) throw new SellerTransportError('peer_request_mismatch', 401);
    requireContextJob(request, body);
    if (request.jobId !== body.scope.jobId) refuse('peer_job_mismatch');
    if (!keys(body, ['scope', 'buyerIdentityBundle']) || !keys(body.scope, SELLER_CONTEXT_SCOPE_KEYS) || !record(body.buyerIdentityBundle)) refuse('peer_context_mismatch');
    assertOpenForChallenges(stopped);
    // First contact retains the host's seller and the body's job and buyer; a job with an admission row retains that row's, and needs its kept tuple.
    const row = admissionTransaction.admissionRecord(request.jobId);
    if (row !== null && wire.tuple(request.jobId) === null) throw refusalWithoutTuple(row);
    if (row === null && !isCanonicalClaimReference(body.scope.buyer)) refuse('peer_agreement_party_mismatch');
    const retained = row === null ? { jobId: request.jobId, agreementHash: sellerContextScopeHash(body.scope), buyer: body.scope.buyer, seller, accepted: false }
      : { jobId: row.jobId, agreementHash: row.contextScopeHash, buyer: row.buyer, seller: row.seller, accepted: continuesAccepted(row) };
    return admitPreAgreementRequest(opened, { route: 'context', binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId), seller, listingPin: pin,
      method, path, rawBody, now: now(), requireDelegation: wire.requireDelegation, ready: ready(), requestJournal: wire.journal, retained });
  }

  // The nonce attempt: this caller owns the challenge until it accepts or fails it, or the presentation was already accepted
  // and the answer carries its retained `accepted` record, to continue from.
  function attemptChallenge(request, body) {
    const input = challengeAttemptInput(request, body), result = ledger.attempt(input);
    if (result.kind === 'refused') throw new SellerTransportError(result.code, result.status, { cause: result.cause });
    if (result.kind === 'continuation') return { accepted: result.accepted };
    return { owner: result.owner, nonce: input.nonce };
  }

  // A stored outcome is read back through the provider before it is answered; an accepted presentation continues without a first admission.
  const revalidateContextOutcome = (input) => { requireJobId(input?.jobId); return revalidateStored(input); };
  const continueAccepted = createAcceptedContinuation({ wire, seller, pin, checkPolicy, admissionRecord: admissionTransaction.admissionRecord, revalidate: revalidateContextOutcome,
    assertLive: (request, delegationExpiresAt) => expiryRecheck(now, request, delegationExpiresAt).assertStillLive() });

  // The owning validation in its order, then the intent, hold and acceptance. Returns once the challenge is accepted.
  async function admitFirstContact(request, { body, delegationExpiresAt }, { owner, nonce }) {
    const bundle = body.buyerIdentityBundle, { scope } = body;
    if (!bundleAuthentic(bundle)) refuse('buyer_bundle_unauthenticated');
    if (!sameCanonicalClaimIdentity(bundle.presentedBy, request.buyer)) refuse('peer_context_mismatch');
    const problem = scopeTermsProblem(scope, identityBundleHash(bundle), terms);
    if (problem) refuse(problem);
    const admission = await wire.admitPresentation({ jobId: request.jobId, bundle, nonce });
    await checkPolicy(request);
    await admissionTransaction.begin({ jobId: request.jobId, buyer: request.buyer, seller: request.seller, listingPin: pin, contextScopeHash: sellerContextScopeHash(scope), nonce,
      presentationHash: sha256Hex(canonicalize(bundle)), owner, sellerBundlePresentedBy, delegationExpiresAt, purchaseProfile: wire.binding.profile,
      accepted: { buyerBundleText: canonicalize(bundle), buyerBundleHash: identityBundleHash(bundle), admission,
        firstAdmission: { challengeExpiresAt: ledger.retained(nonce).expiresAt, generatedAt: scope.generatedAt, checkedAt: now() } } });
  }

  // Whether the job's row is still the running row at the revision `capability` was issued for.
  function holdsAttempt(jobId, capability) {
    const row = admissionTransaction.admissionRecord(jobId);
    return row?.state === 'running' && row.rev === capability.rev;
  }

  // The provider's work under the job's effect mutex, kept until the work has settled even when its answer was given at the deadline.
  // Resolves with the outcome once it is durable; rejects with what ended the work, an error after the reservation always being uncertain.
  // `recovering` runs the retained `body` as the recovery of an earlier attempt of an accepted admission (see `resumeContext`).
  function perform(capability, jobId, body, recovering) {
    let answer, fail;
    const outcome = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
    const uncertain = (error) => (error instanceof SellerTransportError && error.status === 503 ? error : new SellerTransportError('operation_uncertain', 503, { cause: error }));
    const work = () => admissionTransaction.jobEffectMutex(jobId).run(async (jobLease) => {
      let attempt = null, settled = null, failedOnItsOwn = false;
      try {
        // Only a new attempt, or the recovery of an accepted admission, may do the work. Any other recovery the journal hands back is ended null, having done nothing.
        if (capability.effect.state !== 'new' && !recovering) {
          await capability.complete(null, { jobLease });
          throw new SellerTransportError('session_admission_unavailable', 503);
        }
        // The reservation and this work hold the job's lease separately: a recovery reads and writes nothing once the row has moved past its attempt in between.
        if (recovering && !holdsAttempt(jobId, capability)) throw new SellerTransportError('context_admission_closed', 409);
        attempt = createContextAttempt({ jobId, effect: capability.effect, capability, admissionTransaction, now, monotonicNow });
        running.add(attempt);
        const run = attempt.run(recovering ? resumeContext(provider, body) : (options) => provider.resolveBuyer(body, options));
        settled = run.settled;
        const result = await run.result.catch((error) => { failedOnItsOwn = !attempt.isClosed(); throw error; });
        const final = providerOutcome(result, body.scope);
        await capability.complete(final, { jobLease });
        answer(final);
      } catch (error) {
        const refusal = uncertain(error);
        if (failedOnItsOwn) failedProviders.add(refusal);
        fail(refusal);
      }
      await settled;
      running.delete(attempt);
    });
    trackContextWork(work).catch(fail);
    return outcome;
  }

  // A start that failed ends its accepted row (trigger a): the hold and the capacity slot are released unless the effect evidence is undetermined,
  // and then the row stays compensating for the sweep. A failure to end it never changes the refusal being answered.
  const endFailedStart = (jobId) => admissionTransaction.compensate(jobId, 'a').catch(() => {});

  async function handleContext(input) {
    let request = null;
    try {
      const admitted = await openRequest(input, (payload) => { request = payload; });
      const { body } = admitted;
      const challenge = attemptChallenge(request, body);
      if (challenge.accepted === undefined) {
        try { await admitFirstContact(request, admitted, challenge); } catch (error) {
          const { code, status } = refusalOf(error);
          // A challenge that cannot be failed here is closed by the startup pass.
          try { ledger.recordFailed(challenge.owner, challenge.nonce, code, status); } catch { /* the owner's record is retried at startup */ }
          throw error;
        }
      } else {
        const settledOutcome = await continueAccepted(request, admitted, challenge);
        if (settledOutcome !== null) return { status: settledOutcome.status, text: settledOutcome.text, request };
      }
      let capability;
      try {
        capability = await admissionTransaction.reserveContext(request.jobId, (jobLease) => coordinator.reserveCoordinated({ checked: admitted, payload: request, route: request.path,
          operationId: wireOperationId(request), paymentTx: null, keepProfile: wire.binding.profile, retainedWork: false }, { jobLease }));
      } catch (error) {
        // A resend never ends the job: an attempt of its own may be running it, or have settled it while this one waited, which is answered from its stored outcome.
        const stored = error?.code === 'context_admission_closed' && challenge.accepted !== undefined ? await continueAccepted(request, admitted, challenge) : null;
        if (stored !== null) return { status: stored.status, text: stored.text, request };
        // A reservation that lost to compensation leaves the row to it. A first admission's other refusal ends its accepted row here;
        // a continuation's never does: its row is retained work, and a refusal such as a live earlier attempt changes nothing.
        if (error?.code !== 'context_admission_closed' && challenge.accepted === undefined) await endFailedStart(request.jobId);
        throw error;
      }
      // A running admission whose operation already completed answers that outcome once it is revalidated; it starts nothing.
      if (capability.state === 'completed') {
        await revalidateContextOutcome({ jobId: request.jobId, outcome: capability.outcome });
        return { status: capability.outcome.status, text: capability.outcome.text, request };
      }
      if (typeof capability.complete !== 'function') throw new SellerTransportError('session_admission_unavailable', 503);
      // The recovery of an unfinished earlier attempt of an accepted admission works from the retained request, never from the retry's body.
      const recovering = challenge.accepted !== undefined && capability.effect.state === 'recover';
      const retained = recovering ? records.retainedBody(request.jobId) : null;
      if (recovering && retained === null) throw new SellerTransportError('operation_uncertain', 503, { cause: 'retained_context_missing' });
      let final;
      try { final = await perform(capability, request.jobId, retained ?? body, recovering); } catch (error) {
        // A recovery that failed on its own keeps its attempt open: the earlier attempt may have written, so it never ends the row.
        if (failedProviders.has(error) && !recovering) await endFailedStart(request.jobId);
        throw error;
      }
      return { status: final.status, text: final.text, request };
    } catch (error) {
      const { code, status, message, cause } = refusalOf(error);
      return { status, text: JSON.stringify({ error: code, message: refusalMessage(message, cause) }), request };
    }
  }

  const readPlannedAgreement = wire.bindPlannedAgreementReader(createPlannedAgreementReader({ listing, admissionRecord: admissionTransaction.admissionRecord, completedOutcomeOf: completedContextOutcome(wire.journal, seller), records, revalidate: revalidateStored }));
  return Object.freeze({ handleContext, revalidateContextOutcome, readPlannedAgreement, closeAttempts: (cause) => { for (const attempt of running) attempt.close(cause); } });
}

// Admission states in which the seller accepted a context request and has not aborted it.
const ACCEPTED_ADMISSION_STATES = Object.freeze(['admitted', 'running', 'settled']);

// What a synchronous reader answers for a job. A reader that throws or answers a promise gives null; a rejected promise is observed.
function readOrNull(read, jobId) {
  try {
    const value = read(jobId);
    if (typeof value?.then !== 'function') return value;
    Promise.resolve(value).catch(() => {});
    return null;
  } catch { return null; }
}

// The scope in a context answer's text, when the answer is a present one.
function presentedScope(text) {
  try { const answer = JSON.parse(text); return answer?.disposition === 'present' ? answer.value?.scope : null; } catch { return null; }
}

/** The wire journal's read-only view of a job's context operation: the `inspectContextOutcome` port of the admission transaction. */
export const contextOperationView = (journal, seller) => (jobId) => inspectWireOperation(journal, { seller, jobId, path: PATHS.context });

/** The `contextOutcome` reader of `createSellerContextRecords` over a wire journal: a job's completed context outcome `{ status, text }`, or null while it is not completed. */
export const completedContextOutcome = (journal, seller) => {
  const operationOf = contextOperationView(journal, seller);
  return (jobId) => {
    const view = operationOf(jobId);
    return view.state === 'completed' ? view.outcome : null;
  };
};

// Read-only views of the seller's durable context records for the steps after the route.
// admission(jobId) is the job's admission row ({ jobId, buyer, seller, listingPin, contextScopeHash, state }) or null.
// contextOutcome(jobId) is the context operation's completed wire outcome ({ status, text }) or null.
// acceptedPresentation(nonce) is the ledger's accepted record ({ buyerBundleText, firstAdmission }) of that nonce, or null; only retainedBody uses it.
// All must answer synchronously. A reader that throws makes exactRequest false, completedScope and retainedBody null; a malformed job id throws peer_job_invalid.
export function createSellerContextRecords({ listing, admission, contextOutcome, acceptedPresentation = () => null }) {
  const support = purchaseSupport(listing);
  if (!support.supported || typeof admission !== 'function' || typeof contextOutcome !== 'function') throw new TypeError('the seller context records need a supported Listing and the admission and context outcome readers');
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing);
  // The scope the route admits for this job, buyer and bundle (every other field is the seller's own, see scopeProblem).
  const scopeOf = (jobId, buyer, bundle, generatedAt) => {
    try {
      return { source: AGREEMENT_CONTEXT_SOURCE, wallet: addressForClaim(buyer), jobId, buyer, buyerBundleHash: identityBundleHash(bundle),
        seller, listingPin: pin, rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion }, payee: support.payee, price: support.price, generatedAt };
    } catch { return null; }
  };
  // The job's admission row when it is accepted, for this Listing, and its buyer is the same identity as `buyer`.
  const acceptedRow = (jobId, buyer) => {
    const row = readOrNull(admission, jobId);
    return record(row) && ACCEPTED_ADMISSION_STATES.includes(row.state) && row.jobId === jobId && row.seller === seller && same(row.listingPin, pin) && sameCanonicalClaimIdentity(row.buyer, buyer) ? row : null;
  };
  return Object.freeze({
    // True only when the job's admission row is accepted, this buyer's, for this Listing,
    // and its scope hash is the scope of exactly this bundle and generatedAt under the row's own buyer.
    exactRequest({ jobId, buyerBundle, generatedAt }) {
      requireJobId(jobId);
      const row = acceptedRow(jobId, buyerBundle?.presentedBy), scope = row && Number.isSafeInteger(generatedAt) ? scopeOf(jobId, row.buyer, buyerBundle, generatedAt) : null;
      return scope !== null && sellerContextScopeHash(scope) === row.contextScopeHash;
    },
    // The context request the job's accepted presentation made, `{ scope, buyerIdentityBundle }`: the bundle the ledger kept and the scope
    // rebuilt from it with the first admission's generatedAt, which must hash to the admitted scope. Null when any record is missing or differs.
    retainedBody(jobId) {
      requireJobId(jobId);
      const row = readOrNull(admission, jobId);
      if (!record(row) || !ACCEPTED_ADMISSION_STATES.includes(row.state) || row.seller !== seller || !same(row.listingPin, pin)) return null;
      const accepted = readOrNull(acceptedPresentation, row.nonce);
      let bundle;
      try { bundle = JSON.parse(accepted?.buyerBundleText); } catch { return null; }
      const scope = scopeOf(jobId, row.buyer, bundle, accepted.firstAdmission?.generatedAt);
      return scope !== null && sellerContextScopeHash(scope) === row.contextScopeHash ? deepFreeze({ scope, buyerIdentityBundle: bundle }) : null;
    },
    // The scope of the job's completed context step for this buyer, from the durable records only: its accepted
    // admission row and that operation's completed, present answer, whose scope hashes to the admitted one.
    // It says which scope was admitted and answered, not that anything it names is still valid at its source.
    completedScope({ jobId, buyer }) {
      requireJobId(jobId);
      const row = acceptedRow(jobId, buyer), outcome = row ? readOrNull(contextOutcome, jobId) : null;
      const scope = outcome?.status === 200 ? presentedScope(outcome.text) : null;
      return keys(scope, SELLER_CONTEXT_SCOPE_KEYS) && scope.jobId === jobId && scope.buyer === row.buyer && sellerContextScopeHash(scope) === row.contextScopeHash ? deepFreeze(scope) : null;
    },
  });
}
