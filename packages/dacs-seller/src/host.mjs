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
// way on. Each new session is opened only for a presentation that carries a
// challenge this host issued for its job and buyer (`issueSessionChallenge`,
// which the operator hands to the buyer; the first attempt consumes it), on a
// Listing the agent's own revocation check (core checkListingRevocation over
// the operator's readings) finds not revoked, and under the operator's
// seller-owned sessionAdmission (session-admission.mjs): both parties' exact
// profile and the Vet records the Agreement references. It does not mount the
// context route itself.
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { isPaymentEvidenceWalletJournalPair } from './dacs/payment-evidence-wallet-journal.mjs';
import { createSellerAgent } from './dacs/seller-agent.mjs';
import { DEFAULT_SELLER_MAX_JOBS } from './dacs/seller-durable-state.mjs';
import { createSellerHttpHandler } from './dacs/seller-http.mjs';
import { createSellerTransportServerAuth, createSellerTransportStore } from './dacs/seller-transport-auth.mjs';
import { acquireSellerStateLock } from './devnet-demo/seller-state-lock.mjs';

const REQUIRED = Object.freeze(['signer', 'listing', 'dataDirectory', 'buyerAccess', 'agreementAnchor', 'artifactAnchor', 'deliverableProducer',
  'nativePaymentEvidence', 'reconcilePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission']);
const OPTIONAL = Object.freeze(['observeDemosTransfer', 'deliveryEvidenceEnabled', 'deliverySchemaVerifier', 'maxJobs', 'host', 'port', 'now']);
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Deadlines for reading a request; the handler bounds the body itself.
const TIMEOUTS = Object.freeze({ headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 });
const MAX_HEADER_SIZE = 16384;

// A native artifact readback is an operator capability. One that never
// settles must not keep close(), and with it the state lock, open: every
// accepted read gets the host's shutdown signal and the request deadline, and
// answers with an uncertain result when either fires. The capability's own
// work cannot be cancelled here and has no durable effect, so its late
// settlement is ignored; `drain` waits for the accepted reads themselves.
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
        pending.delete(entry);
        settle(value);
      };
      const cause = (reason) => (typeof uncertain === 'function' ? uncertain(reason) : uncertain);
      const onAbort = () => finish(resolve, cause('the seller host stopped while the readback was in flight'));
      timer = setTimeout(() => finish(resolve, cause(`the ${name} readback exceeded its ${timeoutMs} ms deadline`)), timeoutMs);
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => method.call(anchor, input, options)).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
    entry.promise = promise;
    return promise;
  };
  // Keep the capability's own shape (including prototype methods and
  // non-enumerable members) and replace only the readback operations it
  // actually has: a missing one still reaches the agent's own capability
  // validation instead of becoming a wrapper function.
  const view = Object.create(anchor);
  if (typeof anchor.readRetained === 'function') Object.defineProperty(view, 'readRetained', { value: read((reason) => ({ status: 'indeterminate', reason }), 'native artifact', anchor.readRetained), enumerable: true });
  if (typeof anchor.verifyReceipt === 'function') Object.defineProperty(view, 'verifyReceipt', { value: read('indeterminate', 'native artifact receipt', anchor.verifyReceipt), enumerable: true });
  return {
    anchor: Object.freeze(view),
    drain: () => Promise.allSettled([...pending].map((entry) => entry.promise)),
  };
}

function privateDirectory(path) {
  let stat;
  try { stat = lstatSync(path); } catch { stat = null; }
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || realpathSync(path) !== path) {
    throw new TypeError('dataDirectory must be an existing private (mode 0700) directory owned by this user, given as its absolute real path');
  }
}

// Resolves once the host listens: { url, listingPin, seller, timeouts,
// issueSessionChallenge({ jobId, buyer }), close() }.
// Rejects with a TypeError before opening anything when an option is missing,
// unknown, malformed or not private, and with the startup error otherwise
// (carrying `cleanupError` when cleanup fails; an AggregateError with the
// startup error as `cause` when that error cannot carry the property).
export async function startSellerHost(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('seller host options must be an object');
  const unknown = Object.keys(options).filter((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key));
  if (unknown.length) throw new TypeError(`unknown seller host option: ${unknown.join(', ')}`);
  const missing = REQUIRED.filter((key) => options[key] == null);
  if (missing.length) throw new TypeError(`the seller host requires ${missing.join(', ')}`);
  const { signer, listing, dataDirectory, buyerAccess, agreementAnchor, artifactAnchor, deliverableProducer, observeDemosTransfer,
    nativePaymentEvidence, reconcilePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, deliveryEvidenceEnabled = false, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS,
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
    const artifact = boundedArtifactReads(artifactAnchor, { signal: shutdown.signal, timeoutMs: TIMEOUTS.requestTimeout });
    const agent = await createSellerAgent({ signer, listing, observeDemosTransfer, now, durableDirectory: join(dataDirectory, 'seller'),
      agreementAnchor, nativeArtifactAnchor: artifact.anchor, deliverableProducer, buyerAccess, nativePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, reconcilePaymentEvidence, deliveryEvidenceEnabled, deliverySchemaVerifier, maxJobs });
    opened.push(() => agent.close());
    const transport = join(dataDirectory, 'transport');
    mkdirSync(transport, { recursive: true, mode: 0o700 });
    const store = createSellerTransportStore({ path: join(transport, 'transport.sqlite'), maxJobs, now });
    opened.push(() => store.close());
    const authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store, now });
    const handler = createSellerHttpHandler(agent, { authentication });
    const active = new Set();
    let stopping = false;
    const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
      if (stopping) { res.writeHead(503); res.end(); return; }
      const work = Promise.resolve().then(() => handler(req, res));
      active.add(work);
      work.catch(() => res.destroy()).finally(() => active.delete(work));
    });
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
      // Aborting the native readback signal turns every accepted readback into
      // its uncertain result, so a request waiting on one drains instead of
      // holding the journal, agent and lock below open.
      shutdown.abort();
      const socketsClosed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.allSettled([...active]);
      await artifact.drain();
      // A connection that became idle while its last response was written is
      // swept here; the first sweep could only see it still busy.
      server.closeIdleConnections();
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
