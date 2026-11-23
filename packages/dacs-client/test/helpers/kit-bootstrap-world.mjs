// The client's public protocol factory, wire-authenticated through a declared seller transport, against the kit's composed seller
// host on loopback. The host's challenge route is the real one; the client clock and the kit fixture share the kit's NOW.
// Purchases are seeded as prepared rows; every request the client sends, and every answer it gets, is kept by path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { setPurchaseAdmission } from './wire-client-fixture.mjs';
import { withSeller } from './seller-stand-in.mjs';

// Everything that loads client source comes after the admission hook the fixture above installs.
const { openDatabase } = await import('./purchase-integrity-database.mjs');
const { createOperationStore } = await import('./purchase-integrity-operations.mjs');
await import('../../../dacs-seller/test/helpers/kit-guard-fixture.mjs');
const { contextHostFixture } = await import('../../../dacs-seller/test/helpers/host-context-client.mjs');
const { JOB, JOB2 } = await import('../../../dacs-seller/test/helpers/context-wire-world.mjs');
const { NOW, buyer, seller, testWallet } = await import('../../../dacs-seller/test/helpers/protocol-fixture.mjs');
const { TEST_CONNECTION, authorityReader } = await import('../../../dacs-seller/test/helpers/wire-authority-fixture.mjs');
const { FIXTURE_ENDPOINT } = await import('../../../dacs-seller/test/helpers/wire-buyer.mjs');
const { kitEndpointProof } = await import('./kit-endpoint-proof.mjs');
const { fetchAsHost } = await import('../../../dacs-seller/test/helpers/listener-host.mjs');
const { purchaseSupport } = await import('../../../dacs-seller/src/dacs/listing.mjs');
const { createSqlitePurchaseStore } = await import('../../src/seams/purchase-store-not-wired.mjs');
const { createSourceDemoSellerTransport } = await import('../../src/dacs/source-demo-seller-transport.mjs');
const { createProtocolPurchases } = await import('../../src/index.mjs');

export { JOB, JOB2, NOW, TEST_CONNECTION, buyer, seller };
export const CHALLENGE = wire.DACS_SELLER_HTTP_PATHS.contextChallenge;
// Shorter than one unknown-answer retry delay, so a lost answer is sent once per call and no test waits on the retry timer.
const SELLER_DEADLINE_MS = 4_000;
const DELEGATION_LIFETIME_MS = 1_800_000;
const PURCHASE_WINDOW_MS = 3_600_000;
const SESSION_KEY_TAG = 99;

/**
 * Starts the kit host and returns the world: `purchase(jobId)` seeds a prepared purchase, `sent(path)` the requests the client sent on
 * that path, `answers` the challenge answers it received (`{ text, header }`), `signs` the session key's signatures, and `clock.time` the client clock.
 * `intercept(path, init, forward)`, when set, answers a request instead of the host (`forward()` sends it on).
 */
