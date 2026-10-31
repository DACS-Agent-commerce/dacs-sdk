// Seller-owned Vet and Agreement context over the authenticated transport.
// Admission reserves two writes. Pre-payment writes still require exact
// seller approval. This is the kit's only context mode.
import { identityBundleHash, isCanonicalJobId, isIdentityBundle } from '@kynesyslabs/dacs';
import { sellerData } from '../mcp/seller-content.mjs';
import { addressForClaim, isCanonicalEd25519Signature } from './demos-claims.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from './agreement-context-consumer.mjs';
import { DEM_RAIL, canonicalize, purchaseSupport, verifyComponent } from './listing.mjs';
import { listingPin } from './purchase-protocol.mjs';
import { SellerRefusedError, sellerFailureAttempt } from './seller-http.mjs';
import { SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH, SELLER_CONTEXT_SCOPE_KEYS, SellerTransportError, sellerContextScopeHash, sellerTransportEffect } from './seller-transport-auth.mjs';

// The same bound as the other authenticated seller calls: the seller waits
// for both Vet CREATEs inside this one call.
export const SELLER_CONTEXT_TIMEOUT_MS = 240000;
// Per buyer: five accepted starts per rolling hour.
// Overall, 12 starts of two Vet CREATEs fill the default 24 policy writes an
// hour (operator-approval.mjs SELLER_POLICY_DEFAULTS). Counted from the
// durable admission records, so only accepted new starts count, also after a
// restart.
export const SELLER_CONTEXT_LIMITS = Object.freeze({ maxStartsPerBuyerPerHour: 5, maxStartsPerHour: 12 });
// Each start makes two seller Vet CREATEs before the buyer pays anything.
const VET_WRITES = 2;
const HOUR_MS = 3_600_000;
// The seller's clock window for the buyer's generatedAt (seller-agent.mjs).
const GENERATED_AT_SKEW_MS = 10 * 60 * 1000;
// dem-delivery-context-consumer.mjs keeps at most 240 characters of a reason.
const REASON_MAX = 240;

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

function savedDisposition(text) {
  try { return JSON.parse(text)?.disposition; } catch { return null; }
}

