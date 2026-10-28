// Offline world for the seller context route (DACS_SELLER_CONTEXT=route): the
// genuine context provider over an in-memory anchor, the seller HTTP handler
// with real transport authentication and journal on a private loopback
// listener, and the buyer route client behind the DEM delivery context
// capability. "Writes" are the anchor's publishes (the Vet CREATEs).
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureListing } from '../fixtures/listings.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { OFF_JOB, OFF_NOW, fixedWallet, memoryAnchor, offBuyerBundle, offOperation } from './seller-context-off-scenario.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { createDemDeliveryContext, resolveDemDeliveryBuyerContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createSellerContextClient, createSellerContextRecords, createSellerContextRoute } from '../../src/dacs/seller-context-route.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportClientAuth, createSellerTransportServerAuth, createSellerTransportStore, sellerContextScopeHash, sellerSessionDelegationSigningBytes } from '../../src/dacs/seller-transport-auth.mjs';
import { agreementContextScope } from '../../src/dacs/agreement-context-consumer.mjs';

export { OFF_JOB, OFF_NOW, fixedWallet, offBuyerBundle, offOperation };
export const CONTEXT_PATH = '/dacs/v1/agreements/context';
export const JOB_B = '01M4JQ7M7MX1HBNE8F21JPBFVD';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

