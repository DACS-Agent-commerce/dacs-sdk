// A payment answer that is not final is never cached as final. The real HTTP
// handler, SQLite transport journal and buyer/seller transport signatures; the
// agent is a counting facade that returns the seller agent's own transient
// answers (indeterminate before the evidence checkpoint, held after it, a
// delivery not done yet), then the delivered answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';

function key() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'payment-retry' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
const DELIVERED = { status: 'payment-evidenced', delivery: { status: 'delivered' } };

async function world(t, answers) {
  const sellerKey = key(), buyerKey = key(), now = Date.now();
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Retry seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'payment-retry', listingVersion: 1, title: 'Retry report', description: 'Payment retry vectors.', category: 'services.market-report', tags: ['retry'], priceDem: '2.5', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);
  const jobId = core.generateCanonicalJobId(), buyerBundle = identityFor(buyerKey, now);
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now })));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  const facade = { claim: sellerKey.claim, listingPin: pin,
    receiveProposal: async () => ({ disposition: 'complete', contribution: null }),
    submitPayment: async (body) => { calls.push(body.txHash); return structuredClone(answers[Math.min(calls.length - 1, answers.length - 1)]); } };
  const handle = seller.createSellerHttpHandler(facade, { authentication: seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store }) });
  const fetchImpl = async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl,
    authentication: seller.createSellerTransportClientAuth({ buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }) }) });
  await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
  const claim = { jobId, txHash: 'a1'.repeat(32), payerPayingKey: buyerKey.claim, nativePaymentEvidence: 'sdk-pay-dem-intake-native-evidence/loopback-v1' };
  const pay = async (body = claim) => { try { return await client.submitPayment(body); } catch (error) { return { error: error.code, status: error.status }; } };
  return { calls, claim, pay };
}

test('an indeterminate answer before the evidence checkpoint keeps nothing: the same claim reaches intake again and the delivery is then final', async (t) => {
  const w = await world(t, [{ status: 'indeterminate', reason: 'demos-pending' }, DELIVERED]);
  assert.deepEqual(await w.pay(), { status: 'indeterminate', reason: 'demos-pending' });
  assert.deepEqual(await w.pay(), DELIVERED, 'the transfer, now included, reaches payment intake');
  assert.deepEqual(await w.pay(), DELIVERED, 'the delivered answer is final');
  assert.equal(w.calls.length, 2);
  assert.deepEqual(await w.pay({ ...w.claim, txHash: `0x${w.claim.txHash}` }), { error: 'peer_operation_conflict', status: 409 }, 'a delivered job takes no other claim');
});

test('a corrected claim after an indeterminate answer is not a conflict: nothing was bound to the first body', async (t) => {
  const w = await world(t, [{ status: 'indeterminate', reason: 'demos-not-found' }, DELIVERED]);
  await w.pay({ ...w.claim, txHash: 'b2'.repeat(32) });
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.deepEqual(w.calls, ['b2'.repeat(32), w.claim.txHash]);
});

test('a held answer after the evidence checkpoint runs the agent again on a fresh nonce; another body still conflicts', async (t) => {
  const held = { status: 'held', reason: 'native-payment-evidence-not-anchored', readback: 'absent' };
  const w = await world(t, [held, held, DELIVERED]);
  assert.deepEqual(await w.pay(), held);
  assert.deepEqual(await w.pay({ ...w.claim, txHash: `0x${w.claim.txHash}` }), { error: 'peer_operation_conflict', status: 409 }, 'the held effect stays bound to its body');
  assert.deepEqual(await w.pay(), held, 'the readback is still absent');
  assert.deepEqual(await w.pay(), DELIVERED, 'the agent\'s retained work reads the anchor back and delivers');
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 3, 'the conflicting body and the final answer never reach the agent');
});

// Only a payment claim goes back to the retry from reconciliation: any other
// route's reconciliation with `retry` is refused before the journal is read.
test('the transport store hands an uncertain effect back to the retry only for a payment claim', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-store-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const jobId = core.generateCanonicalJobId(), reservation = { disposition: 'uncertain', effectKey: 'TEST-effect', owner: 'TEST-owner' };
  for (const path of ['/dacs/v1/commitments', '/dacs/v1/agreements/proposals', '/dacs/v1/commitments/signature', '/dacs/v1/bundles/buyer-copy']) {
    assert.throws(() => store.reconcile(reservation, { jobId, path }, 200, '{}', { retry: true }), { code: 'peer_reconciliation_invalid' }, path);
  }
  assert.throws(() => store.reconcile(reservation, { jobId, path: '/dacs/v1/payments' }, 200, '{}', { retry: true }), (error) => error.code !== 'peer_reconciliation_invalid',
    'a payment claim passes the guard and is checked against its retained effect');
});

test('evidenced payment with a delivery not done yet is retried until the delivery is final', async (t) => {
  const pending = [
    { status: 'payment-evidenced', delivery: { status: 'held', reason: 'delivery readback absent' } },
    { status: 'payment-evidenced', delivery: 'held-missing-consumed-v2-fulfilment-and-Vet-audit' },
    { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'held-readback-only' } },
  ];
  const w = await world(t, [...pending, DELIVERED]);
  for (const answer of pending) assert.deepEqual(await w.pay(), answer);
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 4);
});
