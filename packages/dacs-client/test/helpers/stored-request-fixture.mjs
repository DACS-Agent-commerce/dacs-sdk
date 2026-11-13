import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, purchase, JOB, PUBLIC_ENDPOINT, validReceipt } from './wire-client-fixture.mjs';
import { committedPurchase } from './wire-committed-purchase.mjs';
import { contextScope } from '../../../../test/kit-client/fixtures.mjs';
const { createSellerRequestRecords } = await import('../../src/dacs/protocol-purchases.mjs');
const { createSqlitePurchaseStore } = await import('../../src/seams/purchase-store-not-wired.mjs');
const { createSellerAgentClient } = await import('../../src/dacs/seller-http.mjs');

export const PATHS = wire.DACS_SELLER_HTTP_PATHS;
const READS = new Set([PATHS.state, PATHS.bundleBuyerCopy]);
/** Every client route whose exact body is stored (the two read routes keep no record). */
export const STORED_PATHS = Object.values(PATHS).filter(path => !READS.has(path));
export const errorCode = code => error => error.code === code;

/**
 * A purchase row with a retained Agreement plan, the real wire authentication and an in-process seller that
 * signs with the wire's `signWireResponse`. `advance` moves the purchase clock.
 */
export async function storedWorld(t, { stage = 'agreement-signing', accepted = true, status = 'agreement_pending', paid = false, configureTerms } = {}) {
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: PUBLIC_ENDPOINT });
  const w = await world(t, { pin: made.pin, agreementHash: made.agreementHash, readCommitmentReceipt: validReceipt });
  const p = await purchase(t, w, { status, paid, configureTerms, signedListing: paid ? made.listing : undefined, protocolPatch: { stage, ...(accepted ? { planned: { draft: made.agreement } } : {}), paymentEvidence: { retained: true } } });
  const bytes = value => Buffer.from(canonicalize(value));
  const auth = w.createSellerWireAuthentication({ ...w.options, evidence: async () => ({ commitment: bytes(made.anchored), agreement: bytes(made.agreement), signedListing: bytes(made.listing) }) });
  const { transaction } = createSqlitePurchaseStore();
  let current = p.get();
  const holder = { get: () => current, set: next => { current = next; } };
  const records = (target = holder, recordTransaction = transaction) => createSellerRequestRecords({ db: p.db, ops: p.ops, transaction: recordTransaction, holder: target, now: () => w.state.time });
  const fetches = [];
  const reply = async (init, status = 200, body = { status: 'complete' }) => {
    const { payload } = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
    const text = JSON.stringify(body);
    const header = await wire.signWireResponse(payload, status, text, { signer: w.seller, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, now: w.state.time });
    return new Response(text, { status, headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: header } });
  };
  const client = ({ respond = init => reply(init), requestRecords = records(), ...options } = {}) => createSellerAgentClient({
    url: PUBLIC_ENDPOINT, authentication: auth, requestRecords, commitOnSignature: true,
    fetchImpl: async (_url, init) => { fetches.push(init); return respond(init); }, ...options
  });
  const patch = (protocol = {}, nextStatus = p.get().status) => {
    const saved = p.get();
    return p.ops.transition(saved.id, saved.status, nextStatus, { state: { protocol: { ...saved.state.protocol, ...protocol, revision: (saved.state.protocol.revision ?? 0) + 1, progressGeneration: (saved.state.protocol.progressGeneration ?? saved.state.protocol.revision ?? 0) + 1 } }, event: 'test_progress', data: {} });
  };
  return { w, p, made, holder, records, client, auth, reply, fetches, patch,
    advance(ms) { w.state.time += ms; },
    restart() { p.reopen(); current = p.get(); },
    record(path) { return p.get().state.protocol.sellerRequests?.[path]; } };
}

/** A request body for each client route. */
export function bodyFor(path) {
  if (path === PATHS.state) return { transportIdentity: { jobId: JOB } };
  if ([PATHS.context, PATHS.contextChallenge].includes(path)) return { jobId: JOB, scope: structuredClone(contextScope) };
  if (path === PATHS.payments) return { jobId: JOB, txHash: 'a'.repeat(64), payerPayingKey: contextScope.buyer, nativePaymentEvidence: 'TEST-evidence' };
  if (path === PATHS.commitments) return { jobId: JOB, signedProjection: { hash: 'b'.repeat(64) } };
  if (path === PATHS.commitmentSignature) return { jobId: JOB, agreement: { jobId: JOB }, signedProjection: { hash: 'b'.repeat(64) } };
  if (path === PATHS.bundleCountersignature) return { jobId: JOB, buyerSignature: 'TEST-signature' };
  if (path === PATHS.proposals) return { jobId: JOB, transportIdentity: { jobId: JOB, agreementHash: 'c'.repeat(64) } };
  return { jobId: JOB };
}
export const nonce = init => JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url')).payload;
/** Every fetch carried the same body bytes and each carried its own nonce. */
export function sameBodies(fetches) {
  assert.ok(fetches.length > 0);
  assert.equal(new Set(fetches.map(init => init.body)).size, 1);
  assert.equal(new Set(fetches.map(init => nonce(init).nonce)).size, fetches.length);
}
