// Standalone seller host: one seller agent for one signed Listing, behind the
// authenticated seller transport and its durable journal, on loopback.
//
// The host only composes package modules. The operator supplies the signer
// (a synchronous { claim, sign(bytes) } over its own custody; no key or key
// file reaches this package) and the native capabilities, which are required:
// the host never builds a fixture substrate, and it starts only with the whole
// chain to delivery (native payment evidence with the wallet journal's
// `reconcilePaymentEvidence`, so an anchor whose outcome is unknown always has
// a way to land, as createPaymentEvidenceWalletJournal composes them; the DEM
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
import { createSellerAgent } from './dacs/seller-agent.mjs';
import { createSellerHttpHandler } from './dacs/seller-http.mjs';
import { createSellerTransportServerAuth, createSellerTransportStore } from './dacs/seller-transport-auth.mjs';
import { acquireSellerStateLock } from './devnet-demo/seller-state-lock.mjs';

const REQUIRED = Object.freeze(['signer', 'listing', 'dataDirectory', 'buyerAccess', 'agreementAnchor', 'artifactAnchor', 'deliverableProducer', 'observeDemosTransfer',
  'nativePaymentEvidence', 'reconcilePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission']);
const OPTIONAL = Object.freeze(['deliveryEvidenceEnabled', 'host', 'port', 'now']);
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Deadlines for reading a request; the handler bounds the body itself.
const TIMEOUTS = Object.freeze({ headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000, maxHeaderSize: 16384 });

function privateDirectory(path) {
  let stat;
  try { stat = lstatSync(path); } catch { stat = null; }
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || realpathSync(path) !== path) {
    throw new TypeError('dataDirectory must be an existing private (mode 0700) directory owned by this user, given as its absolute real path');
  }
}

// Resolves once the host listens: { url, listingPin, seller, timeouts,
// issueSessionChallenge({ jobId, buyer }), close() }.
export async function startSellerHost(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('seller host options must be an object');
  const unknown = Object.keys(options).filter((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key));
  if (unknown.length) throw new TypeError(`unknown seller host option: ${unknown.join(', ')}`);
  const missing = REQUIRED.filter((key) => options[key] == null);
  if (missing.length) throw new TypeError(`the seller host requires ${missing.join(', ')}`);
  const { signer, listing, dataDirectory, buyerAccess, agreementAnchor, artifactAnchor, deliverableProducer, observeDemosTransfer,
    nativePaymentEvidence, reconcilePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, deliveryEvidenceEnabled = false,
    host = '127.0.0.1', port = 0, now = () => Date.now() } = options;
  if (!LOOPBACK.has(host)) throw new TypeError('the seller host listens only on literal loopback (127.0.0.1 or ::1)');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) throw new TypeError('dataDirectory must be an absolute path');
  privateDirectory(dataDirectory);
  if (typeof observeDemosTransfer !== 'function' || typeof now !== 'function') throw new TypeError('observeDemosTransfer and now must be functions');
  // One live process owns the state for its lifetime (this one too, for a
  // second start); taken before anything is opened, released after all of it.
  const lock = await acquireSellerStateLock(dataDirectory);
  const opened = [() => lock.release()];
  const release = () => { for (const close of opened.splice(0).reverse()) { try { close(); } catch { /* keep releasing */ } } };
  try {
    const agent = await createSellerAgent({ signer, listing, observeDemosTransfer, now, durableDirectory: join(dataDirectory, 'seller'),
      agreementAnchor, nativeArtifactAnchor: artifactAnchor, deliverableProducer, buyerAccess, nativePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority, sessionAdmission, reconcilePaymentEvidence, deliveryEvidenceEnabled });
    opened.push(() => agent.close());
    const transport = join(dataDirectory, 'transport');
    mkdirSync(transport, { recursive: true, mode: 0o700 });
    const store = createSellerTransportStore({ path: join(transport, 'transport.sqlite'), now });
    opened.push(() => store.close());
    const authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store, now });
    const server = createServer({ maxHeaderSize: TIMEOUTS.maxHeaderSize }, createSellerHttpHandler(agent, { authentication }));
    Object.assign(server, { headersTimeout: TIMEOUTS.headersTimeout, requestTimeout: TIMEOUTS.requestTimeout, keepAliveTimeout: TIMEOUTS.keepAliveTimeout });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve(); });
    });
    let closing = null;
    // Stops accepting, lets requests in progress finish, then closes the
    // journal and the agent state they write to and releases the state lock.
    const close = () => closing ??= new Promise((resolve) => {
      server.close(() => { release(); resolve(); });
      server.closeIdleConnections();
    });
    return Object.freeze({
      url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
      listingPin: structuredClone(agent.listingPin),
      seller: agent.claim,
      timeouts: { ...TIMEOUTS },
      // CORE SN-1..SN-4: { jobId, buyer, sessionNonce, issuedAt, expiresAt },
      // kept durably before it is returned; the buyer's bundle presents it.
      issueSessionChallenge: (input) => agent.issueSessionChallenge(structuredClone(input)),
      close,
    });
  } catch (error) {
    release();
    throw error;
  }
}
