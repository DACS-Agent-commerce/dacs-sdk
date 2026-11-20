// Standalone seller host: one seller agent for one signed Listing, behind the
// authenticated seller transport and its durable journal, on loopback.
//
// The host only composes package modules. The operator supplies the signer
// (a synchronous { claim, sign(bytes) } over its own custody; no key or key
// file reaches this package) and the native capabilities, which are required:
// the host never builds a fixture substrate, and it starts only with the whole
// chain to delivery (native payment evidence anchored by one
// createPaymentEvidenceWalletJournal, with that journal's
// `reconcilePaymentEvidence`, so an anchor whose outcome is unknown always has
// a way to land and is never signed twice; any other pair is refused; the DEM
// delivery context, whose Vet references the Agreement carries, and native DEM
// delivery) and the steward-signed rail authority each session pins, so it
// never commits an Agreement it cannot settle or holds a paid order with no
// way on. The optional `resumeDeliverableCreate` is the Deliverable journal's
// guarded resume (createDeliverableWalletJournal, whose guarded submitAuthorized
// the delivery capability must be made with): with it a signed Deliverable
// CREATE whose answer was lost is sent again, unchanged and only while the order
// is still authorized, instead of holding the paid order for good.
// Each new session is opened only for a presentation that carries a
// challenge this host issued for its job and buyer (through the signed
// challenge route; the first attempt, on the context route, consumes it) into
// the transport store's one challenge ledger, on a
// Listing the agent's own revocation check (core checkListingRevocation over
// the operator's readings) finds not revoked, and under the operator's
// seller-owned sessionAdmission (session-admission.mjs): both parties' exact
// profile and the Vet records the Agreement references.
// The host mounts the challenge route and the context route on the wire, once
// the startup sweep of unfinished context rows is done. The context route runs
// the operator's `demDeliveryContext` provider for each admitted request; that
// work can outlive its answer, so `close()` waits for it before it releases
// the stores and the state lock. The host takes no policy hold for a context
// step: it has no approval ledger.
// Before it opens anything the host binds the SDK's approved TP-1 identity
// record over the operator's `tp1Network` ({ connection(), readAuthority }); no
// option, environment variable or file names a record. It then checks the data
// directory's format marker (kit-format.json), keeps the wire request journal at
// <dataDirectory>/wire-journal under a 300 s lease, so an unusable journal
// refuses startup, and holds the binding, the journal and the seller's signer in a
// wire context for the signed routes. The
// Agreement proposal, state and commitment routes open every request and sign
// every answer through that context (seller-wire-requests.mjs), with the transport
// store as their journal; the payment and bundle routes still use the old server auth.
import { existsSync, mkdirSync, opendirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, TP1_APPROVED_IDENTITY_RECORD, WireError, admitWireArtifact, bindTp1Profile, completeWireEffect, inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { createAbandonedPurchaseState } from './dacs/abandoned-purchase.mjs';
import { boundedCall, isBoundedCallTimeout } from './dacs/bounded-call.mjs';
import { createAccountingReconciler } from './dacs/accounting-reconciliation.mjs';
import { createContextWorkRegistry } from './dacs/context-work-registry.mjs';
import { deliverableJournalFor } from './dacs/deliverable-wallet-journal.mjs';
import { demDeliveryContextHost, demDeliveryContextVetMode } from './dacs/dem-delivery-context-consumer.mjs';
import { addressForClaim } from './dacs/demos-claims.mjs';
import { assertKitDataFormat } from './dacs/kit-data-format.mjs';
import { PASSIVE_RETAINED_READ, isProvenUnsignedAbsence } from './dacs/native-dem-delivery-consumer.mjs';
import { isPaymentEvidenceWalletJournalPair } from './dacs/payment-evidence-wallet-journal.mjs';
import { createContextAdmissionTransaction } from './dacs/seller-admission-transaction.mjs';
import { createSellerAgent } from './dacs/seller-agent.mjs';
import { createClosedBootstrapGate } from './dacs/closed-bootstrap-gate.mjs';
import { DEFAULT_SELLER_MAX_JOBS } from './dacs/seller-capacity-defaults.mjs';
import { completedContextOutcome, contextOperationView, createSellerContextRecords, createSellerContextRoute, createWireSellerContextRoute } from './dacs/seller-context-route.mjs';
import { createOrdinaryCompletionPort, createSellerHttpHandler } from './dacs/seller-http.mjs';
import { createPurchaseCapacity } from './dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from './dacs/seller-reservation-accounting.mjs';
import { SellerTransportError, createSellerTransportServerAuth, createSellerTransportStore, sellerStoreInternals } from './dacs/seller-transport-auth.mjs';
import { createWireContext } from './dacs/seller-wire-requests.mjs';
import { operatorBuyerAccessConfig } from './devnet-demo/buyer-access.mjs';
import { DURABLE_SYNC } from './devnet-demo/durable-file.mjs';
import { stopRequested } from './devnet-demo/stop-request.mjs';
import { acquireSellerStateLock } from './devnet-demo/seller-state-lock.mjs';
import { assertKitOperationAdmitted } from './kit-operation-guard.mjs';
import { isPrivateDirectory } from './private-directory.mjs';

/** The one Vet mode the kit host runs its agent in: the TP-1 G3 orchestrator mode,
 * in which the seller verifies and signs both Vet records. No option, environment
 * variable, Listing member or request field selects another. */
export const KIT_TP1_VET_MODE = SELLER_FULFILMENT_VET_MODES.tp1G3Orchestrator;
const REQUIRED = Object.freeze(['signer', 'listing', 'dataDirectory', 'buyerAccess', 'agreementAnchor', 'artifactAnchor', 'deliverableProducer',
  'nativePaymentEvidence', 'reconcilePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission', 'tp1Network', 'readCommitmentReceipt']);
const OPTIONAL = Object.freeze(['observeDemosTransfer', 'resumeDeliverableCreate', 'deliveryEvidenceEnabled', 'deliverySchemaVerifier', 'maxJobs', 'maxRecords', 'maxReservationUnits', 'host', 'port', 'now', 'contextSessionState']);
const TP1_NETWORK_KEYS = Object.freeze(['connection', 'readAuthority']);
// The startup binding read is bounded; a later answer grants nothing.
const TP1_AUTHORITY_TIMEOUT_MS = 10000;
// One journal for every seller route; its lease must exceed the 240 s context step.
const KIT_JOURNAL_LEASE_MS = 300000;
// The reservation budget of the wire accounting rows that still count.
const DEFAULT_MAX_RECORDS = 10000;
const JOURNAL_DIRECTORY = 'wire-journal';
const TRANSPORT_STORE_FILE = join('transport', 'transport.sqlite');
// The journal's nonce-key (`k-`) and operation (`o-`) files: reservations a fresh kit store knows nothing of.
const JOURNAL_ACCOUNTING_FILE = /^[ko]-/;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Deadlines for reading a request; the handler bounds the body itself.
const TIMEOUTS = Object.freeze({ headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 });
const MAX_HEADER_SIZE = 16384;
// The admission transaction bounds its policy call; the host takes no policy hold, so the call answers at once.
const CONTEXT_POLICY_DEADLINE_MS = 10000;
const NO_HOLD_POLICY = Object.freeze({ reserve: async () => null, release: async () => {} });
// How often a running host re-runs the admission sweep over unfinished context rows.
const SWEEP_INTERVAL_MS = 60000;

// The one old context route object serves the challenge on the wire (`challengeOnWire`) and carries the paths; the wire route serves the
// context step itself, so every provider and write port the old object takes refuses.
const oldContextStepRefused = () => { throw new SellerTransportError('session_admission_unavailable', 503); };

// Compensation's evidence for the two Vet sink addresses of a context row: the anchor's own fresh, passive proof that no CREATE intent was
// kept. Any other answer proves nothing, so the row keeps its hold and its slot.
const vetAddressEvidence = (anchor) => (row) => Promise.all([row.vetAddresses.buyer, row.vetAddresses.seller].map(async (address) => {
  const read = await anchor.readRetained({ logicalAddress: address, artifactKind: 'CompositeVerificationRecord', fresh: true, proofOfNoIntent: true }, PASSIVE_RETAINED_READ);
  return { address, kind: isProvenUnsignedAbsence(read) ? 'proven-unsigned' : 'undetermined' };
}));

// A native artifact readback is an operator capability. Every accepted read
// gets the host's shutdown signal and the request deadline, and answers with an
// uncertain result when either fires, so a request waiting on one lets close()
// proceed. The capability's own work is not abandoned: it is tracked separately
// from that early answer, because a readback can still update the journal (the
// stock anchor's readRetained can recover a source transaction through
// observeSource). `drain` therefore waits for that work to settle before the
// journal, agent and state lock are released. A capability that honours the
// signal stops early; one that does not keeps ownership until it finishes.
function boundedArtifactReads(anchor, { signal, timeoutMs }) {
  const pending = new Set();
  const read = (uncertain, name, method) => (input, options) => {
    const entry = {};
    let done = false;
    let timer;
    pending.add(entry);
    const promise = new Promise((resolve, reject) => {
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        settle(value);
      };
      const cause = (reason) => (typeof uncertain === 'function' ? uncertain(reason) : uncertain);
      const onAbort = () => finish(resolve, cause('the seller host stopped while the readback was in flight'));
      timer = setTimeout(() => finish(resolve, cause(`the ${name} readback exceeded its ${timeoutMs} ms deadline`)), timeoutMs);
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      // Forward the caller's limits and the shutdown signal; a capability that
      // supports cancellation stops, and every other one still runs to the end.
      const workSignal = options?.signal ? AbortSignal.any([options.signal, signal]) : signal;
      entry.work = Promise.resolve().then(() => {
        if (done) return undefined;
        return method.call(anchor, input, { ...(options ?? {}), signal: workSignal });
      });
      entry.work.then(
        (value) => { pending.delete(entry); finish(resolve, value); },
        (error) => { pending.delete(entry); finish(reject, error); },
      );
    });
    entry.promise = promise;
    // Aborted (or past its deadline) before the capability was ever called:
    // there is no underlying work to retain ownership for.
    if (!entry.work) pending.delete(entry);
    return promise;
  };
  // Keep the capability's own shape and its receiver: property access (metadata
  // getters included) is forwarded to the operator's capability, while methods
  // are bound to it. Only the readback operations the capability actually has
  // are replaced; a missing one still reaches the agent's own capability
  // validation instead of becoming a wrapper function.
  const overrides = new Map();
  if (typeof anchor.readRetained === 'function') overrides.set('readRetained', read((reason) => ({ status: 'indeterminate', reason }), 'native artifact', anchor.readRetained));
  if (typeof anchor.verifyReceipt === 'function') overrides.set('verifyReceipt', read('indeterminate', 'native artifact receipt', anchor.verifyReceipt));
  // The agent calls publish on this view; keep the operator's capability as
  // the receiver, as it was before the view existed.
  if (typeof anchor.publish === 'function') overrides.set('publish', (...args) => anchor.publish(...args));
  const bound = new Map();
  const receiverMethod = (key, value) => {
    if (typeof value !== 'function' || Object.hasOwn(value, 'prototype')) return value;
    const cached = bound.get(key);
    if (cached?.value === value) return cached.bound;
    const method = value.bind(anchor);
    bound.set(key, { value, bound: method });
    return method;
  };
  const view = new Proxy(Object.create(null), {
    get: (_target, key) => overrides.has(key) ? overrides.get(key) : receiverMethod(key, Reflect.get(anchor, key, anchor)),
    has: (_target, key) => overrides.has(key) || key in anchor,
    getOwnPropertyDescriptor: (_target, key) => {
      if (overrides.has(key)) return { value: overrides.get(key), writable: false, enumerable: true, configurable: true };
      const descriptor = Object.getOwnPropertyDescriptor(anchor, key);
      return descriptor && { ...descriptor, configurable: true };
    },
    ownKeys: () => [...new Set([...Reflect.ownKeys(anchor), ...overrides.keys()])],
    getPrototypeOf: () => anchor,
    // The view is read-only; none of its writes may reach the operator's
    // capability.
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    preventExtensions: () => false,
  });
  return {
    anchor: view,
    drain: () => Promise.allSettled([...pending].map((entry) => entry.work)),
  };
}

