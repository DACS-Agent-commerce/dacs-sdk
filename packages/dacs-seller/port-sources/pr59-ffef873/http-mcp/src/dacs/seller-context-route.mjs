// Vet and Agreement-context step over the seller transport
// (DACS_SELLER_CONTEXT=route).
//
// In-process (the default) the buyer calls the seller's context provider
// directly (devnet-demo/agreement-context.mjs). With the route, the buyer sends
// the exact context request over the authenticated seller transport and the
// seller's provider writes its two Vet records as before, triggered by that
// request. Who writes which Vet is unchanged.
//
// Seller side: the transport journal is read first. A request it already
// knows (same nonce or same effect) gets its cached or uncertain answer, and
// other bytes for a started job get its refusal, with no admission check; a
// readback-only request (expired delegation) is answered from the journal too.
// Only a request that would start new work is admitted: the scope arrives
// from the buyer, so every field is checked against the seller's own Listing
// and the authenticated buyer, then closed buyer access, the job the app knows
// for that buyer, the write budget and the unpaid-start limits. The start is
// recorded durably in the same journal transaction (seller-transport-auth.mjs
// peer_context_admissions). Every admission refusal is definite and written
// to the decision log; nothing was written to the chain. The journal read,
// admission and start of one job run one at a time, so an admission refusal
// is only ever returned for bytes the journal does not know.
//
// Buyer side: only the seller's signed, request-bound answer is used, and it
// must name this job and echo the exact scope. Seller text reaches the model
// only inside the seller-data envelope. After a signed admission refusal the
// purchase drops its saved request (SELLER_CONTEXT_FRESH_REFUSALS).
//
// After the route: createSellerContextRecords reads the seller's durable
// admission records and journal, read only, for the proposal (seller-agent.mjs)
// and for the provider's context after a restart (agreement-context.mjs).
import { randomUUID } from 'node:crypto';
import { identityBundleHash, isIdentityBundle } from '@kynesyslabs/dacs';
import { PURCHASE_LIMITS } from '../config.mjs';
import { sellerData } from '../mcp/seller-content.mjs';
import { addressForClaim } from '../wallet/demos-signature.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from './agreement-context-consumer.mjs';
import { DEM_RAIL, canonicalize, purchaseSupport, verifyComponent } from './listing.mjs';
import { listingPin } from './purchase-protocol.mjs';
import { SellerRefusedError, sellerFailureAttempt } from './seller-http.mjs';
import { SELLER_CONTEXT_PATH, SELLER_CONTEXT_SCOPE_KEYS, SellerTransportError, sellerContextScopeHash, sellerTransportEffect } from './seller-transport-auth.mjs';

export const SELLER_CONTEXT_MODES = Object.freeze(['in-process', 'route']);
// The same bound as the other authenticated seller calls: the seller waits
// for both Vet CREATEs inside this one call.
export const SELLER_CONTEXT_TIMEOUT_MS = 240000;
// Per buyer, the plugin's own hourly start limit (config.mjs PURCHASE_LIMITS).
// Overall, 12 starts of two Vet CREATEs fill the default 24 policy writes an
// hour (operator-approval.mjs SELLER_POLICY_DEFAULTS). Counted from the
// durable admission records, so only accepted new starts count, also after a
// restart.
export const SELLER_CONTEXT_LIMITS = Object.freeze({ maxStartsPerBuyerPerHour: PURCHASE_LIMITS.maxStartsPerHour, maxStartsPerHour: 12 });
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

