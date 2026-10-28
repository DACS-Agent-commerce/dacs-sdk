// The real seller agent, transport journal and HTTP handler on loopback, with
// no module hooks and no substituted verification: Listing, identity,
// transport and contribution signatures are checked by the package's modules.
// The agent keeps its sessions in memory here; the host test covers durable state.
// Negotiation reads and writes no substrate, so the agent runs on a fixture
// substrate that refuses every call: the native profile negotiates only with the
// operator's Vet context (seller-settlement-profile.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';

function key() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`, publicKey: pair.publicKey,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'roundtrip' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};

async function world(t) {
  const sellerKey = key(), buyerKey = key(), now = Date.now(), reached = [];
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Round trip seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'roundtrip-report', listingVersion: 1, title: 'Round trip report', description: 'Served over the authenticated seller transport.',
    category: 'services.market-report', tags: ['roundtrip'], priceDem: '1.25', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);
  const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached while negotiating`); };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-roundtrip-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signer = { claim: sellerKey.claim, sign: sellerKey.sign };
  let server, store;
  const start = async () => {
    const agent = await seller.createSellerAgent({ signer, listing, observeDemosTransfer: refuse('observeDemosTransfer'), buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true }),
      anchors: { read: refuse('anchors.read'), write: refuse('anchors.write') }, simulatedFixture: true });
    store = seller.createSellerTransportStore({ path: join(dir, 'transport.sqlite') });
    server = createServer(seller.createSellerHttpHandler(agent, { authentication: seller.createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store }) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await new Promise((resolve) => server.close(resolve)); store.close(); };
  t.after(() => server?.listening && stop());

  const jobId = core.generateCanonicalJobId(), buyerBundle = identityFor(buyerKey, now);
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now })));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const client = (url, listingPin = pin) => seller.createSellerAgentClient({ url, authentication: seller.createSellerTransportClientAuth({
    buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin, agreementHash: plan.agreementHash }) }) });
  const body = { proposal, transportIdentity, buyerIdentityBundle: buyerBundle };
  const verifier = ({ party, algorithm, value, signedBytes }) => {
    const publicKey = party === sellerKey.claim ? sellerKey.publicKey : party === buyerKey.claim ? buyerKey.publicKey : null;
    return algorithm === 'ed25519' && publicKey && verify(null, Buffer.from(signedBytes), publicKey, Buffer.from(value, 'base64url')) ? 'valid' : 'invalid';
  };
  return { start, stop, client, body, plan, pin, buyerContribution, transportIdentity, sellerKey, verifier, reached };
}
const refused = async (work) => { try { await work(); return null; } catch (error) { return { name: error.name, code: error.code, status: error.status }; } };

test('an authenticated buyer negotiates with the real seller agent; repeats and readback answer the same contribution', async (t) => {
  const w = await world(t), url = await w.start(), buyer = w.client(url);
  const first = await buyer.propose(w.body);
  assert.equal(first.disposition, 'complete');
  assert.deepEqual([first.contribution.role, first.contribution.party], ['seller', w.sellerKey.claim]);
  const agreement = await core.finalizeFixedPriceAgreementContributions(w.plan, [w.buyerContribution, first.contribution], w.verifier);
  assert.equal(core.contentHash(agreement), w.plan.agreementHash);
  assert.deepEqual(agreement.listingRef, w.pin);
  assert.deepEqual((await buyer.propose(w.body)).contribution, first.contribution);
  assert.deepEqual((await buyer.agreementState(w.transportIdentity)).contribution, first.contribution);
  assert.deepEqual(w.reached, []);
});

test('unauthenticated, mismatched and forged requests are refused with their own cause', async (t) => {
  const w = await world(t), url = await w.start();
  assert.deepEqual(await refused(() => w.client(url, { ...w.pin, contentHash: '0'.repeat(64) }).propose(w.body)), { name: 'SellerRefusedError', code: 'peer_listing_mismatch', status: 409 });
  const unsigned = await fetch(`${url}/dacs/v1/agreements/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(w.body) });
  assert.deepEqual([unsigned.status, await unsigned.json()], [401, { error: 'peer_envelope_invalid', message: 'peer_envelope_invalid' }]);
  // The bundle names the buyer but its presentation is signed by another key:
  // the transport admits it (same presenter), and the agent's own check refuses it.
  const other = key(), forged = structuredClone(w.body);
  forged.buyerIdentityBundle.presentation.signatures[0].signature = other.sign(Buffer.from(`dacs-bundle-presentation:v1:${core.identityBundleHash(forged.buyerIdentityBundle)}`)).toString('base64url');
  assert.deepEqual(await refused(() => w.client(url).propose(forged)), { name: 'SellerRefusedError', code: 'buyer_bundle_unauthenticated', status: 422 });
  assert.deepEqual(w.reached, []);
});

test('after a restart the journal answers a completed proposal again without running the agent', async (t) => {
  const w = await world(t);
  const first = await w.client(await w.start()).propose(w.body);
  await w.stop();
  // A fresh agent keeps no session; only the reopened journal knows the answer.
  const again = await w.client(await w.start()).propose(w.body);
  assert.deepEqual(again.contribution, first.contribution);
  assert.deepEqual(w.reached, []);
});