function checkTp1Network(tp1Network) {
  if (tp1Network === null || typeof tp1Network !== 'object' || Array.isArray(tp1Network)) throw new TypeError('tp1Network must be an object');
  const unknown = Object.keys(tp1Network).filter((key) => !TP1_NETWORK_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`unknown tp1Network option: ${unknown.join(', ')}`);
  if (TP1_NETWORK_KEYS.some((key) => typeof tp1Network[key] !== 'function')) throw new TypeError('tp1Network needs a connection() and a readAuthority function');
}

// The operator's authority reader, each read within 10,000 ms. The wire keeps the reader it is bound with and calls it on
// every signed request, so the deadline is on the reader itself: a stalled read ends as `tp1_authority_timeout` (the
// timeout is its cause) instead of holding a request slot for good. Only this deadline is that error; any other failure,
// a reader's own TimeoutError included, is the reader's own error.
const withinAuthorityDeadline = (work) => boundedCall(work, { timeoutMs: TP1_AUTHORITY_TIMEOUT_MS }).catch((error) => {
  if (isBoundedCallTimeout(error)) throw new WireError('tp1_authority_timeout', 500, undefined, error);
  throw error;
});

// The binding over the SDK's approved record and the operator's current connection, read once and within the same deadline.
async function bindApprovedProfile(tp1Network) {
  const readAuthority = (input) => withinAuthorityDeadline(() => tp1Network.readAuthority(input));
  return withinAuthorityDeadline(() => bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: tp1Network.connection(), readAuthority }));
}