function bundleAuthentic(bundle) {
  try {
    if (!isIdentityBundle(bundle)) return false;
    const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
    return Boolean(proof && verifyComponent({ signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
      signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
  } catch { return false; }
}

// listing: the seller's own verified Listing. resolveBuyer: its context
// provider. assertBuyerAccess(buyerClaim): the closed-access guard.
// knownJob(jobId, buyerClaim): true only for a job the seller's app prepared
// for that buyer; null for a seller with no app (vetting the buyer only after
// a buyer-written artifact for the job is visible is the follow-up for that case).
// admitWrites({jobId, effect, writes, hold}): null after it took a durable
// reservation named `hold` for that many seller writes of the context effect,
// or the reason it could not.
// releaseWrites({jobId, hold}): ends what is unused of that reservation (all
// of the job's when `hold` is absent) once the step has ended.
// logRefusal({jobId, buyer, reason}): one decision-log line per refusal.
// recover(body): the read-only reconciliation of an uncertain step (both Vet
// records read back and verified), or null.
// resumable(body): read only, for an uncertain step recover could not answer:
// {writes} when a shutdown cut it before anything of it was signed or sent
// (agreement-context.mjs resumableBuyer), the Vet writes still to make; null
// otherwise. Without it an uncertain step is never run again.
// writable(jobId, buyerClaim): the purchase check the provider runs again
// right before each Vet signature and anchor intent (agreement-context.mjs,
// as main's in-process path does); synchronous, true or why no new write may
// start. null: none.
export function createSellerContextRoute({ listing, resolveBuyer, assertBuyerAccess, knownJob = null, writable = null, admitWrites = async () => null, releaseWrites = async () => {},
  logRefusal = () => {}, recover = async () => null, resumable = null, limits = SELLER_CONTEXT_LIMITS, now = () => Date.now() }) {
  const support = purchaseSupport(listing);
  if (!support.supported || typeof resolveBuyer !== 'function' || typeof assertBuyerAccess !== 'function' || (knownJob !== null && typeof knownJob !== 'function') || (writable !== null && typeof writable !== 'function')
      || (resumable !== null && typeof resumable !== 'function')
      || ![admitWrites, releaseWrites, logRefusal, recover].every((value) => typeof value === 'function')
      || !['maxStartsPerBuyerPerHour', 'maxStartsPerHour'].every((key) => Number.isSafeInteger(limits?.[key]) && limits[key] > 0)) {
    throw new TypeError('the seller context route needs a supported Listing, its context provider, buyer access, write admission and positive limits');
  }
  const seller = listing.seller.identity.presentedBy, pin = listingPin(listing);
  // One job's journal read, admission and start run one at a time: a request
  // for bytes another request is starting waits, then gets the journal's answer.
  const starting = new Map();
  async function oneAtATime(jobId, work) {
    const run = (starting.get(jobId) ?? Promise.resolve()).then(work), tail = run.catch(() => {});
    starting.set(jobId, tail);
    try { return await run; } finally { if (starting.get(jobId) === tail) starting.delete(jobId); }
  }
  // A failed decision-log line or release never turns a definite answer into
  // another one: the refusal stands, and an unreleased reservation keeps holding.
  const quietly = async (work) => { try { await work(); } catch { /* see above */ } };
  const refused = async (request, code) => { await quietly(() => logRefusal({ jobId: request.jobId, buyer: request.buyer, reason: code })); refuse(code); };
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
  function scopeProblem({ scope, buyerIdentityBundle: bundle }) {
    if (!bundleAuthentic(bundle)) return 'buyer_bundle_unauthenticated';
    let wallet = null;
    try { wallet = addressForClaim(scope.buyer); } catch { /* refused below */ }
    if (scope.source !== AGREEMENT_CONTEXT_SOURCE || scope.wallet !== wallet || scope.seller !== seller || !same(scope.listingPin, pin)
        || scope.buyerBundleHash !== identityBundleHash(bundle) || scope.payee !== support.payee || !same(scope.price, support.price)
        || !same(scope.rail, { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion })) return 'context_scope_invalid';
    if (!Number.isSafeInteger(scope.generatedAt) || Math.abs(scope.generatedAt - now()) > GENERATED_AT_SKEW_MS) return 'context_generated_at';
    return null;
  }
  return Object.freeze({
    path: SELLER_CONTEXT_PATH,
    // Runs after transport authentication (seller-http.mjs) and returns the
    // journal's reservation. Every refusal before a 'perform' reservation is
    // definite and nothing was written.
    reserve: (request, body, store) => oneAtATime(request.jobId, async () => {
      if (store.classify(request, body) !== 'start') return store.reserve(request, body);
      const problem = scopeProblem(body);
      if (problem) await refused(request, problem);
      try { assertBuyerAccess(request.buyer); } catch (error) { if (error?.code === 'buyer_access_closed') await refused(request, 'buyer_access_closed'); throw error; }
      if (knownJob !== null && (await knownJob(request.jobId, request.buyer)) !== true) await refused(request, 'context_job_unknown');
      const hold = randomUUID();
      if ((await admitWrites({ jobId: request.jobId, effect: sellerTransportEffect(request), writes: VET_WRITES, hold })) !== null) await refused(request, 'seller_budget_refused');
      let reservation;
      try { reservation = store.reserve(request, body, { admit: admitStart(request) }); }
      catch (error) {
        await quietly(() => releaseWrites({ jobId: request.jobId, hold }));
        if (['unpaid_start_limit', 'buyer_unpaid_start_limit'].includes(error?.code)) await refused(request, error.code);
        throw error;
      }
      // A guard: if the journal already knows the bytes, it answers.
      if (reservation.disposition !== 'perform') { await quietly(() => releaseWrites({ jobId: request.jobId, hold })); return reservation; }
      return { ...reservation, contextHold: { jobId: request.jobId, hold } };
    }),
    perform: (body) => resolveBuyer(structuredClone(body), ...(writable ? [{ writable: () => writable(body.scope.jobId, body.scope.buyer) }] : [])),
    // Whenever the step has ended (a definite or an uncertain answer, or a
    // reconciliation): the reservation's unused part is released. The writes
    // it made keep their own policy rows, and an uncertain step is run again
    // only as resume below allows.
    settled: (contextHold) => contextHold ? quietly(() => releaseWrites(contextHold)) : Promise.resolve(),
    // An uncertain step is answered from both Vet records read back and
    // verified; nothing is written or run again. Failing that, a step a
    // shutdown cut before anything of it was signed or sent (resumable) may
    // resume; every other uncertain step stays fenced.
    async reconcile({ body }) {
      let answer = null;
      try { answer = await recover(structuredClone(body)); } catch { return null; }
      if (answer?.disposition === 'present') return { disposition: 'present', value: answer };
      if (resumable === null) return null;
      let cut = null;
      try { cut = await resumable(structuredClone(body)); } catch { return null; }
      return Number.isSafeInteger(cut?.writes) && cut.writes > 0 && cut.writes <= VET_WRITES ? { disposition: 'resume', writes: cut.writes } : null;
    },
    // After reconcile answered 'resume': the start's checks that can change
    // since its admission run again (buyer access, the job the app knows), a
    // new reservation is taken for the writes still to make, and the journal
    // hands the same effect to this request (seller-transport-auth.mjs
    // resume). Any of them failing answers null: the step stays uncertain,
    // with no refusal, so the buyer keeps its saved request. Not a new start:
    // no admission record and no start limit.
    resume: (reservation, request, store, { writes }) => oneAtATime(request.jobId, async () => {
      if (typeof store?.resume !== 'function') return null;
      try { assertBuyerAccess(request.buyer); } catch { return null; }
      if (knownJob !== null && (await knownJob(request.jobId, request.buyer)) !== true) return null;
      const hold = randomUUID();
      if ((await admitWrites({ jobId: request.jobId, effect: reservation.effectKey, writes, hold })) !== null) return null;
      try { return { ...store.resume(reservation, request), contextHold: { jobId: request.jobId, hold } }; }
      catch { await quietly(() => releaseWrites({ jobId: request.jobId, hold })); return null; }
    }),
  });
}

// Codes this plugin's seller route and transport emit; any other code is
// seller text and goes into the envelope.
const KNOWN_REFUSALS = new Set(['buyer_bundle_unauthenticated', 'context_scope_invalid', 'context_generated_at', 'buyer_access_closed', 'context_job_unknown',
  'seller_budget_refused', 'unpaid_start_limit', 'buyer_unpaid_start_limit', 'peer_envelope_invalid', 'peer_signature_invalid', 'peer_signer_wrong',
  'peer_delegation_required', 'peer_delegation_invalid', 'peer_delegation_signature_invalid', 'peer_delegation_mismatch', 'peer_delegation_expired',
  'peer_delegation_deadline', 'peer_delegation_agreement_mismatch', 'peer_audience_wrong', 'peer_expired', 'peer_request_mismatch', 'peer_listing_mismatch',
  'peer_job_mismatch', 'peer_context_mismatch', 'peer_nonce_conflict', 'peer_job_conflict', 'peer_operation_conflict', 'not_found']);

// Signed admission refusals the seller returns only for bytes its journal
// does not know: it answers known bytes from the journal before admission
// (classify), one job at a time, and the start limits are checked inside the
// reserve transaction. The buyer may then drop its saved request. A refusal
// the journal makes (peer_operation_conflict, peer_job_conflict) is not here.
export const SELLER_CONTEXT_FRESH_REFUSALS = Object.freeze(['buyer_bundle_unauthenticated', 'context_scope_invalid', 'context_generated_at', 'buyer_access_closed',
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
  const legacy = disposition === 'rejected' && keys(answer, ['disposition', 'reason', 'code']) && answer.code === LEGACY_PARTY_VET_STATE;
  if (['absent', 'rejected', 'indeterminate'].includes(disposition) && (keys(answer, ['disposition', 'reason']) || legacy) && typeof answer.reason === 'string') {
    return { disposition, reason: sellerContextReason(`seller context answer is ${disposition}`, answer.reason), ...(legacy ? { code: LEGACY_PARTY_VET_STATE } : {}) };
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
      const { account, operation: operationId, ...sellerScope } = scope;
      if (!keys(sellerScope, SELLER_CONTEXT_SCOPE_KEYS)) throw new TypeError('the Agreement-context scope differs from the seller context request');
      const client = clientFor(operation, sellerContextScopeHash(sellerScope));
      const saved = operation?.state?.protocol?.sellerContextRequest;
      if (!record(saved) || saved.generatedAt !== sellerScope.generatedAt || !same(saved.buyerBundle, buyerIdentityBundle)) throw new TypeError('the context request differs from the one saved on the purchase; nothing was sent');
      let answer;
      try { answer = await client.agreementContext({ scope: sellerScope, buyerIdentityBundle: saved.buyerBundle }); }
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
      const found = admitted(jobId, buyerBundle?.presentedBy), scope = found && Number.isSafeInteger(generatedAt) ? scopeOf(jobId, buyerBundle, generatedAt) : null;
      return Boolean(scope) && sellerContextScopeHash(scope) === found.scopeHash;
    },
    // The scope of the job's completed context step for this buyer, from the
    // durable records only: its admission record and that effect's completed,
    // present answer in the journal, whose scope hashes to the admitted one.
    completedScope({ jobId, buyer }) {
      const found = admitted(jobId, buyer), answer = found ? open().contextAnswer(jobId) : null;
      if (answer?.status !== 200) return null;
      let scope;
      try { const value = JSON.parse(answer.text); scope = value?.disposition === 'present' ? value.value?.scope : null; } catch { return null; }
      return keys(scope, SELLER_CONTEXT_SCOPE_KEYS) && scope.jobId === jobId && scope.buyer === buyer && sellerContextScopeHash(scope) === found.scopeHash ? structuredClone(scope) : null;
    },
  });
}
