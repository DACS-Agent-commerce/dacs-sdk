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
// challenge this host issued for its job and buyer (`issueSessionChallenge`,
// which the operator hands to the buyer; the first attempt consumes it), on a
// Listing the agent's own revocation check (core checkListingRevocation over
// the operator's readings) finds not revoked, and under the operator's
// seller-owned sessionAdmission (session-admission.mjs): both parties' exact
// profile and the Vet records the Agreement references. It does not mount the
// context route itself.
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
import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { boundedCall, isBoundedCallTimeout } from './dacs/bounded-call.mjs';
import { deliverableJournalFor } from './dacs/deliverable-wallet-journal.mjs';
import { assertKitDataFormat } from './dacs/kit-data-format.mjs';
import { isPaymentEvidenceWalletJournalPair } from './dacs/payment-evidence-wallet-journal.mjs';
import { createSellerAgent } from './dacs/seller-agent.mjs';
import { DEFAULT_SELLER_MAX_JOBS } from './dacs/seller-durable-state.mjs';
import { createSellerHttpHandler } from './dacs/seller-http.mjs';
import { createSellerTransportServerAuth, createSellerTransportStore } from './dacs/seller-transport-auth.mjs';
import { retainedFor } from './dacs/seller-wire-requests.mjs';
import { DURABLE_SYNC } from './devnet-demo/durable-file.mjs';
import { acquireSellerStateLock } from './devnet-demo/seller-state-lock.mjs';
import { assertKitOperationAdmitted } from './kit-operation-guard.mjs';

const REQUIRED = Object.freeze(['signer', 'listing', 'dataDirectory', 'buyerAccess', 'agreementAnchor', 'artifactAnchor', 'deliverableProducer',
  'nativePaymentEvidence', 'reconcilePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission', 'tp1Network']);
const OPTIONAL = Object.freeze(['observeDemosTransfer', 'resumeDeliverableCreate', 'deliveryEvidenceEnabled', 'deliverySchemaVerifier', 'maxJobs', 'host', 'port', 'now']);
const TP1_NETWORK_KEYS = Object.freeze(['connection', 'readAuthority']);
// The startup binding read is bounded; a later answer grants nothing.
const TP1_AUTHORITY_TIMEOUT_MS = 10000;
// One journal for every seller route; its lease must exceed the 240 s context step.
const KIT_JOURNAL_LEASE_MS = 300000;
const JOURNAL_DIRECTORY = 'wire-journal';
const TRANSPORT_STORE_FILE = join('transport', 'transport.sqlite');
// The journal's nonce-key (`k-`) and operation (`o-`) files: reservations a fresh kit store knows nothing of.
const JOURNAL_ACCOUNTING_FILE = /^[ko]-/;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Deadlines for reading a request; the handler bounds the body itself.
const TIMEOUTS = Object.freeze({ headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 });
const MAX_HEADER_SIZE = 16384;

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

function privateDirectory(path) {
  let stat;
  try { stat = lstatSync(path); } catch { stat = null; }
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || realpathSync(path) !== path) {
    throw new TypeError('dataDirectory must be an existing private (mode 0700) directory owned by this user, given as its absolute real path');
  }
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