function bundleAuthentic(bundle) {
  try {
    if (!isIdentityBundle(bundle) || bundle.claims.length !== 1 || bundle.claims[0].ref !== bundle.presentedBy) return false;
    const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
    return Boolean(proof && isCanonicalEd25519Signature(proof.signature) && verifyComponent({ signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
      signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
  } catch { return false; }
}

// Seller context policy and recovery ports are operator capabilities. Admission
// owns its exact pending reservation until a hold is returned to HTTP; failures
// release unused holds, clear fresh work, and retain resumed uncertainty.
export function createSellerContextRoute({ listing, resolveBuyer, assertBuyerAccess, knownJob = null, writable, admitWrites, releaseWrites,
  recover, resumable = null, limits = SELLER_CONTEXT_LIMITS, now = () => Date.now(), log = line => process.stderr.write(line) }) {
  const support = purchaseSupport(listing);
  if (!support.supported || typeof resolveBuyer !== 'function' || typeof assertBuyerAccess !== 'function' || (knownJob !== null && typeof knownJob !== 'function') || typeof writable !== 'function'
      || (resumable !== null && typeof resumable !== 'function')
      || ![admitWrites, releaseWrites, recover].every((value) => typeof value === 'function')
      || !['maxStartsPerBuyerPerHour', 'maxStartsPerHour'].every((key) => Number.isSafeInteger(limits?.[key]) && limits[key] > 0)) {
    throw new TypeError('the seller context route needs a supported Listing, its context provider, buyer access, write admission and positive limits');
  }
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing);
  const release=async(jobId,hold)=>{
    try { await releaseWrites({jobId,hold}); }
    catch(error) { log(`context hold release failed: ${jobId} ${hold} ${String(error?.code??'error').slice(0,64)}\n`); }
  };
  async function admitOwned(reservation,request,store,writes) {
    const {jobId}=request,effect=reservation.effectKey,resumed=reservation.resumed===true;
    const hold=resumed?`${effect}:${reservation.owner}`:effect;
    let problem,failure;
    try { problem=await admitWrites({jobId,effect,writes,hold}); }
    catch(cause) { failure={cause};problem='operation_uncertain'; }
    if(problem!==null) {
      await release(jobId,hold);
      store.finish(reservation,failure||resumed?503:409,JSON.stringify({error:failure?'operation_uncertain':'seller_budget_refused'}),{noEffect:!resumed});
      if(failure)throw failure.cause;
      if(resumed)return null;
      refuse('seller_budget_refused');
    }
    return {...reservation,contextHold:{jobId,hold}};
  }
  // The unpaid-start limits, read inside the reserve transaction.
  const admitStart = (request) => ({ starts }) => {
    const at = now();
    if (starts(at - HOUR_MS) >= limits.maxStartsPerHour) refuse('unpaid_start_limit');
    if (starts(at - HOUR_MS, request.buyer) >= limits.maxStartsPerBuyerPerHour) refuse('buyer_unpaid_start_limit');
    return at;
  };
  // The transport has bound job, buyer (never the seller), seller, pin, scope
  // hash and the bundle's presenter; this binds the remaining scope fields to
  // the seller's own values.
  function scopeProblem({ scope, buyerIdentityBundle: bundle }, challenge = false) {
    if (!challenge && !bundleAuthentic(bundle)) return 'buyer_bundle_unauthenticated';
    let wallet = null;
    try { wallet = addressForClaim(scope.buyer); } catch { /* refused below */ }
    if (scope.source !== AGREEMENT_CONTEXT_SOURCE || scope.wallet !== wallet || scope.seller !== seller || !same(scope.listingPin, pin)
        || (!challenge && scope.buyerBundleHash !== identityBundleHash(bundle)) || scope.payee !== support.payee || !same(scope.price, support.price)
        || !same(scope.rail, { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion })) return 'context_scope_invalid';
    if (!Number.isSafeInteger(scope.generatedAt) || Math.abs(scope.generatedAt - now()) > GENERATED_AT_SKEW_MS) return 'context_generated_at';
    return null;
  }
  // A saved present answer is reported again only once both Vet records read
  // back and verify, as in reconcile; otherwise nothing is reported and the
  // saved step stays as it is.
  async function verifiedReplay(body, reservation) {
    if (reservation.disposition !== 'cached' || reservation.status !== 200 || savedDisposition(reservation.text) !== 'present') return reservation;
    let answer = null;
    try { answer = await recover(structuredClone(body)); } catch (cause) { throw new Error('the saved context answer could not be verified again', { cause }); }
    if (answer?.disposition !== 'present') throw new Error('the saved context answer\'s Vet records no longer verify; it was not reported');
    return reservation;
  }
  return Object.freeze({
    onRejectedBody(request,body,store) {
      requireContextJob(request,body);
      store.attemptContextPresentation(request,body);
    },
    path: SELLER_CONTEXT_PATH,
    challengePath: SELLER_CONTEXT_CHALLENGE_PATH,
    challenge: async (request, body, store) => {
      requireContextJob(request, body);
      if (request.jobId !== body.scope.jobId) refuse('peer_job_mismatch');
      const problem = scopeProblem(body, true);
      if (problem) refuse(problem);
      try { await assertBuyerAccess(request.buyer); } catch (error) { if (error?.code === 'buyer_access_closed') refuse('buyer_access_closed'); throw error; }
      if (knownJob !== null && (await knownJob(request.jobId, request.buyer)) !== true) refuse('context_job_unknown');
      return store.issueContextChallenge(request, body.scope, { maxPerBuyer: limits.maxStartsPerBuyerPerHour, maxGlobal: limits.maxStartsPerHour, admit: admitStart(request) });
    },
    // Runs after transport authentication (seller-http.mjs) and returns the
    // journal's reservation. Every refusal before a 'perform' reservation is
    // definite; only required anti-replay consumption may have been written.
    reserve: async (request,body,store)=>{
      requireContextJob(request,body);
      let verdict=scopeProblem(body);
      try { await assertBuyerAccess(request.buyer); }
      catch(error) { if(error?.code!=='buyer_access_closed')throw error;verdict='buyer_access_closed'; }
      if(knownJob!==null && await knownJob(request.jobId,request.buyer)!==true)verdict='context_job_unknown';
      const reservation=store.reserve(request,body,{admit:admitStart(request),contextDecision:true,verdict});
      const effect=sellerTransportEffect(request);
      if(reservation.disposition==='cached') {
        await release(request.jobId,effect);
        return verifiedReplay(body,reservation);
      }
      if(reservation.disposition!=='perform')return reservation;
      return admitOwned(reservation,request,store,VET_WRITES);
    },
    perform: (body) => {
      requireJobId(body?.scope?.jobId);
      return resolveBuyer(structuredClone(body), { writable: () => writable(body.scope.jobId, body.scope.buyer) });
    },
    // Every finished attempt releases its unused holds; an uncertain effect
    // stays fenced and an authenticated resume reserves fresh capacity.
    settled: (contextHold)=>{
      if(!contextHold?.hold)return;
      requireJobId(contextHold.jobId);
      return release(contextHold.jobId,contextHold.hold.split(':')[0]);
    },
    // An uncertain step is answered from both Vet records read back and
    // verified; nothing is written or run again. Failing that, a step a
    // shutdown cut before anything of it was signed or sent (resumable) may
    // resume; every other uncertain step stays fenced.
    async reconcile({ body }) {
      requireJobId(body?.scope?.jobId);
      let answer = null;
      try { answer = await recover(structuredClone(body)); } catch { return null; }
      if (answer?.disposition === 'present' || answer?.code === 'party_vet_non_pass') return { disposition: 'present', value: answer };
      if (resumable === null) return null;
      let cut = null;
      try { cut = await resumable(structuredClone(body)); } catch { return null; }
      return Number.isSafeInteger(cut?.writes) && cut.writes > 0 && cut.writes <= VET_WRITES ? { disposition: 'resume', writes: cut.writes } : null;
    },
    // Reserve the new journal owner before taking its hold. A budget refusal
    resume: async(reservation,request,store,{writes})=>{
      requireJobId(request?.jobId);
      if(typeof store?.resume!=='function')return null;
      try { await assertBuyerAccess(request.buyer); } catch { return null; }
      if(knownJob!==null && await knownJob(request.jobId,request.buyer)!==true)return null;
      let resumed;
      try { resumed=store.resume(reservation,request); } catch { return null; }
      await release(request.jobId,resumed.effectKey);
      return admitOwned(resumed,request,store,writes);
    },
  });
}

// Codes this plugin's seller route and transport emit; any other code is
// seller text and goes into the envelope.
const KNOWN_REFUSALS = new Set(['peer_job_invalid', 'context_challenge_mismatch', 'context_challenge_consumed', 'context_challenge_expired', 'buyer_bundle_unauthenticated', 'context_scope_invalid', 'context_generated_at', 'buyer_access_closed', 'context_job_unknown',
  'seller_budget_refused', 'unpaid_start_limit', 'buyer_unpaid_start_limit', 'peer_envelope_invalid', 'peer_signature_invalid', 'peer_signer_wrong',
  'peer_delegation_required', 'peer_delegation_invalid', 'peer_delegation_signature_invalid', 'peer_delegation_mismatch', 'peer_delegation_expired',
  'peer_delegation_deadline', 'peer_delegation_agreement_mismatch', 'peer_audience_wrong', 'peer_expired', 'peer_request_mismatch', 'peer_listing_mismatch',
  'peer_job_mismatch', 'peer_context_mismatch', 'peer_nonce_conflict', 'peer_job_conflict', 'peer_operation_conflict', 'not_found']);

// Signed admission refusals the seller returns only for bytes its journal
// does not know: it answers known bytes from the journal before admission
// in the same transaction as challenge consumption; start limits use the
// reserve transaction. The buyer may then drop its saved request. A refusal
// the journal makes (peer_operation_conflict, peer_job_conflict) is not here.
export const SELLER_CONTEXT_FRESH_REFUSALS = Object.freeze(['peer_job_invalid', 'context_challenge_mismatch', 'context_challenge_consumed', 'context_challenge_expired', 'buyer_bundle_unauthenticated', 'context_scope_invalid', 'context_generated_at', 'buyer_access_closed',
  'context_job_unknown', 'seller_budget_refused', 'unpaid_start_limit', 'buyer_unpaid_start_limit']);
const refusedReason = (code) => `seller refused the context request (${code})`;
// True only for the exact reason the client below gives such a refusal.
export const sellerContextRequestUnknown = (reason) => SELLER_CONTEXT_FRESH_REFUSALS.some((code) => reason === refusedReason(code));

// Plugin text, then any seller text as one complete envelope that fits the
// consumer's reason cap, so truncation never cuts an envelope open.
export function sellerContextReason(head, sellerText) {
  if (sellerText === undefined || sellerText === null || sellerText === '') return head;
  let points = [...String(sellerText)].slice(0, REASON_MAX);
  while (points.length) {
    const reason = `${head}: ${sellerData(points.join('')).text}`;
    if (reason.length <= REASON_MAX) return reason;
    points = points.slice(0, points.length - Math.max(1, Math.floor((reason.length - REASON_MAX) / 12)));
  }
  return `${head} (seller text omitted)`;
}

// Main's provider refuses a job an earlier server version left without party
// Vet state with this code (agreement-context.mjs LEGACY_PARTY_VET_STATE); the
// purchase names it as its own error, as in-process.
const LEGACY_PARTY_VET_STATE = 'legacy_party_vet_state_missing';

function checkedAnswer(answer, { scope, sellerScope }) {
  const disposition = answer?.disposition;
  const vetFailure = disposition === 'rejected' && keys(answer, ['disposition', 'reason', 'code', 'errorClass'])
    && answer.code === 'party_vet_non_pass' && ['counterparty', 'permanent'].includes(answer.errorClass);
  const named = vetFailure || (disposition === 'rejected' && keys(answer, ['disposition', 'reason', 'code']) && answer.code === LEGACY_PARTY_VET_STATE);
  if (['absent', 'rejected', 'indeterminate'].includes(disposition) && (keys(answer, ['disposition', 'reason']) || named) && typeof answer.reason === 'string') {
    return { disposition, reason: sellerContextReason(`seller context answer is ${disposition}`, answer.reason), ...(named ? { code: answer.code } : {}), ...(vetFailure ? { errorClass: answer.errorClass } : {}) };
  }
  if (disposition !== 'present' || !keys(answer, ['disposition', 'value']) || !keys(answer.value, ['input', 'scope'])) return { disposition: 'indeterminate', reason: 'seller context answer is malformed' };
  if (answer.value.scope?.jobId !== scope.jobId || answer.value.input?.jobId !== scope.jobId) return { disposition: 'rejected', reason: 'seller context answer names another job' };
  if (!same(answer.value.scope, sellerScope)) return { disposition: 'rejected', reason: 'seller context answer scope differs from the request' };
  // The caller (dem-delivery-context-consumer.mjs) checks the input exactly.
  return { disposition: 'present', value: { scope: structuredClone(scope), input: answer.value.input } };
}

// clientFor(operation, scopeHash) returns the authenticated seller client
// (seller-http.mjs) for this purchase, signing with the custody buyer or the
// purchase's delegated session key. The plugin's account and operation ids
// stay out of the request. Only the request saved on the purchase before its
// first send (protocol-purchases.mjs sellerContextRequest) is ever sent, so a
// retry sends exactly the same bytes.
export function createSellerContextClient({ clientFor }) {
  if (typeof clientFor !== 'function') throw new TypeError('the seller context client needs an authenticated seller client per purchase');
  return Object.freeze({
    async resolveBuyer({ scope, buyerIdentityBundle }, { operation } = {}) {
      requireJobId(scope?.jobId);
      const { account, operation: operationId, ...sellerScope } = scope;
      if (!keys(sellerScope, SELLER_CONTEXT_SCOPE_KEYS)) throw new TypeError('the Agreement-context scope differs from the seller context request');
      const client = clientFor(operation, sellerContextScopeHash(sellerScope));
      const saved = operation?.state?.protocol?.sellerContextRequest;
      if (!record(saved) || saved.generatedAt !== sellerScope.generatedAt || !same(saved.buyerBundle, buyerIdentityBundle)) throw new TypeError('the context request differs from the one saved on the purchase; nothing was sent');
      let answer;
      try { answer = await client.agreementContext(JSON.parse(canonicalize({ scope: sellerScope, buyerIdentityBundle: saved.buyerBundle }))); }
      catch (error) {
        // Any other failure is the client's unavailable request: the purchase
        // records main's facts about this attempt (seller-http.mjs
        // sellerFailureAttempt), its bounded cause and `dispatched: false` only
        // for the local TLS guard's refusal before signing. Neither says nothing
        // was written: an earlier attempt may have sent these bytes.
        if (!(error instanceof SellerRefusedError)) {
          const { causeCode, dispatched } = sellerFailureAttempt(error);
          return { disposition: 'indeterminate', reason: `DEM delivery context failed: ${failureText(error)}`, ...(causeCode ? { causeCode } : {}), ...(dispatched === false ? { dispatched } : {}) };
        }
        // The seller gives these signed refusals only before its provider runs,
        // so this request wrote nothing: `written: false`, which the consumer
        // keeps for this capability alone (ops health then reads no Vet write
        // back). Every other refusal and every answer carries no such mark.
        return { disposition: 'rejected', reason: KNOWN_REFUSALS.has(error.code) ? refusedReason(error.code)
          : sellerContextReason('seller refused the context request', `${error.code}: ${error.message}`), ...(SELLER_CONTEXT_FRESH_REFUSALS.includes(error.code) ? { written: false } : {}) };
      }
      return checkedAnswer(answer, { scope, sellerScope });
    },
  });
}

// Read-only views of the seller's durable context records for the steps after
// the route. store() returns the seller transport store once it is open.
export function createSellerContextRecords({ listing, store }) {
  const support = purchaseSupport(listing);
  if (!support.supported || typeof store !== 'function') throw new TypeError('the seller context records need a supported Listing and the seller transport store');
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing);
  const open = () => { const value = store(); return typeof value?.contextAdmission === 'function' && typeof value.contextAnswer === 'function' ? value : null; };
  // The scope the route admits for this job, buyer bundle and generatedAt
  // (every other field is the seller's own, see scopeProblem).
  const scopeOf = (jobId, bundle, generatedAt) => {
    try {
      return { source: AGREEMENT_CONTEXT_SOURCE, wallet: addressForClaim(bundle.presentedBy), jobId, buyer: bundle.presentedBy, buyerBundleHash: identityBundleHash(bundle),
        seller, listingPin: pin, rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion }, payee: support.payee, price: support.price, generatedAt };
    } catch { return null; }
  };
  const admitted = (jobId, buyer) => { const found = open()?.contextAdmission(jobId); return found && found.buyer === buyer && found.seller === seller && same(found.listingPin, pin) ? found : null; };
  return Object.freeze({
    // True only when the job's admission record is this buyer's, for this
    // Listing, and its scope hash is the scope of exactly this bundle and generatedAt.
    exactRequest({ jobId, buyerBundle, generatedAt }) {
      requireJobId(jobId);
      const found = admitted(jobId, buyerBundle?.presentedBy), scope = found && Number.isSafeInteger(generatedAt) ? scopeOf(jobId, buyerBundle, generatedAt) : null;
      return Boolean(scope) && sellerContextScopeHash(scope) === found.scopeHash;
    },
    // The scope of the job's completed context step for this buyer, from the
    // durable records only: its admission record and that effect's completed,
    // present answer in the journal, whose scope hashes to the admitted one.
    completedScope({ jobId, buyer }) {
      requireJobId(jobId);
      const found = admitted(jobId, buyer), answer = found ? open().contextAnswer(jobId) : null;
      if (answer?.status !== 200) return null;
      let scope;
      try { const value = JSON.parse(answer.text); scope = value?.disposition === 'present' ? value.value?.scope : null; } catch { return null; }
      return keys(scope, SELLER_CONTEXT_SCOPE_KEYS) && scope.jobId === jobId && scope.buyer === buyer && sellerContextScopeHash(scope) === found.scopeHash ? structuredClone(scope) : null;
    },
  });
}