export async function bootstrapWorld(t, { ready = true, delegationLifetimeMs = DELEGATION_LIFETIME_MS } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const f = await contextHostFixture(t);
  const host = await f.start();
  const binding = await wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority: authorityReader() });
  const admission = { binding, currentLocal: () => ({ ...TEST_CONNECTION }) };
  const proof = await kitEndpointProof({ binding, local: TEST_CONNECTION, listingPin: host.listingPin, ready, now: NOW });
  const session = testWallet(SESSION_KEY_TAG), signs = [];
  const sessionSigner = { claim: session.claim, sign(bytes) { signs.push(Buffer.from(bytes)); return session.signBytes(bytes); } };
  const world = { host, binding, signs, requests: [], answers: [], clock: { time: NOW }, intercept: null, policies: 0 };
  const transport = createSourceDemoSellerTransport({ authority: 'TEST-wire', sessionSignerFor: () => sessionSigner, endpointProofFor: () => proof,
    sessionPolicyFor: () => { world.policies++; return { expiresAt: world.clock.time + delegationLifetimeMs }; } });
  const forwardToHost = async (url, init) => {
    const response = await fetchAsHost()(url.replace(FIXTURE_ENDPOINT, host.url), init);
    if (new URL(url).pathname === CHALLENGE) world.answers.push({ text: await response.clone().text(), header: response.headers.get(wire.DACS_SELLER_HTTP_HEADER) });
    return response;
  };
  const fetchImpl = (url, init) => {
    const path = new URL(url).pathname;
    world.requests.push({ path, init });
    return world.intercept ? world.intercept(path, init, () => forwardToHost(url, init)) : forwardToHost(url, init);
  };
  const support = purchaseSupport(f.config.listing);
  const dir = mkdtempSync(join(tmpdir(), 'TEST-wire-bootstrap-')), file = join(dir, 'state.sqlite');
  const connections = [];
  /** One service over its own connection to the shared store, as a separate process would hold it. */
  const open = () => {
    const db = openDatabase(file);
    connections.push(db);
    const ops = createOperationStore({ db, handoffSecret: 'TEST-wire-bootstrap-'.repeat(3), now: () => world.clock.time });
    const service = withSeller(fetchImpl, () => createProtocolPurchases({ db, ops, admission, now: () => world.clock.time, store: createSqlitePurchaseStore(),
      coordinates: { unresolvedForSender: () => [] }, buyerAccess: { assertWallet() {} }, dacsProtocol: { sellerTransport: transport, sellerEndpoint: () => FIXTURE_ENDPOINT, sellerRequestTimeoutMs: SELLER_DEADLINE_MS } }));
    return { db, ops, service };
  };
  let current = open();
  t.after(() => {
    for (const db of connections) try { db.close(); } catch { /* already closed by a restart */ }
    rmSync(dir, { recursive: true, force: true });
  });
  current.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(NOW).toISOString());

  /** Seeds a prepared purchase for `jobId` (with `declared: false`, one whose terms name no seller transport). */
  world.purchase = (jobId = JOB, { declared = true } = {}) => {
    const terms = { buyer: { wallet: buyer.address }, seller: { claim: seller.claim, payee: support.payee }, listing: { ...host.listingPin }, price: { ...support.price }, rail: 'demos-native:DEM',
      protocol: { jobId, profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', sellerAgent: FIXTURE_ENDPOINT, wireProfile: binding.profile, ...(declared ? { sellerTransport: transport.declaration } : {}) } };
    const { operation } = current.ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: `TEST-${jobId}`, request: {}, status: 'agreement_pending', terms, termsHash: contentHash(terms),
      state: { protocol: { stage: 'identity', listing: f.config.listing, attempts: [] } }, expiresAt: new Date(NOW + PURCHASE_WINDOW_MS).toISOString() });
    return { id: operation.id, get: () => current.ops.get('TEST-buyer', operation.id) };
  };
  world.service = () => current.service;
  world.ops = () => current.ops;
  world.db = () => current.db;
  /** A restart: the connection closes and a new service opens over the same store. */
  world.restart = () => { current.db.close(); current = open(); };
  /** A second, independently constructed service sharing the store. */
  world.second = () => open().service;
  world.sent = (path) => world.requests.filter((request) => request.path === path);
  return world;
}

/** The buyer wallet's base64url signature over a wallet message. */
export const walletSign = (message) => buyer.signBytes(Buffer.from(message, 'utf8')).toString('base64url');

/** Runs the identity and delegation steps on `service` (default: the world's): `{ delegation, presentation }`, each the step's answer. */
export async function bootstrapThroughChallenge(world, purchase, service = world.service()) {
  const delegation = await service.identityRequest(purchase.get(), buyer.address);
  const presentation = await service.agreementDelegation(purchase.get(), walletSign(delegation.delegation.message));
  return { delegation, presentation };
}