// Resolves once the host listens: { url, listingPin, seller, timeouts,
// issueSessionChallenge({ jobId, buyer }), close() }.
// Rejects with KitOperationGuardError (kit_operation_guard_off) first of all,
// before reading the options, while the kit's operation guard is off.
// Rejects with a TypeError before opening anything when an option is missing,
// unknown, malformed or not private, and with the startup error otherwise
// (carrying `cleanupError` when cleanup fails; an AggregateError with the
// startup error as `cause` when that error cannot carry the property).
// The startup errors include the binding's own (`tp1_*`, with the reader's
// error kept as the cause; `tp1_authority_timeout` after 10,000 ms), which come
// before the state lock and any file; `kit_store_format_unsupported` for a data
// directory from an older kit format; `kit_journal_accounting_mismatch` for a
// new kit store over a journal that already holds reservations; and the
// journal's own `seller_replay_guard_invalid` with its detail.
export async function startSellerHost(options) {
  assertKitOperationAdmitted('startSellerHost');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('seller host options must be an object');
  const unknown = Object.keys(options).filter((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key));
  if (unknown.length) throw new TypeError(`unknown seller host option: ${unknown.join(', ')}`);
  const missing = REQUIRED.filter((key) => options[key] == null);
  if (missing.length) throw new TypeError(`the seller host requires ${missing.join(', ')}`);
  const { signer, listing, dataDirectory, buyerAccess, agreementAnchor, artifactAnchor, deliverableProducer, observeDemosTransfer,
    nativePaymentEvidence, reconcilePaymentEvidence, resumeDeliverableCreate = null, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, tp1Network, deliveryEvidenceEnabled = false, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS,
    host = '127.0.0.1', port = 0, now = () => Date.now() } = options;
  if (!LOOPBACK.has(host)) throw new TypeError('the seller host listens only on literal loopback (127.0.0.1 or ::1)');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) throw new TypeError('dataDirectory must be an absolute path');
  privateDirectory(dataDirectory);
  if ((observeDemosTransfer !== undefined && typeof observeDemosTransfer !== 'function') || typeof now !== 'function') throw new TypeError('now and any supplied observeDemosTransfer must be functions');
  // DACS-4 PC-7(b): the answers that let the agent sign the same evidence
  // again (`unsigned`) come only from the package's wallet journal,
  // which keeps every signed CREATE and reads its fate from the chain.
  if (!isPaymentEvidenceWalletJournalPair(nativePaymentEvidence?.anchorEvidence, reconcilePaymentEvidence)) {
    throw new TypeError('the seller host takes the payment-evidence anchor and reconcilePaymentEvidence only from one createPaymentEvidenceWalletJournal: nativePaymentEvidence must anchor with its anchorEvidence');
  }
  // CORE §5.1: the Deliverable resume, when there is one, comes only from the journal whose guarded submit the capability is.
  deliverableJournalFor(nativeDemDelivery, resumeDeliverableCreate);
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
    await assertKitDataFormat(dataDirectory, DURABLE_SYNC);
    const transport = join(dataDirectory, 'transport');
    const journalDirectory = join(dataDirectory, JOURNAL_DIRECTORY);
    if (!existsSync(join(dataDirectory, TRANSPORT_STORE_FILE))) assertJournalHoldsNoAccounting(journalDirectory);
    const artifact = boundedArtifactReads(artifactAnchor, { signal: shutdown.signal, timeoutMs: TIMEOUTS.requestTimeout });
    const agent = await createSellerAgent({ signer, listing, observeDemosTransfer, now, durableDirectory: join(dataDirectory, 'seller'),
      agreementAnchor, nativeArtifactAnchor: artifact.anchor, deliverableProducer, buyerAccess, nativePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, reconcilePaymentEvidence, resumeDeliverableCreate, deliveryEvidenceEnabled, deliverySchemaVerifier, maxJobs });
    opened.push(() => agent.close());
    // This host holds the state lock, so a job lock row left by an earlier process has no holder: release it.
    for (const { job, reason } of agent.releaseStaleLocks()) {
      process.stderr.write(`seller-state: released the lock on job ${job} left by a holder that is gone (${reason})\n`);
    }
    mkdirSync(transport, { recursive: true, mode: 0o700 });
    // Likewise a context step still pending in the journal has no run left: it opens as uncertain.
    const store = createSellerTransportStore({ path: join(dataDirectory, TRANSPORT_STORE_FILE), maxJobs, now, markPendingContextEffectsUncertain: true });
    opened.push(() => store.close());
    // An existing path is left to the journal's own checks, which refuse a symlink, a
    // file or a directory others can write, with their detail.
    try { mkdirSync(journalDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Opened so that a journal the wire refuses stops startup with its detail; the signed routes take the handle.
    const journal = openWireRequestJournal(journalDirectory, { leaseMs: KIT_JOURNAL_LEASE_MS, clock: now });
    let stopping = false;
    // The seller takes new purchases until it stops; every later readiness term is ANDed in by the PR that owns it (SA-7).
    const sellerReady = () => !stopping;
    // The context the signed routes on `./wire` use: the proposals, state and commitment routes (the transport store is their
    // journal). The binding is read once at startup; a later connection is never compared.
    const wire = Object.freeze({ binding, connection: tp1Network.connection, signer, journal, store, ready: sellerReady, now, requireDelegation: false,
      retainedFor: (request) => retainedFor(agent, request) });
    // The state directories and the new transport database entry are durable
    // before listen permits an answer. SQLite's FULL synchronous mode syncs the
    // database file, not the directory entry naming it, so an answer sent before
    // the parents are synced could come back, after power loss, to state the host
    // believes was never created and start again empty: seller/ was created by
    // the durable state, transport/ and wire-journal/ here, and no parent entry
    // has been synced yet.
    await DURABLE_SYNC.directory(transport);
    await DURABLE_SYNC.directory(dataDirectory);
    const authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store, now });
    const handler = createSellerHttpHandler(agent, { authentication, wire });
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
    let closing = null;
    // Stops accepting, lets requests in progress finish, then closes the
    // journal and the agent state they write to and releases the state lock.
    const close = () => closing ??= (async () => {
      stopping = true;
      const socketsClosed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      destroyUndispatched();
      // Drain accepted requests with their real outcomes before stopping the
      // capability work they may still depend on: a readback that completes
      // inside its deadline is answered and journaled, not turned into a
      // shutdown-induced uncertain effect. A readback past its deadline has
      // already answered uncertain, so this wait stays bounded.
      await Promise.allSettled([...active]);
      // Only now stop the underlying native work, then wait for it: a
      // capability that honours the signal stops early; one that does not
      // keeps ownership until it finishes.
      shutdown.abort();
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
      // CORE SN-1..SN-4: { jobId, buyer, sessionNonce, issuedAt, expiresAt },
      // kept durably before it is returned; the buyer's bundle presents it.
      // Once shutdown has begun the host refuses to issue, even while the
      // agent itself is still open for the requests that are draining.
      issueSessionChallenge: (input) => {
        if (stopping) {
          const error = new Error('the seller host is closing; no session challenge is issued');
          error.code = 'seller_host_closing';
          throw error;
        }
        return agent.issueSessionChallenge(structuredClone(input));
      },
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