// openBuyerAccess: delegated sessions are required, as the operator does.
// route: options for createSellerContextRoute (limits, knownJob, admitWrites,
// releaseWrites). Admission refusals are collected in w.refusals.
// answer(answer, input): what a dishonest seller returns instead (signed by it).
// agent: extra seller agent methods (for example reconcileTransport).
export async function contextRouteWorld(t, { openBuyerAccess = false, route: routeOptions = {}, wrapHandler = (handler) => handler, answer = (value) => value, agent = {} } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-context-route-')));
  const w = { directory, clock: OFF_NOW, performs: 0, openBuyerAccess, refusals: [] };
  w.now = () => w.clock;
  w.seller = fixedWallet('11'.repeat(32)); w.custody = fixedWallet('22'.repeat(32)); w.foreign = fixedWallet('33'.repeat(32));
  w.listing = fixtureListing(w.seller, { listingId: 'seller-context-scenario', price: '1', now: OFF_NOW });
  w.pin = listingPin(w.listing);
  w.buyerAccess = openBuyerAccess ? createOperatorBuyerAccess({ openBuyerAccess: true }) : createOperatorBuyerAccess({ custodyBuyer: w.custody.claim });
  w.anchor = memoryAnchor(w.seller.claim);
  w.sessions = new Map();
  const sellerSigner = { claim: w.seller.claim, sign: w.seller.signBytes };
  // The seller's durable context records, read only (as the operator wires them).
  w.records = createSellerContextRecords({ listing: w.listing, store: () => w.store });
  // The seller's party Vet store: it outlives a restart, as the operator's
  // seller-party-vet.sqlite does. w.onPartyVetUpdate(current, next) runs inside
  // each change; a throw there is a crash before that change was stored.
  const partyVet = createInMemoryPartyVetStore();
  w.partyVetStore = Object.freeze({ ...partyVet, update: (key, change) => partyVet.update(key, (current) => { const next = change(current); w.onPartyVetUpdate?.(current, next); return next; }) });
  w.start = async () => {
    w.provider = createDevnetDemoAgreementContextProvider({ anchor: w.anchor, wallet: { claim: w.seller.claim, signBytes: w.seller.signBytes }, listing: w.listing, store: w.partyVetStore, buyerAccess: w.buyerAccess,
      retainedScope: w.records.completedScope, now: w.now });
    w.route = createSellerContextRoute({ listing: w.listing, resolveBuyer: async (input, options) => { w.performs += 1; return answer(await w.provider.resolveBuyer(input, options), input); }, assertBuyerAccess: w.provider.assertBuyerAccess,
      recover: (input) => w.provider.recoverBuyer(input), logRefusal: (entry) => { w.refusals.push(entry); }, now: w.now, ...routeOptions });
    w.store = createSellerTransportStore({ path: join(directory, 'seller-transport.sqlite') });
    w.serverAuth = createSellerTransportServerAuth({ sellerSigner, listingPin: w.pin, store: w.store, requireDelegation: openBuyerAccess, now: w.now });
    w.agent = { claim: w.seller.claim, listingPin: w.pin, transportAgreementOf: () => null, ...agent };
    w.server = http.createServer(wrapHandler(createSellerHttpHandler(w.agent, { authentication: w.serverAuth, context: w.route })));
    w.url = `http://127.0.0.1:${await listen(w.server)}`;
  };
  // Restart: a new provider (its in-memory contexts are gone), the same
  // anchor (chain), party Vet store and transport journal file.
  w.restart = async () => { await close(w.server); w.store.close(); await w.start(); };
  t.after(async () => { if (w.server?.listening) await close(w.server); w.store?.close(); rmSync(directory, { recursive: true }); });
  await w.start();

  // A wallet-signed per-purchase session delegation, as the plugin keeps it.
  w.delegate = (buyer, jobId = OFF_JOB, { notBefore = w.clock - 1000, expiresAt = w.clock + 3_600_000 } = {}) => {
    const key = createEphemeralWallet();
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: key.publicKeyRaw.toString('hex'), seller: w.seller.claim, listingPin: w.pin, jobId, notBefore, expiresAt };
    const session = { key, delegation: { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') } };
    w.sessions.set(`${buyer.claim}:${jobId}`, session);
    return session;
  };
  // The buyer's transport authentication for one purchase: its own key (closed
  // access), or the delegated session key.
  w.authFor = (buyer, jobId, scopeHash, { delegated = openBuyerAccess } = {}) => {
    const resolveJob = (id) => { if (id !== jobId) throw new Error('TEST job differs'); return { listingPin: w.pin, agreementHash: scopeHash }; };
    if (!delegated) return createSellerTransportClientAuth({ buyerSigner: { claim: buyer.claim, sign: buyer.signBytes }, seller: w.seller.claim, resolveJob, now: w.now });
    const session = w.sessions.get(`${buyer.claim}:${jobId}`) ?? w.delegate(buyer, jobId);
    return createSellerTransportClientAuth({ sessionSigner: { claim: session.key.claim, sign: session.key.signBytes }, delegation: session.delegation, seller: w.seller.claim, resolveJob, now: w.now });
  };
  w.requests = [];
  w.routeClient = ({ delegated = openBuyerAccess, fetchImpl = globalThis.fetch } = {}) => createSellerContextClient({ clientFor: (operation, scopeHash) => {
    const buyer = [w.custody, w.foreign].find((wallet) => wallet.address === operation.terms.buyer.wallet) ?? w.extraBuyers?.get(operation.terms.buyer.wallet);
    return createSellerAgentClient({ url: w.url, authentication: w.authFor(buyer, operation.terms.protocol.jobId, scopeHash, { delegated }), timeoutMs: 15000,
      fetchImpl: async (url, options) => {
        const entry = { url, body: options.body, header: options.headers[SELLER_TRANSPORT_HEADER] };w.requests.push(entry);
        const response = await fetchImpl(url, options);entry.status = response.status;entry.text = await response.clone().text();return response;
      } });
  } });
  w.capability = (client = w.routeClient()) => createDemDeliveryContext({ authority: 'TEST-seller-context-route', resolveBuyer: client.resolveBuyer, resolveSeller: w.provider.resolveSeller, buyerOperation: true });
  // The purchase carries the context request it saved before its first send
  // (protocol-purchases.mjs sellerContextRequest); the route client sends only that.
  w.operation = ({ buyer = w.custody, jobId = OFF_JOB, generatedAt = OFF_NOW } = {}) => {
    const operation = offOperation({ listing: w.listing, buyer, jobId });
    operation.state.protocol.sellerContextRequest = { buyerBundle: offBuyerBundle(buyer), generatedAt };
    return operation;
  };
  w.resolve = ({ buyer = w.custody, jobId = OFF_JOB, generatedAt = OFF_NOW, capability = w.capability() } = {}) =>
    resolveDemDeliveryBuyerContext(capability, { operation: w.operation({ buyer, jobId, generatedAt }), listing: w.listing, buyerBundle: offBuyerBundle(buyer), generatedAt });
  // The exact request body the route client sends for this purchase, and the
  // scope hash its envelope carries.
  w.wire = ({ buyer = w.custody, jobId = OFF_JOB, generatedAt = OFF_NOW } = {}) => {
    const buyerIdentityBundle = offBuyerBundle(buyer);
    const { account, operation, ...scope } = agreementContextScope({ operation: offOperation({ listing: w.listing, buyer, jobId }), buyerBundle: buyerIdentityBundle, generatedAt });
    return { body: { scope, buyerIdentityBundle }, scopeHash: sellerContextScopeHash(scope) };
  };
  // A raw signed POST: auth.request signs `body` (its job) over `text`.
  w.raw = async (path, body, { auth, text = JSON.stringify(body), header } = {}) => {
    const signed = header === undefined && auth ? await auth.request(path, body, text) : null;
    const response = await fetch(`${w.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ?? signed?.header ? { [SELLER_TRANSPORT_HEADER]: header ?? signed.header } : {}) }, body: text });
    const answer = await response.text();
    return { status: response.status, text: answer, body: JSON.parse(answer), header: response.headers.get(SELLER_TRANSPORT_HEADER), signed };
  };
  w.journal = () => {
    const db = new DatabaseSync(join(directory, 'seller-transport.sqlite'), { readOnly: true });
    try { return Object.fromEntries(['peer_nonces', 'peer_effects', 'peer_slots', 'peer_jobs'].map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])); }
    finally { db.close(); }
  };
  w.writes = () => w.anchor.publishes.length;
  return w;
}