const journalAccountingMismatch = (detail, cause) => Object.assign(
  new Error(`kit_journal_accounting_mismatch: ${detail}`, cause === undefined ? undefined : { cause }), { code: 'kit_journal_accounting_mismatch' });

// Until startup reconciles the journal with the store, a fresh kit store must not meet a journal
// that already holds reservations. Stops at the first such entry; nothing is deleted. A journal that
// cannot be listed refuses with its cause. A missing or non-directory path is left to the journal's own checks.
function assertJournalHoldsNoAccounting(journalDirectory) {
  let directory;
  try { directory = opendirSync(journalDirectory); } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return;
    throw journalAccountingMismatch('the wire journal cannot be listed', cause);
  }
  let held = null;
  try {
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (JOURNAL_ACCOUNTING_FILE.test(entry.name)) { held = entry.name; break; }
      }
    } finally { directory.closeSync(); }
  } catch (cause) { throw journalAccountingMismatch('the wire journal cannot be listed', cause); }
  if (held !== null) throw journalAccountingMismatch(`${JOURNAL_DIRECTORY}/${held} exists but the kit store is new`);
}

// Resolves once the host listens: { url, listingPin, seller, timeouts, close() }.
// Rejects with KitOperationGuardError (kit_operation_guard_off) first of all,
// before reading the options, while the kit's operation guard is off.
// Rejects with a TypeError before opening anything when an option is missing,
// unknown, malformed or not private, and with the startup error otherwise
// (carrying `cleanupError` when cleanup fails; an AggregateError with the
// startup error as `cause` when that error cannot carry the property).
// The host runs in KIT_TP1_VET_MODE only: a `demDeliveryContext` made in another
// mode is refused with a TypeError (code `vet_mode_mismatch`) before the lock.
// The startup errors include the binding's own (`tp1_*`, with the reader's
// error kept as the cause; `tp1_authority_timeout` after 10,000 ms), which come
// before the state lock and any file; `kit_store_format_unsupported` for a data
// directory from an older kit format; `kit_journal_accounting_mismatch` for a
// new kit store over a journal that already holds reservations; and the
// journal's own `seller_replay_guard_invalid` with its detail. A store that already
// exists is reconciled with the journal before the host listens: a journal that cannot be
// read whole, or a nonce key that names no accounting row, starts the host not ready
// with the same `kit_journal_accounting_mismatch`, and a store that cannot commit its
// reconciliation refuses startup. A demDeliveryContext
// that is not a complete constructed capability (it needs `recoverBuyer`,
// `resumableBuyer` and `bindRetainedScope`) is refused with a TypeError before the
// lock, and a startup sweep that cannot record a row it visited refuses startup with
// its AggregateError.
export async function startSellerHost(options) {
  assertKitOperationAdmitted('startSellerHost');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('seller host options must be an object');
  const unknown = Object.keys(options).filter((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key));
  if (unknown.length) throw new TypeError(`unknown seller host option: ${unknown.join(', ')}`);
  const missing = REQUIRED.filter((key) => options[key] == null);
  if (missing.length) throw new TypeError(`the seller host requires ${missing.join(', ')}`);
  const { signer, listing, dataDirectory, buyerAccess, agreementAnchor, artifactAnchor, deliverableProducer, observeDemosTransfer,
    nativePaymentEvidence, reconcilePaymentEvidence, resumeDeliverableCreate = null, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, tp1Network, readCommitmentReceipt, deliveryEvidenceEnabled = false, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS, maxRecords = DEFAULT_MAX_RECORDS,
    maxReservationUnits = maxRecords, host = '127.0.0.1', port = 0, now = () => Date.now(), contextSessionState = null } = options;
  if (typeof readCommitmentReceipt !== 'function') throw new TypeError('readCommitmentReceipt must be a function');
  if (contextSessionState !== null && typeof contextSessionState !== 'function') throw new TypeError('contextSessionState must be a function');
  // The wire accepts the Listing of a continuing request only as its own admission returned it: admitted once per start.
  const signedListing = admitWireArtifact(Buffer.from(JSON.stringify(listing), 'utf8'));
  if (!LOOPBACK.has(host)) throw new TypeError('the seller host listens only on literal loopback (127.0.0.1 or ::1)');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
  if (!Number.isSafeInteger(maxReservationUnits) || maxReservationUnits < 1) throw new TypeError('maxReservationUnits must be a positive integer');
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) throw new TypeError('dataDirectory must be an absolute path');
  if (!isPrivateDirectory(dataDirectory)) throw new TypeError('dataDirectory must be an existing private (mode 0700) directory owned by this user, given as its absolute real path');
  if ((observeDemosTransfer !== undefined && typeof observeDemosTransfer !== 'function') || typeof now !== 'function') throw new TypeError('now and any supplied observeDemosTransfer must be functions');
  // DACS-4 PC-7(b): the answers that let the agent sign the same evidence
  // again (`unsigned`) come only from the package's wallet journal,
  // which keeps every signed CREATE and reads its fate from the chain.
  if (!isPaymentEvidenceWalletJournalPair(nativePaymentEvidence?.anchorEvidence, reconcilePaymentEvidence)) {
    throw new TypeError('the seller host takes the payment-evidence anchor and reconcilePaymentEvidence only from one createPaymentEvidenceWalletJournal: nativePaymentEvidence must anchor with its anchorEvidence');
  }
  // CORE §5.1: the Deliverable resume, when there is one, comes only from the journal whose guarded submit the capability is.
  deliverableJournalFor(nativeDemDelivery, resumeDeliverableCreate);
  if (demDeliveryContextVetMode(demDeliveryContext) !== KIT_TP1_VET_MODE) {
    throw Object.assign(new TypeError(`the seller host runs in the ${KIT_TP1_VET_MODE} Vet mode: demDeliveryContext must be created with vetMode: KIT_TP1_VET_MODE`), { code: 'vet_mode_mismatch' });
  }
  // The context route's provider handoff: a copied or incomplete capability is refused here, before the lock and any file.
  const provider = demDeliveryContextHost(demDeliveryContext);
  checkTp1Network(tp1Network);
  // Refuses an unbindable connection before the lock and any file; the signed routes keep the binding.
  const binding = await bindApprovedProfile(tp1Network);
  // One live process owns the state for its lifetime (this one too, for a
  // second start); taken before anything is opened, released after all of it.
  const lock = await acquireSellerStateLock(dataDirectory);
  const opened = [() => lock.release()];
  const release = async () => {
    const errors = [];
    for (const close of opened.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'seller host cleanup failed', { cause: errors[0] });
  };
  const shutdown = new AbortController();
  try {
    const generation = randomBytes(16).toString('hex');
    await assertKitDataFormat(dataDirectory, DURABLE_SYNC);
    const transport = join(dataDirectory, 'transport');
    const journalDirectory = join(dataDirectory, JOURNAL_DIRECTORY);
    if (!existsSync(join(dataDirectory, TRANSPORT_STORE_FILE))) assertJournalHoldsNoAccounting(journalDirectory);
    // The store comes first: its one challenge ledger is the agent's only challenge store, and the agent checks the
    // sessions it restores against that ledger.
    mkdirSync(transport, { recursive: true, mode: 0o700 });
    // Without an operator reader the host reads abandoned purchases itself; the reader is set once the admission records and the journal exist.
    let abandonedPurchaseState = () => null;
    const store = createSellerTransportStore({ path: join(dataDirectory, TRANSPORT_STORE_FILE), maxJobs, maxRecords, now, generation, stopped: stopRequested,
      contextSessionState: contextSessionState ?? ((target) => abandonedPurchaseState(target)),
      wireOperationView: (target) => inspectWireOperation(journal, target), retainsUnfinishedWork: (target) => agent.retainsUnfinishedWork(target) });
    opened.push(() => store.close());
    // The store reads the raw port only through its one observation adapter, which the capacity binds its cleanup to and then shares.
    const capacity = createPurchaseCapacity({ store, now, maxRecords: maxReservationUnits, sessionState: sellerStoreInternals(store).sessionState });
    // This host holds the state lock, so a validator or context step left by an earlier process has no run left:
    // the challenge validators close as lost, then each pending context step ends or becomes uncertain.
    store.challenges.closeLostValidations();
    store.recoverLostContextReservations();
    const artifact = boundedArtifactReads(artifactAnchor, { signal: shutdown.signal, timeoutMs: TIMEOUTS.requestTimeout });
    const sellerClaim = listing.seller.identity.presentedBy;
    // The agent asks which context requests were admitted through these records; the admission transaction and the journal they read are
    // opened below, before any request is served.
    const records = createSellerContextRecords({ listing, admission: (jobId) => admission.admissionRecord(jobId), contextOutcome: (jobId) => completedContextOutcome(journal, sellerClaim)(jobId) });
    // One gate, registered with the coordinator and asked by the agent: a purchase starts only from a successful context admission.
    const closedBootstrapGate = createClosedBootstrapGate({ admission: (jobId) => admission.admissionRecord(jobId), purchaseProfile: (jobId) => store.purchaseProfile(jobId), profile: binding.profile });
    const agent = await createSellerAgent({ signer, listing, observeDemosTransfer, now, durableDirectory: join(dataDirectory, 'seller'), jobSlotReleased: store.jobSlotReleased, closedBootstrapGate,
      agreementAnchor, nativeArtifactAnchor: artifact.anchor, deliverableProducer, buyerAccess, nativePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, challengeLedger: store.challenges, reconcilePaymentEvidence, resumeDeliverableCreate, deliveryEvidenceEnabled, deliverySchemaVerifier, maxJobs, vetMode: KIT_TP1_VET_MODE,
      contextRequest: records.exactRequest });
    opened.push(() => agent.close());
    // This host holds the state lock, so a job lock row left by an earlier process has no holder: release it.
    for (const { job, reason } of agent.releaseStaleLocks()) {
      process.stderr.write(`seller-state: released the lock on job ${job} left by a holder that is gone (${reason})\n`);
    }
    // An existing path is left to the journal's own checks, which refuse a symlink, a
    // file or a directory others can write, with their detail.
    try { mkdirSync(journalDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Opened so that a journal the wire refuses stops startup with its detail; the signed routes take the handle.
    const journal = openWireRequestJournal(journalDirectory, { leaseMs: KIT_JOURNAL_LEASE_MS, clock: now });
    // Before anything is served the store and the journal are reconciled: every nonce key names its accounting row, a charge that
    // never saw its result is told what the journal holds, and a completed operation returns its slot once. A mismatch keeps the host not ready.
    const reconciliation = await createAccountingReconciler({ store, capacity, journal, inspectOperation: target => inspectWireOperation(journal, target) }).reconcileStartup();
    // The cause is otherwise only a row in the store, so the one start that refuses purchases for it says why.
    if (!reconciliation.ready) process.stderr.write(`seller-state: not accepting new purchases: ${reconciliation.code}: ${String(reconciliation.cause?.message ?? '').replace(/\s+/g, ' ').trim()}\n`);
    let stopping = false;
    // The seller takes new purchases until it stops or the reconciliation found a mismatch. A context row with unfinished cleanup keeps
    // its own hold and slot, so it needs no refusal of other buyers.
    const sellerReady = () => !stopping && reconciliation.ready;
    // Stopped by the process stop flag or by this host's own close.
    const hostStopped = () => stopping || stopRequested();
    const admission = createContextAdmissionTransaction({ store, policy: NO_HOLD_POLICY, capacity, effectEvidence: vetAddressEvidence(artifact.anchor), inspectContextOutcome: contextOperationView(journal, sellerClaim),
      completeWire: (effect, outcome) => completeWireEffect(journal, effect, outcome), now, ready: sellerReady, deadlines: { policyMs: CONTEXT_POLICY_DEADLINE_MS } });
    abandonedPurchaseState = createAbandonedPurchaseState({ admissionRecord: admission.admissionRecord, now, agreementDeadline: agent.retainedAgreementDeadline,
      operationState: ({ jobId, path }) => inspectWireOperation(journal, { jobId, seller: sellerClaim, path }).state,
      retainsCommitmentWork: (jobId) => agent.retainsCommitmentWork(jobId),
      holdsPayment: (jobId) => agent.retainsPaymentWork(jobId) || agent.holdsRecordedPayment(jobId) });
    // Every effect route reserves through the coordinator and ends its attempt through the completion port. The agent's own record
    // of unfinished work lets a payment retry finish a payment the agent recorded, even after the job's session ended.
    const reservations = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: target => inspectWireOperation(journal, target), admissionTransaction: admission,
      retainsUnfinishedWork: (target) => agent.retainsUnfinishedWork(target) });
    reservations.addPreAccountingGate(closedBootstrapGate);
    const completion = createOrdinaryCompletionPort({ journal, store, capacity });
    // The readiness the discovery document publishes and the challenge and stage routes read: also false while a new purchase's whole
    // allotment does not fit. The context route keeps `sellerReady`, so an accepted context request sent again is still answered.
    const acceptsNewPurchase = () => sellerReady() && admission.fitsNewPurchase();
    // The one context every signed route on `./wire` uses, with SQL accounting before wire reservation. Each signed request and
    // answer reads the operator's connection again through it.
    const wire = createWireContext({ binding, tp1Network, signer, store, journal, ready: acceptsNewPurchase, stopped: hostStopped, now, agent, requireDelegation: false, signedListing, readCommitmentReceipt, capacity, reservations, completion, publicEndpoint: listing.seller.publicEndpoint });
    const contextWork = createContextWorkRegistry();
    const buyerWalletAccess = operatorBuyerAccessConfig(buyerAccess);
    const assertBuyerAccess = (buyerClaim) => buyerWalletAccess.assertWallet(addressForClaim(buyerClaim));
    // The route binds the provider's retained-scope reader once, as it is built, before any request or provider work.
    const contextRoute = createWireSellerContextRoute({ listing, wire, store, ledger: store.challenges, admissionTransaction: admission, coordinator: reservations, capacity, provider, assertBuyerAccess,
      knownJob: null, ready: sellerReady, stopped: hostStopped, now, monotonicNow: () => performance.now(), trackContextWork: contextWork.track });
    const context = { ...createSellerContextRoute({ listing, now, assertBuyerAccess, resolveBuyer: oldContextStepRefused, admitPresentation: oldContextStepRefused, writable: oldContextStepRefused,
      admitWrites: oldContextStepRefused, releaseWrites: oldContextStepRefused, recover: oldContextStepRefused }), ...contextRoute };
    // A purchase whose session already ended gives its unspent units back before anything is served, unless its job holds a recorded
    // payment and the payments operation has no completed answer: that job's paid retry still needs its session and allocation.
    const keepPaidJobOpen = ({ jobId, seller }) => agent.holdsRecordedPayment(jobId)
      && inspectWireOperation(journal, { jobId, seller, path: DACS_SELLER_HTTP_PATHS.payments }).state !== 'completed';
    capacity.releaseTerminalAllocations(keepPaidJobOpen);
    // Rows an earlier process left unfinished are settled or fenced before any route is mounted.
    await admission.sweep({ startup: true });
    // The state directories and the new transport database entry are durable
    // before listen permits an answer. SQLite's FULL synchronous mode syncs the
    // database file, not the directory entry naming it, so an answer sent before
    // the parents are synced could come back, after power loss, to state the host
    // believes was never created and start again empty: transport/ and
    // wire-journal/ were created here, seller/ by the durable state, and no
    // parent entry has been synced yet.
    await DURABLE_SYNC.directory(transport);
    await DURABLE_SYNC.directory(dataDirectory);
    const authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store, now });
    const handler = createSellerHttpHandler(agent, { authentication, wire, context });
    const active = new Set();
    // Connections with no dispatched request cannot be drained: a buyer that
    // stops after a partial request line would hold server.close() forever,
    // because close() clears Node's connections-checking interval and
    // closeIdleConnections() skips a socket with a partial request. Track the
    // accepted sockets and the responses they still owe so shutdown can
    // destroy only connections with nothing left to answer, and close a
    // connection whose last response has been handed off.
    const sockets = new Set();
    const owed = new Map();
    const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
      if (stopping) { res.writeHead(503, { connection: 'close' }); res.end(); return; }
      const socket = req.socket;
      owed.set(socket, (owed.get(socket) ?? 0) + 1);
      let counted = true;
      const answered = () => {
        if (!counted) return;
        counted = false;
        const remaining = (owed.get(socket) ?? 1) - 1;
        if (remaining > 0) { owed.set(socket, remaining); return; }
        owed.delete(socket);
        // The response was handed to the operating system; during shutdown
        // no further request is served on this connection.
        if (stopping) socket.destroy();
      };
      res.once('finish', answered);
      res.once('close', answered);
      const work = Promise.resolve().then(() => handler(req, res));
      active.add(work);
      work.catch(() => res.destroy()).finally(() => active.delete(work));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const destroyUndispatched = () => {
      for (const socket of sockets) if (!(owed.get(socket) > 0)) socket.destroy();
    };
    Object.assign(server, { headersTimeout: TIMEOUTS.headersTimeout, requestTimeout: TIMEOUTS.requestTimeout, keepAliveTimeout: TIMEOUTS.keepAliveTimeout });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve(); });
    });
    // Unfinished context rows are swept again while the host runs, one sweep at a time, and the units of purchases whose session has ended
    // or been abandoned are given back. A sweep that cannot finish a row records its cause on that row and a later sweep tries again, so a
    // failed pass has nothing more to report here.
    let sweeping = null;
    const sweepTimer = setInterval(() => {
      sweeping ??= admission.sweep({ startup: false }).catch(() => {}).then(() => capacity.releaseTerminalAllocations(keepPaidJobOpen)).catch(() => {})
        .finally(() => { sweeping = null; });
    }, SWEEP_INTERVAL_MS).unref();
    let closing = null;
    // Stops accepting, lets requests in progress finish, waits for the provider
    // work and the sweep still running, then closes the journal and the agent
    // state they write to and releases the state lock. A context step already
    // admitted runs to its own outcome or deadline; stopping refuses only new ones.
    const close = () => closing ??= (async () => {
      stopping = true;
      clearInterval(sweepTimer);
      const socketsClosed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      destroyUndispatched();
      // Drain accepted requests with their real outcomes before stopping the
      // capability work they may still depend on: a readback that completes
      // inside its deadline is answered and journaled, not turned into a
      // shutdown-induced uncertain effect. A readback past its deadline has
      // already answered uncertain, so this wait stays bounded.
      await Promise.allSettled([...active]);
      // No request is left to start a provider step, so none starts from here on.
      contextWork.stop();
      // Only now stop the underlying native work, then wait for it: a
      // capability that honours the signal stops early; one that does not
      // keeps ownership until it finishes.
      shutdown.abort();
      // Provider work outlives its answer when the attempt's deadline sent it; its checkpoint persistence still writes to the stores.
      await Promise.allSettled([sweeping, contextWork.drain()]);
      await artifact.drain();
      // A connection that became idle while its last response was written is
      // swept here; the first sweep could only see it still busy. Any
      // connection with nothing left to answer is destroyed, so it cannot
      // hold server.close() open.
      server.closeIdleConnections();
      destroyUndispatched();
      await socketsClosed;
      await release();
    })();
    return Object.freeze({
      url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
      listingPin: structuredClone(agent.listingPin),
      seller: agent.claim,
      timeouts: { ...TIMEOUTS },
      close,
    });
  } catch (error) {
    try { await release(); }
    catch (cleanupError) {
      // Attach the cleanup failure only where the startup error can carry it;
      // otherwise the original cause must survive as an AggregateError cause.
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        try { Object.defineProperty(error, 'cleanupError', { value: cleanupError }); }
        catch { throw new AggregateError([cleanupError], 'seller host startup failed', { cause: error }); }
      } else {
        throw new AggregateError([cleanupError], 'seller host startup failed', { cause: error });
      }
    }
    throw error;
  }
}
